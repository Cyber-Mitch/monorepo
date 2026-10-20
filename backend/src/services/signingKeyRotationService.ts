/**
 * Signing Key Rotation Service
 * 
 * Implements a crash-safe, overlapping dual-key validity window for rotating signing keys.
 * 
 * State Machine:
 * 1. new_key_provisioned - New key generated and stored
 * 2. new_key_authorized_on_chain - New signer added to Stellar account (dual-key window starts)
 * 3. active_pointer_cutover - Atomic switch to use new key for signing
 * 4. old_key_deauthorized_on_chain - Old signer removed from Stellar account (dual-key window ends)
 * 5. old_key_destroyed - Old key material securely destroyed
 * 6. completed - Rotation complete
 * 7. failed - Rotation failed (with reason)
 * 
 * Key Guarantees:
 * - At least one valid signer at every instant (add-before-remove ordering)
 * - In-flight transactions signed with old key can still confirm during dual-key window
 * - Crash at any state resumes deterministically to a consistent point
 * - Active-key cutover is atomic
 * - Retired key material is securely destroyed and fully audit-logged
 */

import { Keypair, Operation, rpc, TransactionBuilder } from '@stellar/stellar-sdk'
import { getPool, type PgPoolLike } from '../db.js'
import { getSigningKeyMaterialStore } from '../models/signingKeyMaterialStore.js'
import { logger } from '../utils/logger.js'

export type RotationState =
  | 'new_key_provisioned'
  | 'new_key_authorized_on_chain'
  | 'active_pointer_cutover'
  | 'old_key_deauthorized_on_chain'
  | 'old_key_destroyed'
  | 'completed'
  | 'failed'

export type KeyType = 'admin' | 'custodial_wallet'

export interface RotationAuditEntry {
  timestamp: string
  event: string
  details: Record<string, unknown>
  actor?: string
}

export interface RotationConfig {
  keyType: KeyType
  accountAddress: string
  oldKeyId: string
  oldSecret: string
  initiatedBy: string
  rpcUrl: string
  networkPassphrase: string
}

export interface RotationResult {
  rotationId: string
  state: RotationState
  auditLog: RotationAuditEntry[]
}

export class SigningKeyRotationError extends Error {
  constructor(
    message: string,
    public readonly rotationId: string,
    public readonly currentState: RotationState
  ) {
    super(message)
    this.name = 'SigningKeyRotationError'
  }
}

export class ZeroSignerWindowError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZeroSignerWindowError'
  }
}

/**
 * Signing Key Rotation Service
 * Manages the state machine for rotating signing keys with dual-key validity
 */
export class SigningKeyRotationService {
  private readonly rpcServer: rpc.Server
  private readonly networkPassphrase: string

  constructor(rpcUrl: string, networkPassphrase: string) {
    this.rpcServer = new rpc.Server(rpcUrl)
    this.networkPassphrase = networkPassphrase
  }

  /**
   * Start a new key rotation
   * Creates the rotation record in state 'new_key_provisioned'
   */
  async startRotation(config: RotationConfig): Promise<RotationResult> {
    const pool = await this.getPool()

    // Check if there's an active rotation for this key type/account
    const existingRotation = await this.getActiveRotation(config.keyType, config.accountAddress)
    if (existingRotation) {
      throw new SigningKeyRotationError(
        `Active rotation already exists for ${config.keyType} at ${config.accountAddress}`,
        existingRotation.id,
        existingRotation.state as RotationState
      )
    }

    // Generate new key pair
    const newKeypair = Keypair.random()
    const newKeyId = this.generateKeyId()
    const newSecret = newKeypair.secret()

    // Store new key securely (in production, this would go to KMS)
    await this.storeKeyMaterial(newKeyId, newSecret, config.keyType)

    // Get current sequence number for coordination
    const account = await this.rpcServer.getAccount(config.accountAddress)
    const currentSequence = BigInt(account.sequenceNumber())

    // Create rotation record
    const { rows } = await pool.query(
      `INSERT INTO signing_key_rotations 
       (key_type, account_address, state, old_key_id, new_key_id, active_key_id, 
        sequence_at_rotation_start, initiated_by, audit_log)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, state, audit_log`,
      [
        config.keyType,
        config.accountAddress,
        'new_key_provisioned',
        config.oldKeyId,
        newKeyId,
        config.oldKeyId, // Still using old key initially
        currentSequence.toString(),
        config.initiatedBy,
        JSON.stringify([{
          timestamp: new Date().toISOString(),
          event: 'rotation_started',
          details: { keyType: config.keyType, accountAddress: config.accountAddress },
          actor: config.initiatedBy
        }]),
      ]
    )

    const rotation = rows[0]

    logger.info('Key rotation started', {
      rotationId: rotation.id,
      keyType: config.keyType,
      accountAddress: config.accountAddress,
      state: rotation.state,
    })

    return {
      rotationId: rotation.id,
      state: rotation.state as RotationState,
      auditLog: rotation.audit_log as RotationAuditEntry[],
    }
  }

