import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { SorobanAdapter } from "../soroban/adapter.js";
import { logger } from "../utils/logger.js";
import { AppError } from "../errors/AppError.js";
import { ErrorCode } from "../errors/errorCodes.js";
import { validate } from "../middleware/validate.js";
import { auditLog, extractAuditContext } from "../utils/auditLogger.js";
import { describeGateResult, executeOrPropose } from "../services/multisigGate.js";
import { z } from "zod";
import { requireAdminAccess } from '../middleware/adminAccess.js'

// Validation schemas
/** A BytesN<32>, as 64 hex characters, as the deal_escrow contract's drain functions take. */
const drainHashSchema = z.string().regex(/^[0-9a-fA-F]{64}$/, "Must be 64 hex characters");

const proposeDrainSchema = z.object({
  destination: z.string(),
  // Only used when a multisig is configured: deal_escrow's propose_drain takes a hash.
  drainHash: drainHashSchema.optional(),
});

const executeDrainSchema = z.object({
  drainHash: drainHashSchema.optional(),
});

/**
 * With a multisig configured the drain is proposed as the contract's own call,
 * `propose_drain(admin, drain_hash)` / `execute_drain(admin, drain_hash)`, so
 * the hash is required.
 */
function requireDrainHash(drainHash: string | undefined): string {
  if (!drainHash) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      400,
      "drainHash is required when a multisig is configured (deal_escrow's drain functions take a BytesN<32> hash)"
    );
  }
  return drainHash;
}

const setRecoveryDelaySchema = z.object({
  delaySeconds: z.number().int().min(0),
});

