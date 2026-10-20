/**
 * Multisig gate for privileged on-chain admin actions (#1972).
 *
 * With no multisig configured, a covered operation runs directly, signed by the
 * platform admin key, exactly as before. When `MULTISIG_ADMIN_ID` is set, the
 * same call is filed as a multisig proposal instead (the platform key must be a
 * registered signer): nothing executes until the contract's threshold of
 * signers have approved it with their own wallets and one of them executes it.
 *
 * Covered operations:
 *   - circuit-breaker drain: `propose_drain` and `execute_drain` on deal_escrow
 *   - contract-access role assignment: `propose_assign_role` on contract_access
 *
 * `freeze` is deliberately NOT covered: it is the emergency stop and must stay
 * immediate. Other admin operations are unchanged.
 *
 * The target contracts must treat the multisig contract as their admin for a
 * proposal to execute. For role assignment the admin argument of the call is
 * replaced with the multisig contract's address.
 */

import type { MultisigArg, SorobanAdapter } from '../soroban/adapter.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { logger } from '../utils/logger.js'

export const MULTISIG_COVERED_OPERATIONS = [
  'propose_drain',
  'execute_drain',
  'propose_assign_role',
] as const

export type MultisigCoveredOperation = (typeof MULTISIG_COVERED_OPERATIONS)[number]

export type GateResult =
  | { mode: 'direct'; txHash: string }
  | {
      mode: 'multisig'
      txHash: string
      proposalId?: number
      multisigContractId: string
      operation: MultisigCoveredOperation
    }

export interface CoveredCall {
  operation: MultisigCoveredOperation
  /** Which configured contract the call targets. */
  target: 'dealEscrow' | 'contractAccess'
  /** The contract function the proposal will call. */
  functionName: string
  /** Arguments of the proposed call. May use `multisigContractId` where the direct call passes the admin key. */
  args: (multisigContractId: string) => MultisigArg[]
  /** The direct, admin-signed call, used when no multisig is configured. */
  direct: () => Promise<string>
}

export function isMultisigEnabled(adapter: SorobanAdapter): boolean {
  return adapter.multisigEnabled?.() === true
}

export async function executeOrPropose(
  adapter: SorobanAdapter,
  call: CoveredCall,
): Promise<GateResult> {
  if (!isMultisigEnabled(adapter)) {
    return { mode: 'direct', txHash: await call.direct() }
  }

  const multisigContractId = adapter.multisigContractId?.()
  const target = adapter.multisigTargetFor?.(call.target)
  if (!adapter.multisigPropose || !multisigContractId) {
    throw new AppError(
      ErrorCode.NOT_IMPLEMENTED,
      501,
      'Multisig is enabled but the Soroban adapter cannot file proposals',
    )
  }
  if (!target) {
    throw new AppError(
      ErrorCode.INTERNAL_ERROR,
      503,
      `Multisig is enabled but the ${call.target} contract is not configured, so ${call.operation} cannot be proposed`,
    )
  }

  const { txHash, proposalId } = await adapter.multisigPropose(
    target,
    call.functionName,
    call.args(multisigContractId),
  )
  logger.info('Admin operation filed as a multisig proposal', {
    operation: call.operation,
    proposalId,
    txHash,
  })
  return { mode: 'multisig', txHash, proposalId, multisigContractId, operation: call.operation }
}

/** The extra fields routes add to their response when an operation became a proposal. */
export function describeGateResult(result: GateResult) {
  return result.mode === 'multisig'
    ? {
        multisig: {
          proposalId: result.proposalId ?? null,
          contractId: result.multisigContractId,
          status: 'pending',
          note: 'Not executed. Signers must approve this proposal and one must execute it.',
        },
      }
    : {}
}
