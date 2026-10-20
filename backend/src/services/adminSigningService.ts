import { Keypair, TransactionBuilder, Operation, xdr, Address, rpc, Account } from '@stellar/stellar-sdk'
import { logger } from '../utils/logger.js'
import { ConfigurationError, TransactionError } from '../soroban/errors.js'
import { getStellarSequenceAllocator, type AllocationResult } from './stellarSequenceAllocator.js'
import { getSigningKeyRotationService, type KeyType } from './signingKeyRotationService.js'

/**
 * Admin operations that require admin signing.
 * These operations have elevated privileges and should be carefully controlled.
 */
export type AdminOperation =
  | 'pause'
  | 'unpause'
  | 'set_operator'
  | 'init'
  | 'execute'
  | 'cancel'
  | 'activate_deal'
  | 'complete_deal'
  | 'default_deal'
  | 'stake_bond'
  | 'unstake_bond'
  | 'request_rent_release'
  | 'challenge_rent_release'
  | 'resolve_rent_dispute'
  | 'settle_rent_release_timeout'
  | 'settle_dispute_timeout'
  | 'register_deal'
  | 'record_equity_payment'
  | 'update_reputation'
  | 'stake'
  | 'unstake'
  | 'claim'
  | 'utilize_stake'
  | 'delegate'
  | 'request_undelegate'
  | 'complete_undelegate'
  | 'claim_delegatee_rewards'
  | 'set_commission'
  | 'claim_commission'
  | 'fund_epoch_rewards'
  | 'seal_epoch'
  | 'rent_wallet_credit'
  | 'rent_wallet_debit'
  // governance contract (issue #1494). Both are permissionless on-chain — the
  // contract functions take no Address and call no require_auth() — so the
  // admin key only pays the fee and submits; it authorizes nothing user-specific.
  | 'finalize_proposal'
  | 'execute_proposal'
  // vesting_schedule contract (#1911). Admin-funded schedules and revocation.
  | 'create_vesting_schedule'
  | 'revoke'
  // multisig_admin (#1972): the platform key, as a registered signer, files proposals for covered admin actions.
  | 'propose'

/**
 * Parameters for admin operations
 */
export interface AdminOperationParams {
  contractId: string
  operation: AdminOperation
  args: xdr.ScVal[]
  networkPassphrase: string
  adminSecret: string
  server: rpc.Server
  allocationId?: string // Optional allocation ID for idempotent retries
}

/**
 * Audit log entry for admin operations (no secrets included)
 */
export interface AdminOperationAuditLog {
  timestamp: string
  operation: AdminOperation
  contractId: string
  adminPublicKey: string
  transactionHash?: string
  success: boolean
  error?: string
}

/**
 * Service for handling admin-signed operations on Soroban contracts.
 * 
 * This service isolates admin signing behind a clear boundary and enforces:
 * - Feature flag check (SOROBAN_ADMIN_SIGNING_ENABLED)
 * - Audit logging for all operations
 * - Explicit operation whitelist
 * 
 * Best practices:
 * - Admin secrets should NOT be used in general request handlers
 * - Admin operations should be triggered by admin-only endpoints or background jobs
 * - All admin operations are logged for audit purposes
 */
export class AdminSigningService {
  private readonly enabled: boolean
  private readonly adminSecret?: string
  private readonly networkPassphrase: string
  private readonly server: rpc.Server
  private readonly keyType: KeyType = 'admin'

  constructor(config: {
    enabled: boolean
    adminSecret?: string
    networkPassphrase: string
    server: rpc.Server
  }) {
    this.enabled = config.enabled
    this.adminSecret = config.adminSecret
    this.networkPassphrase = config.networkPassphrase
    this.server = config.server
  }

  /**
   * Check if admin signing is enabled and configured
   */
  isEnabled(): boolean {
    return this.enabled && !!this.adminSecret
  }

  /**
   * Get the admin signing key, respecting rotation state
   * If a rotation is in progress, uses the active_key_id pointer
   */
  private async getSigningKey(accountAddress: string): Promise<{ secret: string; publicKey: string }> {
    // Check if there's an active rotation
    const rotationService = getSigningKeyRotationService()
    const activeKeyId = await rotationService.getActiveKey(this.keyType, accountAddress)

    if (activeKeyId) {
      // Rotation in progress - use the active key from rotation service
      const secret = await rotationService.retrieveKeyMaterial(activeKeyId, this.keyType)
      const keypair = Keypair.fromSecret(secret)
      return {
        secret,
        publicKey: keypair.publicKey(),
      }
    }

    // No rotation in progress - use the configured admin secret
    if (!this.adminSecret) {
      throw new ConfigurationError(
        'SOROBAN_ADMIN_SECRET not configured. Admin operations require admin secret key.'
      )
    }

    const keypair = Keypair.fromSecret(this.adminSecret)
    return {
      secret: this.adminSecret,
      publicKey: keypair.publicKey(),
    }
  }

