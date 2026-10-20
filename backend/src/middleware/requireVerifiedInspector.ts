import type { Response, NextFunction } from 'express'
import type { AuthenticatedRequest } from './auth.js'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'
import { inspectorProfileStore } from '../models/inspectorProfileStore.js'

/**
 * Allows the request only when the authenticated caller has an
 * inspector_profiles row with verification_status = 'verified'.
 * Must run after authenticateToken.
 *
 * Part of the minimal #1902 subset: verification is granted by an admin via
 * PATCH /api/v1/admin/inspectors/:userId/verification.
 */
export async function requireVerifiedInspector(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = req.user?.id
    if (!userId) {
      throw new AppError(ErrorCode.UNAUTHORIZED, 401, 'User not authenticated')
    }
    const profile = await inspectorProfileStore.getByUserId(userId)
    if (!profile || profile.verificationStatus !== 'verified') {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        403,
        'Only verified inspectors can perform this action',
      )
    }
    next()
  } catch (error) {
    next(error)
  }
}