  /**
   * Advance rotation to the next state
   * Each transition is idempotent and crash-safe
   */
  async advanceRotation(rotationId: string): Promise<RotationResult> {
    const pool = await this.getPool()

    // Get current rotation state
    const rotation = await this.getRotation(rotationId)
    if (!rotation) {
      throw new SigningKeyRotationError('Rotation not found', rotationId, 'failed')
    }

    if (rotation.state === 'completed' || rotation.state === 'failed') {
      throw new SigningKeyRotationError(
        `Rotation is already ${rotation.state}`,
        rotationId,
        rotation.state as RotationState
      )
    }

    // State machine transitions
    switch (rotation.state) {
      case 'new_key_provisioned':
        return await this.transitionToNewKeyAuthorized(rotationId, rotation)
      case 'new_key_authorized_on_chain':
        return await this.transitionToActivePointerCutover(rotationId, rotation)
      case 'active_pointer_cutover':
        return await this.transitionToOldKeyDeauthorized(rotationId, rotation)
      case 'old_key_deauthorized_on_chain':
        return await this.transitionToOldKeyDestroyed(rotationId, rotation)
      case 'old_key_destroyed':
        return await this.transitionToCompleted(rotationId, rotation)
      default:
        throw new SigningKeyRotationError(
          `Unknown rotation state: ${rotation.state}`,
          rotationId,
          rotation.state as RotationState
        )
    }
  }

  /**
   * Transition: new_key_provisioned → new_key_authorized_on_chain
   * Add new signer to Stellar account (dual-key window starts)
   */
  private async transitionToNewKeyAuthorized(
    rotationId: string,
    rotation: {
      id: string
      key_type: string
      account_address: string
      old_key_id: string
      new_key_id: string
      audit_log: RotationAuditEntry[]
    }
  ): Promise<RotationResult> {
    const pool = await this.getPool()

    // Get new key public key
    const newSecret = await this.retrieveKeyMaterial(rotation.new_key_id, rotation.key_type as KeyType)
    const newKeypair = Keypair.fromSecret(newSecret)
    const newPublicKey = newKeypair.publicKey()

    // Get old key for signing the add signer transaction
    const oldSecret = await this.retrieveKeyMaterial(rotation.old_key_id, rotation.key_type as KeyType)
    const oldKeypair = Keypair.fromSecret(oldSecret)

    // Verify we have at least one valid signer before adding new
    const currentSigners = await this.getCurrentSigners(rotation.account_address)
    if (currentSigners.length === 0) {
      throw new ZeroSignerWindowError(
        'Cannot add new signer: account has zero valid signers'
      )
    }

    try {
      // Add new signer to account
      await this.addSignerToAccount(
        rotation.account_address,
        newPublicKey,
        oldKeypair
      )

      // Record signer addition in valid_signers table
      await pool.query(
        `INSERT INTO signing_key_valid_signers 
         (account_address, key_id, signer_public_key, added_at, is_active)
         VALUES ($1, $2, $3, NOW(), true)
         ON CONFLICT (account_address, key_id) DO UPDATE SET
           signer_public_key = EXCLUDED.signer_public_key,
           added_at = EXCLUDED.added_at,
           is_active = true`,
        [rotation.account_address, rotation.new_key_id, newPublicKey]
      )

      // Update rotation state
      const auditLog = this.addAuditEntry(rotation.audit_log, 'new_key_authorized_on_chain', {
        newPublicKey,
        signerAddedAt: new Date().toISOString(),
      })

      const { rows } = await pool.query(
        `UPDATE signing_key_rotations
         SET state = 'new_key_authorized_on_chain',
             new_signer_added_at = NOW(),
             audit_log = $2,
             updated_at = NOW()
         WHERE id = $1
         RETURNING id, state, audit_log`,
        [rotationId, JSON.stringify(auditLog)]
      )

      logger.info('Rotation advanced to new_key_authorized_on_chain', {
        rotationId,
        newPublicKey,
      })

      return {
        rotationId: rows[0].id,
        state: rows[0].state as RotationState,
        auditLog: rows[0].audit_log as RotationAuditEntry[],
      }
    } catch (error) {
      await this.failRotation(rotationId, rotation, error as Error, 'new_key_authorized_on_chain')
      throw error
    }
  }

