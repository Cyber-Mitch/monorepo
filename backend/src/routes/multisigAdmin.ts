/**
 * Multisig admin routes (#1972). Signers see proposals for privileged on-chain
 * actions and approve them with their own wallets: the backend only prepares
 * unsigned transactions and checks the signed ones before broadcasting.
 *
 * All routes need `multisig:sign`, and the caller's linked wallet must be one of
 * the contract's signers for anything that changes a proposal.
 *
 *   GET  /api/v1/admin/multisig/config                    signers and threshold
 *   GET  /api/v1/admin/multisig                           proposals (filters: status, target, function, awaitingMySignature)
 *   GET  /api/v1/admin/multisig/:id                       one proposal, with decoded target, function and arguments
 *   POST /api/v1/admin/multisig/propose/prepare           unsigned `propose`
 *   POST /api/v1/admin/multisig/:id/approve/prepare       unsigned `approve`
 *   POST /api/v1/admin/multisig/:id/revoke/prepare        unsigned `revoke_approval`
 *   POST /api/v1/admin/multisig/:id/execute/prepare       unsigned `execute` (only once the threshold is met)
 *   POST /api/v1/admin/multisig/submit                    submit any of the above, signed by the wallet
 *
 * Covered admin operations (circuit-breaker drain, contract-access role
 * assignment) become proposals here instead of executing directly when
 * `MULTISIG_ADMIN_ID` is set; see `services/multisigGate.ts`.
 */

import { Router, type Response, type NextFunction } from 'express'
import { authenticateToken, type AuthenticatedRequest } from '../middleware/auth.js'
import { requirePermission } from '../middleware/rbac.js'
import { validate } from '../middleware/validate.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import type { LinkedAddressStore } from '../models/linkedAddressStore.js'
import type {
  MultisigCall,
  MultisigCallParams,
  MultisigConfig,
  MultisigProposal,
  SorobanAdapter,
} from '../soroban/adapter.js'
import {
  listProposalsQuerySchema,
  prepareProposeSchema,
  proposalIdParamsSchema,
  submitMultisigSchema,
  type MultisigArgInput,
} from '../schemas/multisig.js'

type MultisigMethod =
  | 'multisigGetConfig'
  | 'multisigListProposals'
  | 'multisigGetProposal'
  | 'prepareMultisigCall'
  | 'submitMultisigCall'

const MULTISIG_METHODS: MultisigMethod[] = [
  'multisigGetConfig',
  'multisigListProposals',
  'multisigGetProposal',
  'prepareMultisigCall',
  'submitMultisigCall',
]

type MultisigAdapter = SorobanAdapter & Required<Pick<SorobanAdapter, MultisigMethod>>

function requireMultisig(adapter: SorobanAdapter): MultisigAdapter {
  if (MULTISIG_METHODS.some((name) => typeof adapter[name] !== 'function')) {
    throw new AppError(
      ErrorCode.NOT_IMPLEMENTED,
      501,
      'Multisig is not available on the configured Soroban adapter',
    )
  }
  if (adapter.multisigEnabled?.() !== true) {
    throw new AppError(ErrorCode.NOT_IMPLEMENTED, 501, 'Multisig is not configured (MULTISIG_ADMIN_ID is unset)')
  }
  return adapter as MultisigAdapter
}

function currentUserId(req: AuthenticatedRequest): string {
  if (!req.user) {
    throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'Authentication required')
  }
  return req.user.id
}

async function linkedWallet(store: LinkedAddressStore, userId: string): Promise<string | null> {
  return store.getLinkedAddress(userId)
}

async function requireLinkedWallet(store: LinkedAddressStore, userId: string): Promise<string> {
  const wallet = await linkedWallet(store, userId)
  if (!wallet) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'No linked wallet address found for user')
  }
  return wallet
}

function requireSigner(config: MultisigConfig, wallet: string): void {
  if (!config.signers.includes(wallet)) {
    throw new AppError(ErrorCode.FORBIDDEN, 403, 'Your linked wallet is not a signer of the multisig')
  }
}

function toProposalDto(proposal: MultisigProposal, config: MultisigConfig, wallet: string | null) {
  return {
    id: proposal.id,
    status: proposal.status,
    proposer: proposal.proposer,
    target: proposal.target,
    function: proposal.function,
    args: proposal.args,
    approvals: proposal.approvals,
    approvalCount: proposal.approvals.length,
    threshold: config.threshold,
    /** Pending and enough approvals: a signer can execute it now. */
    ready: proposal.status === 'pending' && proposal.approvals.length >= config.threshold,
    approvedByMe: wallet ? proposal.approvals.includes(wallet) : null,
    createdAt: proposal.createdAt,
    expiresAt: proposal.expiresAt,
  }
}

async function loadProposal(adapter: MultisigAdapter, id: number): Promise<MultisigProposal> {
  const proposal = await adapter.multisigGetProposal(id)
  if (!proposal) {
    throw new AppError(ErrorCode.NOT_FOUND, 404, `Proposal ${id} not found`)
  }
  return proposal
}

function requirePending(proposal: MultisigProposal): void {
  if (proposal.status !== 'pending') {
    throw new AppError(ErrorCode.CONFLICT, 409, `Proposal ${proposal.id} is ${proposal.status}, not pending`)
  }
}