  /**
   * Execute an admin operation with proper checks and audit logging
   */
  async executeAdminOperation(params: AdminOperationParams): Promise<string> {
    // Check feature flag
    if (!this.enabled) {
      throw new ConfigurationError(
        'Admin signing is disabled. Set SOROBAN_ADMIN_SIGNING_ENABLED=true to enable.'
      )
    }

    if (!this.adminSecret) {
      throw new ConfigurationError(
        'SOROBAN_ADMIN_SECRET not configured. Admin operations require admin secret key.'
      )
    }

    // Validate operation is in whitelist
    const allowedOperations: AdminOperation[] = [
      'pause',
      'unpause',
      'set_operator',
      'init',
      'execute',
      'cancel',
      'activate_deal',
      'complete_deal',
      'default_deal',
      'stake_bond',
      'unstake_bond',
      'request_rent_release',
      'challenge_rent_release',
      'resolve_rent_dispute',
      'settle_rent_release_timeout',
      'settle_dispute_timeout',
      'register_deal',
      'record_equity_payment',
      'stake',
      'unstake',
      'claim',
      'utilize_stake',
      'delegate',
      'request_undelegate',
      'complete_undelegate',
      'claim_delegatee_rewards',
      'set_commission',
      'claim_commission',
      'finalize_proposal',
      'execute_proposal',
      'create_vesting_schedule',
      'revoke',
      'fund_epoch_rewards',
      'seal_epoch',
      'propose',
    ]
    if (!allowedOperations.includes(params.operation)) {
      throw new ConfigurationError(
        `Operation "${params.operation}" is not in the admin operations whitelist. ` +
        `Allowed operations: ${allowedOperations.join(', ')}`
      )
    }

    // Load admin keypair (respecting rotation state)
    let adminKeypair: Keypair
    let adminPublicKey: string
    try {
      const signingKey = await this.getSigningKey(params.contractId)
      adminKeypair = Keypair.fromSecret(signingKey.secret)
      adminPublicKey = signingKey.publicKey
    } catch (err) {
      throw new ConfigurationError('Invalid admin secret key configured')
    }

    // Audit log: operation initiated (no secrets)
    this.logAdminOperation({
      timestamp: new Date().toISOString(),
      operation: params.operation,
      contractId: params.contractId,
      adminPublicKey,
      success: false, // Will be updated on success
    })

    let allocation: AllocationResult | null = null

    try {
      // Allocate sequence number using the sequence allocator
      const allocator = getStellarSequenceAllocator()
      allocation = await allocator.allocateSequence(adminPublicKey, params.allocationId)

      // Get the admin's account info from the network (for other account data)
      const accountResponse = await this.server.getAccount(adminPublicKey)

      // Build the transaction with the allocated sequence number
      const account = new Account(adminPublicKey, allocation.sequence.toString())
      const tx = new TransactionBuilder(
        account,
        {
          fee: '100', // BASE_FEE as string
          networkPassphrase: this.networkPassphrase,
        }
      )
      .addOperation(
        Operation.invokeHostFunction({
          func: xdr.HostFunction.hostFunctionTypeInvokeContract(
            new xdr.InvokeContractArgs({
              contractAddress: Address.fromString(params.contractId).toScAddress(),
              functionName: params.operation,
              args: params.args,
            })
          ),
          auth: [],
        })
      )
      .setTimeout(30)
      .build()

      // Sign the transaction
      tx.sign(adminKeypair)

      // Submit the transaction
      const response = await this.server.sendTransaction(tx)

      if (response.status !== 'PENDING') {
        const errorResult = response as any
        const resultXdr = errorResult.errorResultXdr

        // Mark allocation as failed
        if (allocation) {
          await allocator.markFailed(allocation.allocationId)
        }

        // Audit log: operation failed
        this.logAdminOperation({
          timestamp: new Date().toISOString(),
          operation: params.operation,
          contractId: params.contractId,
          adminPublicKey,
          transactionHash: response.hash,
          success: false,
          error: `Transaction failed with status: ${response.status}`,
        })

        throw new TransactionError(
          `Admin operation ${params.operation} failed with status: ${response.status}`,
          response.hash,
          params.operation
        )
      }

      // Wait for transaction confirmation
      const confirmedTx = await this.waitForTransaction(response.hash)

      if (!confirmedTx) {
        // Mark allocation as failed
        if (allocation) {
          await allocator.markFailed(allocation.allocationId)
        }

        // Audit log: timeout
        this.logAdminOperation({
          timestamp: new Date().toISOString(),
          operation: params.operation,
          contractId: params.contractId,
          adminPublicKey,
          transactionHash: response.hash,
          success: false,
          error: 'Transaction not confirmed within timeout',
        })

        throw new TransactionError(
          `Admin operation ${params.operation} not confirmed within timeout`,
          response.hash,
          params.operation
        )
      }

      if (confirmedTx.status === 'SUCCESS') {
        // Mark allocation as confirmed
        if (allocation) {
          await allocator.markConfirmed(allocation.allocationId, response.hash)
        }

        // Audit log: operation succeeded
        this.logAdminOperation({
          timestamp: new Date().toISOString(),
          operation: params.operation,
          contractId: params.contractId,
          adminPublicKey,
          transactionHash: response.hash,
          success: true,
        })

        return response.hash
      } else {
        // Mark allocation as failed
        if (allocation) {
          await allocator.markFailed(allocation.allocationId)
        }

        // Audit log: operation failed
        this.logAdminOperation({
          timestamp: new Date().toISOString(),
          operation: params.operation,
          contractId: params.contractId,
          adminPublicKey,
          transactionHash: response.hash,
          success: false,
          error: `Transaction failed: ${confirmedTx.status}`,
        })

        throw new TransactionError(
          `Admin operation ${params.operation} failed: ${confirmedTx.status}`,
          response.hash,
          params.operation
        )
      }
    } catch (err) {
      // Mark allocation as failed on error
      if (allocation) {
        try {
          const allocator = getStellarSequenceAllocator()
          await allocator.markFailed(allocation.allocationId)
        } catch (markErr) {
          // Log but don't throw - the original error is more important
          logger.error('Failed to mark allocation as failed', {
            allocationId: allocation.allocationId,
            error: markErr instanceof Error ? markErr.message : String(markErr),
          })
        }
      }

      // Audit log: operation error
      this.logAdminOperation({
        timestamp: new Date().toISOString(),
        operation: params.operation,
        contractId: params.contractId,
        adminPublicKey,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      })

      // Re-throw known errors
      if (err instanceof ConfigurationError || err instanceof TransactionError) {
        throw err
      }

      // Wrap unknown errors
      throw new TransactionError(
        `Admin operation ${params.operation} failed`,
        undefined,
        params.operation,
        err
      )
    }
  }