  /**
   * Transition: new_key_authorized_on_chain → active_pointer_cutover
   * Atomic switch to use new key for signing
   */
  private async transitionToActivePointerCutover(
    rotationId: string,
    rotation: {
      id: string
      key_type: string
      account_address: string
      old_key_id: string
      new_key_id: string
      active_key_id: string
      audit_log: RotationAuditEntry[]
    }
  ): Promise<RotationResult> {
    const pool = await this.getPool()

    // Verify dual-key window is active (both signers valid)
    const activeSigners = await this.getActiveSigners(rotation.account_address)
    if (activeSigners.length < 2) {
      throw new ZeroSignerWindowError(
        'Cannot cut over: dual-key window not active (less than 2 valid signers)'
      )
    }

    try {
      // Atomic update of active_key_id
      const auditLog = this.addAuditEntry(rotation.audit_log, 'active_pointer_cutover', {
        previousActiveKeyId: rotation.active_key_id,
        newActiveKeyId: rotation.new_key_id,
        cutoverAt: new Date().toISOString(),
      })

      const { rows } = await pool.query(
        `UPDATE signing_key_rotations
         SET state = 'active_pointer_cutover',
             active_key_id = new_key_id,
             active_key_cutover_at = NOW(),
             audit_log = $2,
             updated_at = NOW()
         WHERE id = $1
         RETURNING id, state, audit_log`,
        [rotationId, JSON.stringify(auditLog)]
      )

      logger.info('Rotation advanced to active_pointer_cutover', {
        rotationId,
        newActiveKeyId: rotation.new_key_id,
      })

      return {
        rotationId: rows[0].id,
        state: rows[0].state as RotationState,
        auditLog: rows[0].audit_log as RotationAuditEntry[],
      }
    } catch (error) {
      await this.failRotation(rotationId, rotation, error as Error, 'active_pointer_cutover')
      throw error
    }
  }

  /**
   * Transition: active_pointer_cutover → old_key_deauthorized_on_chain
   * Remove old signer from Stellar account (dual-key window ends)
   */
  private async transitionToOldKeyDeauthorized(
    rotationId: string,
    rotation: {
      id: string
      key_type: string
      account_address: string
      old_key_id: string
      new_key_id: string
      audit_log: RotationAuditEntry[]
    }
  ): Promise<RotationResult> {
    const pool = await this.getPool()

    // Get old key public key
    const oldSecret = await this.retrieveKeyMaterial(rotation.old_key_id, rotation.key_type as KeyType)
    const oldKeypair = Keypair.fromSecret(oldSecret)
    const oldPublicKey = oldKeypair.publicKey()

    // Get new key for signing the remove signer transaction
    const newSecret = await this.retrieveKeyMaterial(rotation.new_key_id, rotation.key_type as KeyType)
    const newKeypair = Keypair.fromSecret(newSecret)

    // Verify we have at least 2 valid signers before removing old
    const activeSigners = await this.getActiveSigners(rotation.account_address)
    if (activeSigners.length < 2) {
      throw new ZeroSignerWindowError(
        'Cannot remove old signer: would result in zero valid signers'
      )
    }

    try {
      // Remove old signer from account
      await this.removeSignerFromAccount(
        rotation.account_address,
        oldPublicKey,
        newKeypair
      )

      // Mark old signer as removed in valid_signers table
      await pool.query(
        `UPDATE signing_key_valid_signers
         SET removed_at = NOW(), is_active = false
         WHERE account_address = $1 AND key_id = $2`,
        [rotation.account_address, rotation.old_key_id]
      )

      // Update rotation state
      const auditLog = this.addAuditEntry(rotation.audit_log, 'old_key_deauthorized_on_chain', {
        oldPublicKey,
        signerRemovedAt: new Date().toISOString(),
      })

      const { rows } = await pool.query(
        `UPDATE signing_key_rotations
         SET state = 'old_key_deauthorized_on_chain',
             old_signer_removed_at = NOW(),
             audit_log = $2,
             updated_at = NOW()
         WHERE id = $1
         RETURNING id, state, audit_log`,
        [rotationId, JSON.stringify(auditLog)]
      )

      logger.info('Rotation advanced to old_key_deauthorized_on_chain', {
        rotationId,
        oldPublicKey,
      })

      return {
        rotationId: rows[0].id,
        state: rows[0].state as RotationState,
        auditLog: rows[0].audit_log as RotationAuditEntry[],
      }
    } catch (error) {
      await this.failRotation(rotationId, rotation, error as Error, 'old_key_deauthorized_on_chain')
      throw error
    }
  }