export function createMultisigAdminRouter(
  sorobanAdapter: SorobanAdapter,
  linkedAddressStore: LinkedAddressStore,
): Router {
  const router = Router()

  router.use(authenticateToken, requirePermission('multisig', 'sign'))

  router.get('/config', async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const multisig = requireMultisig(sorobanAdapter)
      const config = await multisig.multisigGetConfig()
      res.json({
        success: true,
        data: { contractId: sorobanAdapter.multisigContractId?.() ?? null, ...config },
      })
    } catch (error) {
      next(error)
    }
  })

  router.get(
    '/',
    validate(listProposalsQuerySchema, 'query'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const multisig = requireMultisig(sorobanAdapter)
        const query = req.query as unknown as {
          status?: MultisigProposal['status']
          target?: string
          function?: string
          awaitingMySignature?: boolean
        }
        const wallet = await linkedWallet(linkedAddressStore, currentUserId(req))
        if (query.awaitingMySignature && !wallet) {
          throw new AppError(ErrorCode.VALIDATION_ERROR, 400, 'No linked wallet address found for user')
        }

        const [config, all] = await Promise.all([
          multisig.multisigGetConfig(),
          multisig.multisigListProposals(query.status),
        ])
        const proposals = all
          .filter((p) => !query.target || p.target === query.target)
          .filter((p) => !query.function || p.function === query.function)
          .filter(
            (p) =>
              !query.awaitingMySignature ||
              (p.status === 'pending' && !p.approvals.includes(wallet as string)),
          )
          .sort((a, b) => b.id - a.id)

        res.json({
          success: true,
          data: { threshold: config.threshold, proposals: proposals.map((p) => toProposalDto(p, config, wallet)) },
        })
      } catch (error) {
        next(error)
      }
    },
  )

  router.post(
    '/propose/prepare',
    validate(prepareProposeSchema, 'body'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const multisig = requireMultisig(sorobanAdapter)
        const wallet = await requireLinkedWallet(linkedAddressStore, currentUserId(req))
        requireSigner(await multisig.multisigGetConfig(), wallet)
        const body = req.body as { target: string; function: string; args: MultisigArgInput[] }

        const xdr = await multisig.prepareMultisigCall('propose', {
          signer: wallet,
          target: body.target,
          functionName: body.function,
          args: body.args,
        })
        res.json({ success: true, data: { xdr } })
      } catch (error) {
        next(error)
      }
    },
  )

  router.get(
    '/:id',
    validate(proposalIdParamsSchema, 'params'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const multisig = requireMultisig(sorobanAdapter)
        const { id } = req.params as unknown as { id: number }
        const wallet = await linkedWallet(linkedAddressStore, currentUserId(req))
        const [config, proposal] = await Promise.all([
          multisig.multisigGetConfig(),
          loadProposal(multisig, id),
        ])
        res.json({ success: true, data: toProposalDto(proposal, config, wallet) })
      } catch (error) {
        next(error)
      }
    },
  )

  /** approve, revoke and execute differ only in their precondition. */
  const proposalCall = (
    path: string,
    call: Exclude<MultisigCall, 'propose'>,
    precondition: (proposal: MultisigProposal, config: MultisigConfig, wallet: string) => void,
  ) => {
    router.post(
      `/:id/${path}/prepare`,
      validate(proposalIdParamsSchema, 'params'),
      async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
          const multisig = requireMultisig(sorobanAdapter)
          const { id } = req.params as unknown as { id: number }
          const wallet = await requireLinkedWallet(linkedAddressStore, currentUserId(req))
          const config = await multisig.multisigGetConfig()
          requireSigner(config, wallet)

          const proposal = await loadProposal(multisig, id)
          requirePending(proposal)
          precondition(proposal, config, wallet)

          const xdr = await multisig.prepareMultisigCall(call, { signer: wallet, proposalId: id })
          res.json({ success: true, data: { xdr } })
        } catch (error) {
          next(error)
        }
      },
    )
  }

  proposalCall('approve', 'approve', (proposal, _config, wallet) => {
    if (proposal.approvals.includes(wallet)) {
      throw new AppError(ErrorCode.CONFLICT, 409, 'You have already approved this proposal')
    }
  })
  proposalCall('revoke', 'revoke_approval', (proposal, _config, wallet) => {
    if (!proposal.approvals.includes(wallet)) {
      throw new AppError(ErrorCode.CONFLICT, 409, 'You have not approved this proposal')
    }
  })
  proposalCall('execute', 'execute', (proposal, config) => {
    if (proposal.approvals.length < config.threshold) {
      throw new AppError(
        ErrorCode.CONFLICT,
        409,
        `Approval threshold not reached (${proposal.approvals.length} of ${config.threshold})`,
      )
    }
  })

  router.post(
    '/submit',
    validate(submitMultisigSchema, 'body'),
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const multisig = requireMultisig(sorobanAdapter)
        const wallet = await requireLinkedWallet(linkedAddressStore, currentUserId(req))
        requireSigner(await multisig.multisigGetConfig(), wallet)
        const body = req.body as
          | { call: 'propose'; signedXdr: string; target: string; function: string; args: MultisigArgInput[] }
          | { call: Exclude<MultisigCall, 'propose'>; signedXdr: string; proposalId: number }

        const params: MultisigCallParams =
          body.call === 'propose'
            ? { signer: wallet, target: body.target, functionName: body.function, args: body.args }
            : { signer: wallet, proposalId: body.proposalId }

        // The adapter checks the signed XDR against these parameters before broadcasting.
        const txHash = await multisig.submitMultisigCall(body.signedXdr, body.call, params)
        res.json({ success: true, data: { call: body.call, txHash } })
      } catch (error) {
        next(error)
      }
    },
  )

  return router
}
