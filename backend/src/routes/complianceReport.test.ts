import { describe, it, expect, vi } from 'vitest'
import { createComplianceReportRouter } from './complianceReport.js'

vi.mock('../middleware/auth.js', () => ({
  authenticateToken: (req: any, res: any, next: any) => next()
}))

vi.mock('../middleware/rbac.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/rbac.js')>()
  return {
    ...actual,
    requirePermission: (resource: string, action: string) => (req: any, res: any, next: any) => next()
  }
})

describe('ComplianceReport Router', () => {
  it('should be defined', () => {
    expect(createComplianceReportRouter()).toBeDefined()
  })
})