  /**
   * Transition: old_key_deauthorized_on_chain → old_key_destroyed
   * Securely destroy old key material
   */
  private async transitionToOldKeyDestroyed(
    rotationId: string,
    rotation: {
      id: string
      key_type: string
      old_key_id: string
      audit_log: RotationAuditEntry[]
    }
  ): Promise<RotationResult> {
    const pool = await this.getPool()

    try {
      // Securely destroy old key material
      await this.destroyKeyMaterial(rotation.old_key_id, rotation.key_type as KeyType)

      // Update rotation state
      const auditLog = this.addAuditEntry(rotation.audit_log, 'old_key_destroyed', {
        destroyedKeyId: rotation.old_key_id,
        destroyedAt: new Date().toISOString(),
      })

      const { rows } = await pool.query(
        `UPDATE signing_key_rotations
         SET state = 'old_key_destroyed',
             audit_log = $2,
             updated_at = NOW()
         WHERE id = $1
         RETURNING id, state, audit_log`,
        [rotationId, JSON.stringify(auditLog)]
      )

      logger.info('Rotation advanced to old_key_destroyed', {
        rotationId,
        destroyedKeyId: rotation.old_key_id,
      })

      return {
        rotationId: rows[0].id,
        state: rows[0].state as RotationState,
        auditLog: rows[0].audit_log as RotationAuditEntry[],
      }
    } catch (error) {
      await this.failRotation(rotationId, rotation, error as Error, 'old_key_destroyed')
      throw error
    }
  }

  /**
   * Transition: old_key_destroyed → completed
   * Mark rotation as complete
   */
  private async transitionToCompleted(
    rotationId: string,
    rotation: {
      id: string
      audit_log: RotationAuditEntry[]
    }
  ): Promise<RotationResult> {
    const pool = await this.getPool()

    const auditLog = this.addAuditEntry(rotation.audit_log, 'completed', {
      completedAt: new Date().toISOString(),
    })

    const { rows } = await pool.query(
      `UPDATE signing_key_rotations
       SET state = 'completed',
           completed_at = NOW(),
           audit_log = $2,
           updated_at = NOW()
       WHERE id = $1
       RETURNING id, state, audit_log`,
      [rotationId, JSON.stringify(auditLog)]
    )

    logger.info('Rotation completed', {
      rotationId,
    })

    return {
      rotationId: rows[0].id,
      state: rows[0].state as RotationState,
      auditLog: rows[0].audit_log as RotationAuditEntry[],
    }
  }

  /**
   * Mark rotation as failed with reason
   */
  private async failRotation(
    rotationId: string,
    rotation: {
      audit_log: RotationAuditEntry[]
    },
    error: Error,
    failedAtState: string
  ): Promise<void> {
    const pool = await this.getPool()

    const auditLog = this.addAuditEntry(rotation.audit_log, 'failed', {
      failedAtState,
      reason: error.message,
      failedAt: new Date().toISOString(),
    })

    await pool.query(
      `UPDATE signing_key_rotations
       SET state = 'failed',
           failure_reason = $2,
           audit_log = $3,
           updated_at = NOW()
       WHERE id = $1`,
      [rotationId, error.message, JSON.stringify(auditLog)]
    )

    logger.error('Rotation failed', {
      rotationId,
      state: failedAtState,
      error: error.message,
    })
  }