export function createCircuitBreakerRouter(adapter: SorobanAdapter) {
  const router = Router();

  /**
   * POST /api/admin/circuit-breaker/freeze
   * Freeze the deal_escrow contract (admin-only emergency control)
   */
  router.post(
    "/freeze",
    requireAdminAccess('circuit_breaker', 'execute', { audit: false }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!adapter.freeze) {
          throw new AppError(
            ErrorCode.INTERNAL_ERROR,
            501,
            "Circuit breaker functionality not available"
          );
        }

        const txHash = await adapter.freeze();

        await auditLog(
          "ADMIN_CIRCUIT_BREAKER_FREEZE",
          extractAuditContext(req, "admin"),
          { action: "freeze", txHash },
          { durable: true }
        );

        logger.info("Deal escrow frozen", { txHash });

        res.json({
          success: true,
          txHash,
          message: "Deal escrow frozen successfully",
        });
      } catch (error) {
        next(error);
      }
    }
  );

  /**
   * GET /api/admin/circuit-breaker/status
   * Get the current circuit breaker state (admin-only)
   */
  router.get(
    "/status",
    requireAdminAccess('circuit_breaker', 'view', { audit: false }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!adapter.isFrozen || !adapter.getCircuitBreakerState) {
          throw new AppError(
            ErrorCode.INTERNAL_ERROR,
            501,
            "Circuit breaker functionality not available"
          );
        }

        const [frozen, state] = await Promise.all([
          adapter.isFrozen(),
          adapter.getCircuitBreakerState(),
        ]);

        res.json({
          frozen,
          state,
        });
      } catch (error) {
        next(error);
      }
    }
  );

  /**
   * POST /api/admin/circuit-breaker/propose-drain
   * Propose draining funds to a destination (admin-only emergency control)
   */
  router.post(
    "/propose-drain",
    requireAdminAccess('circuit_breaker', 'execute', { freshAuth: true, audit: false }),
    validate(proposeDrainSchema, 'body'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { destination, drainHash } = req.body;

        if (!adapter.proposeDrain) {
          throw new AppError(
            ErrorCode.INTERNAL_ERROR,
            501,
            "Circuit breaker functionality not available"
          );
        }

        // With a multisig configured this files a proposal instead of executing.
        const result = await executeOrPropose(adapter, {
          operation: "propose_drain",
          target: "dealEscrow",
          functionName: "propose_drain",
          args: (multisigContractId) => [
            { type: "address", value: multisigContractId },
            { type: "bytes32", value: requireDrainHash(drainHash) },
          ],
          direct: () => adapter.proposeDrain!(destination),
        });
        const { txHash } = result;

        await auditLog(
          "ADMIN_CIRCUIT_BREAKER_PROPOSE_DRAIN",
          extractAuditContext(req, "admin"),
          {
            action: "propose-drain",
            destination,
            txHash,
            ...(result.mode === "multisig" ? { mode: "multisig", proposalId: result.proposalId } : {}),
          },
          { durable: true }
        );

        logger.info("Drain proposed", { destination, txHash, mode: result.mode });

        res.status(result.mode === "multisig" ? 202 : 200).json({
          success: true,
          txHash,
          message:
            result.mode === "multisig"
              ? "Drain proposal filed with the multisig; it has not been executed"
              : "Drain proposed successfully",
          ...describeGateResult(result),
        });
      } catch (error) {
        next(error);
      }
    }
  );

  /**
   * POST /api/admin/circuit-breaker/execute-drain
   * Execute the proposed drain (admin-only emergency control)
   */
  router.post(
    "/execute-drain",
    requireAdminAccess('circuit_breaker', 'execute', { freshAuth: true, audit: false }),
    validate(executeDrainSchema, 'body'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { drainHash } = req.body as { drainHash?: string };

        if (!adapter.executeDrain) {
          throw new AppError(
            ErrorCode.INTERNAL_ERROR,
            501,
            "Circuit breaker functionality not available"
          );
        }

        // With a multisig configured this files a proposal instead of executing.
        const result = await executeOrPropose(adapter, {
          operation: "execute_drain",
          target: "dealEscrow",
          functionName: "execute_drain",
          args: (multisigContractId) => [
            { type: "address", value: multisigContractId },
            { type: "bytes32", value: requireDrainHash(drainHash) },
          ],
          direct: () => adapter.executeDrain!(),
        });
        const { txHash } = result;

        await auditLog(
          "ADMIN_CIRCUIT_BREAKER_EXECUTE_DRAIN",
          extractAuditContext(req, "admin"),
          {
            action: "execute-drain",
            txHash,
            ...(result.mode === "multisig" ? { mode: "multisig", proposalId: result.proposalId } : {}),
          },
          { durable: true }
        );

        logger.info("Drain executed", { txHash, mode: result.mode });

        res.status(result.mode === "multisig" ? 202 : 200).json({
          success: true,
          txHash,
          message:
            result.mode === "multisig"
              ? "Drain execution proposal filed with the multisig; it has not been executed"
              : "Drain executed successfully",
          ...describeGateResult(result),
        });
      } catch (error) {
        next(error);
      }
    }
  );

  /**
   * POST /api/admin/circuit-breaker/set-recovery-delay
   * Set the recovery delay for circuit breaker (admin-only)
   */
  router.post(
    "/set-recovery-delay",
    requireAdminAccess('circuit_breaker', 'execute', { audit: false }),
    validate(setRecoveryDelaySchema, 'body'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { delaySeconds } = req.body;

        if (!adapter.setRecoveryDelay) {
          throw new AppError(
            ErrorCode.INTERNAL_ERROR,
            501,
            "Circuit breaker functionality not available"
          );
        }

        const txHash = await adapter.setRecoveryDelay(delaySeconds);

        await auditLog(
          "ADMIN_CIRCUIT_BREAKER_SET_RECOVERY_DELAY",
          extractAuditContext(req, "admin"),
          { action: "set-recovery-delay", delaySeconds, txHash },
          { durable: true }
        );

        logger.info("Recovery delay set", { delaySeconds, txHash });

        res.json({
          success: true,
          txHash,
          message: "Recovery delay set successfully",
        });
      } catch (error) {
        next(error);
      }
    }
  );

  return router;
}
