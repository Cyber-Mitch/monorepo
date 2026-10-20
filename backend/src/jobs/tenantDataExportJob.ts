/**
 * Scheduler handler for tenant data export requests (#1899). Registered in
 * app.ts under TENANT_DATA_EXPORT_JOB_NAME and enqueued by the export route.
 */

import type { JobHandler } from './scheduler/types.js'
import { generateTenantDataExport } from '../services/tenantDataExportService.js'

export const tenantDataExportJobHandler: JobHandler = async (job) => {
  const exportId = (job.payload as { exportId?: unknown }).exportId
  if (typeof exportId !== 'string' || exportId.length === 0) {
    throw new Error('tenant.data_export job is missing exportId')
  }
  const result = await generateTenantDataExport(exportId)
  return { recordsProcessed: result.status === 'ready' ? 1 : 0 }
}