  /**
   * Get current rotation for a key type/account
   */
  async getActiveRotation(keyType: KeyType, accountAddress: string): Promise<{
    id: string
    state: string
    key_type: string
    account_address: string
    old_key_id: string
    new_key_id: string
    active_key_id: string
    audit_log: RotationAuditEntry[]
    initiated_at: Date
  } | null> {
    const pool = await this.getPool()

    const { rows } = await pool.query(
      `SELECT id, state, key_type, account_address, old_key_id, new_key_id,
              active_key_id, audit_log, initiated_at
       FROM signing_key_rotations
       WHERE key_type = $1 AND account_address = $2
         AND state NOT IN ('completed', 'failed')
       ORDER BY initiated_at DESC
       LIMIT 1`,
      [keyType, accountAddress]
    )

    return rows.length > 0 ? rows[0] : null
  }

  /**
   * Get rotation by ID
   */
  async getRotation(rotationId: string): Promise<{
    id: string
    state: string
    key_type: string
    account_address: string
    old_key_id: string
    new_key_id: string
    active_key_id: string
    audit_log: RotationAuditEntry[]
    initiated_at: Date
  } | null> {
    const pool = await this.getPool()

    const { rows } = await pool.query(
      `SELECT * FROM signing_key_rotations WHERE id = $1`,
      [rotationId]
    )

    return rows.length > 0 ? rows[0] : null
  }

  /**
   * Resume a rotation after a crash
   * Returns the current state and allows continuation
   */
  async resumeRotation(rotationId: string): Promise<RotationResult> {
    const rotation = await this.getRotation(rotationId)
    if (!rotation) {
      throw new SigningKeyRotationError('Rotation not found', rotationId, 'failed')
    }

    logger.info('Resuming rotation after crash/restart', {
      rotationId,
      currentState: rotation.state,
    })

    return {
      rotationId: rotation.id,
      state: rotation.state as RotationState,
      auditLog: rotation.audit_log as RotationAuditEntry[],
    }
  }

  /**
   * Get the currently active key for signing
   * This is the atomic pointer that determines which key to use
   */
  async getActiveKey(keyType: KeyType, accountAddress: string): Promise<string | null> {
    const pool = await this.getPool()

    const { rows } = await pool.query(
      `SELECT active_key_id
       FROM signing_key_rotations
       WHERE key_type = $1 AND account_address = $2
         AND state NOT IN ('completed', 'failed')
       ORDER BY initiated_at DESC
       LIMIT 1`,
      [keyType, accountAddress]
    )

    if (rows.length === 0) {
      return null
    }

    return rows[0].active_key_id
  }

  /**
   * Get all active signers for an account
   * Used to verify zero-signer-window prevention
   */
  async getActiveSigners(accountAddress: string): Promise<Array<{ keyId: string; publicKey: string }>> {
    const pool = await this.getPool()

    const { rows } = await pool.query(
      `SELECT key_id, signer_public_key
       FROM signing_key_valid_signers
       WHERE account_address = $1 AND is_active = true`,
      [accountAddress]
    )

    return rows.map((row: any) => ({
      keyId: row.key_id,
      publicKey: row.signer_public_key,
    }))
  }

  /**
   * Add a signer to a Stellar account
   */
  private async addSignerToAccount(
    accountAddress: string,
    newPublicKey: string,
    signingKeypair: Keypair
  ): Promise<void> {
    const account = await this.rpcServer.getAccount(accountAddress)

    const tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.setOptions({
          signer: {
            ed25519PublicKey: newPublicKey,
            weight: 1,
          },
        })
      )
      .setTimeout(30)
      .build()

    tx.sign(signingKeypair)

    const response = await this.rpcServer.sendTransaction(tx)

    if (response.status !== 'PENDING') {
      throw new Error(`Failed to add signer: ${response.status}`)
    }

