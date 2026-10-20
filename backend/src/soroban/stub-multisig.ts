/**
 * In-memory multisig_admin contract for the stub adapter (#1972).
 *
 * Mirrors contracts/multisig_admin: only signers may propose, approve, revoke
 * and execute; a proposal is pending until executed, cancelled or expired;
 * approvals are unique per signer; execute needs `threshold` approvals.
 */

import type {
  MultisigArg,
  MultisigConfig,
  MultisigProposal,
  MultisigProposalStatus,
} from './adapter.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'

/** Proposal lifetime, as in the contract (7 days). */
const PROPOSAL_TTL_SECS = 604_800

const nowSecs = () => Math.floor(Date.now() / 1000)

const fail = (message: string, status = 400) => new AppError(ErrorCode.VALIDATION_ERROR, status, message)

/** What an executed proposal asked the target contract to do; the stub only records it. */
export interface StubExecutedCall {
  proposalId: number
  target: string
  functionName: string
  args: MultisigArg[]
}

export class StubMultisig {
  private proposals = new Map<number, MultisigProposal & { rawArgs: MultisigArg[] }>()
  private count = 0
  private config: MultisigConfig = { signers: [], threshold: 1 }
  readonly executedCalls: StubExecutedCall[] = []

  configure(config: MultisigConfig): void {
    this.config = { signers: [...config.signers], threshold: config.threshold }
  }

  getConfig(): MultisigConfig {
    return { signers: [...this.config.signers], threshold: this.config.threshold }
  }

  private requireSigner(address: string): void {
    if (!this.config.signers.includes(address)) throw fail('Not a signer', 403)
  }

  private requirePending(id: number) {
    const proposal = this.proposals.get(id)
    if (!proposal) throw fail('Proposal not found', 404)
    if (proposal.status !== 'pending') throw fail('Proposal is not pending', 409)
    if (nowSecs() > proposal.expiresAt) throw fail('Proposal has expired', 409)
    return proposal
  }

  private view(p: MultisigProposal & { rawArgs: MultisigArg[] }): MultisigProposal {
    const { rawArgs: _raw, ...rest } = p
    // A pending proposal past its deadline reads as expired, as `list_proposals` would report.
    const status: MultisigProposalStatus =
      p.status === 'pending' && nowSecs() > p.expiresAt ? 'expired' : p.status
    return { ...rest, status, approvals: [...p.approvals], args: [...p.args] }
  }

  propose(proposer: string, target: string, functionName: string, args: MultisigArg[]): number {
    this.requireSigner(proposer)
    this.count += 1
    const now = nowSecs()
    this.proposals.set(this.count, {
      id: this.count,
      proposer,
      target,
      function: functionName,
      // JSON-safe decoded form, the same shape the real adapter returns.
      args: args.map((a) => a.value),
      rawArgs: args,
      approvals: [],
      status: 'pending',
      createdAt: now,
      expiresAt: now + PROPOSAL_TTL_SECS,
    })
    return this.count
  }

  approve(signer: string, id: number): void {
    this.requireSigner(signer)
    const proposal = this.requirePending(id)
    if (proposal.approvals.includes(signer)) throw fail('Already approved', 409)
    proposal.approvals.push(signer)
  }

  revokeApproval(signer: string, id: number): void {
    this.requireSigner(signer)
    const proposal = this.requirePending(id)
    if (!proposal.approvals.includes(signer)) throw fail('Not approved by this signer', 409)
    proposal.approvals = proposal.approvals.filter((a) => a !== signer)
  }

  execute(executor: string, id: number): void {
    this.requireSigner(executor)
    const proposal = this.requirePending(id)
    if (proposal.approvals.length < this.config.threshold) {
      throw fail('Approval threshold not reached', 409)
    }
    proposal.status = 'executed'
    this.executedCalls.push({
      proposalId: id,
      target: proposal.target,
      functionName: proposal.function,
      args: proposal.rawArgs,
    })
  }

  get(id: number): MultisigProposal | null {
    const proposal = this.proposals.get(id)
    return proposal ? this.view(proposal) : null
  }

  list(status?: MultisigProposalStatus): MultisigProposal[] {
    return [...this.proposals.values()]
      .map((p) => this.view(p))
      .filter((p) => !status || p.status === status)
  }
}