  /**
   * Wait for a transaction to be confirmed
   */
  private async waitForTransaction(
    txHash: string,
    maxAttempts: number = 30,
    pollIntervalMs: number = 1000
  ): Promise<{ status: string } | null> {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, pollIntervalMs))

      try {
        const result = await this.server.getTransaction(txHash)

        if (result.status === 'SUCCESS' || result.status === 'FAILED') {
          return { status: result.status }
        }
        // Status is still PENDING, continue polling
      } catch (err) {
        // If transient error, continue polling
        if (this.isTransientRpcError(err)) {
          continue
        }
        throw err
      }
    }

    return null // Timeout
  }

  /**
   * Check if an RPC error is transient and should be retried
   */
  private isTransientRpcError(err: any): boolean {
    if (!err) return false
    const message = err.message?.toLowerCase() || ''
    return (
      message.includes('timeout') ||
      message.includes('network') ||
      message.includes('connection') ||
      message.includes('econnrefused') ||
      message.includes('econnreset')
    )
  }

  /**
   * Log admin operation for audit purposes (no secrets)
   */
  private logAdminOperation(log: AdminOperationAuditLog): void {
    logger.info('Admin operation executed', {
      timestamp: log.timestamp,
      operation: log.operation,
      contractId: log.contractId,
      adminPublicKey: log.adminPublicKey,
      transactionHash: log.transactionHash,
      success: log.success,
      error: log.error,
    })
  }
}