    // Wait for confirmation
    await this.waitForTransaction(response.hash)
  }

  /**
   * Remove a signer from a Stellar account
   */
  private async removeSignerFromAccount(
    accountAddress: string,
    oldPublicKey: string,
    signingKeypair: Keypair
  ): Promise<void> {
    const account = await this.rpcServer.getAccount(accountAddress)

    const tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.setOptions({
          signer: {
            ed25519PublicKey: oldPublicKey,
            weight: 0,
          },
        })
      )
      .setTimeout(30)
      .build()

    tx.sign(signingKeypair)

    const response = await this.rpcServer.sendTransaction(tx)

    if (response.status !== 'PENDING') {
      throw new Error(`Failed to remove signer: ${response.status}`)
    }

    // Wait for confirmation
    await this.waitForTransaction(response.hash)
  }

  /**
   * Get current signers from database (crash-safe source of truth)
   */
  private async getCurrentSigners(accountAddress: string): Promise<string[]> {
    const pool = await this.getPool()

    const { rows } = await pool.query(
      `SELECT public_key FROM signing_key_valid_signers
       WHERE account_address = $1 AND is_valid = true
       ORDER BY added_at ASC`,
      [accountAddress]
    )

    return rows.map((r: any) => r.public_key)
  }

  /**
   * Wait for transaction confirmation
   */
  private async waitForTransaction(
    txHash: string,
    maxAttempts: number = 30,
    pollIntervalMs: number = 1000
  ): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, pollIntervalMs))

      try {
        const result = await this.rpcServer.getTransaction(txHash)

        if (result.status === 'SUCCESS') {
          return
        }
        if (result.status === 'FAILED') {
          throw new Error(`Transaction failed: ${result.status}`)
        }
      } catch (err) {
        if (this.isTransientRpcError(err)) {
          continue
        }
        throw err
      }
    }

    throw new Error('Transaction not confirmed within timeout')
  }

  /**
   * Check if an RPC error is transient
   */
  private isTransientRpcError(err: any): boolean {
    if (!err) return false
    const message = err.message?.toLowerCase() || ''
    return (
      message.includes('timeout') ||
      message.includes('network') ||
      message.includes('connection')
    )
  }

  /**
   * Store key material in the configured KeyMaterialStore. The Postgres store
   * encrypts it at rest, so it survives a restart and is shared across instances.
   */
  private async storeKeyMaterial(keyId: string, secret: string, keyType: KeyType): Promise<void> {
    await getSigningKeyMaterialStore().put(keyId, keyType, secret)
  }

  /**
   * Retrieve key material (public for integration with signing services)
   */
  async retrieveKeyMaterial(keyId: string, keyType: KeyType): Promise<string> {
    const secret = await getSigningKeyMaterialStore().get(keyId, keyType)

    if (!secret) {
      throw new Error(`Key material not found: ${keyId}`)
    }

    return secret
  }

  /**
   * Destroy key material. The store zeroes the secret and keeps a tombstone row.
   */
  private async destroyKeyMaterial(keyId: string, keyType: KeyType): Promise<void> {
    await getSigningKeyMaterialStore().destroy(keyId, keyType)
  }

  /**
   * Generate a unique key ID
   */
  private generateKeyId(): string {
    return `key_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`
  }

  /**
   * Add an entry to the audit log
   */
  private addAuditEntry(
    auditLog: RotationAuditEntry[],
    event: string,
    details: Record<string, unknown>
  ): RotationAuditEntry[] {
    return [
      ...auditLog,
      {
        timestamp: new Date().toISOString(),
        event,
        details,
      },
    ]
  }

  /**
   * Get the database pool
   */
  private async getPool(): Promise<PgPoolLike> {
    const pool = await getPool()
    if (!pool) {
      throw new Error('Database pool is not available')
    }
    return pool
  }
}

// Global singleton instance
let globalRotationService: SigningKeyRotationService | null = null

/**
 * Get or create the global signing key rotation service instance
 */
export function getSigningKeyRotationService(): SigningKeyRotationService {
  if (!globalRotationService) {
    const rpcUrl = process.env.SOROBAN_RPC_URL || ''
    const networkPassphrase = process.env.SOROBAN_NETWORK_PASSPHRASE || 'Public Global Stellar Network ; September 2015'

    if (!rpcUrl) {
      throw new Error('SOROBAN_RPC_URL environment variable is required for signing key rotation service')
    }

    globalRotationService = new SigningKeyRotationService(rpcUrl, networkPassphrase)
  }

  return globalRotationService
}

/**
 * Reset the global rotation service (mainly for testing)
 */
export function resetSigningKeyRotationService(): void {
  globalRotationService = null
}
