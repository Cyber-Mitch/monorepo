/**
 * Compliance reports API (#1982 / backend #1981).
 *
 * Thin typed wrappers over the shared apiClient helpers — no separate HTTP
 * client is introduced. The backend enforces admin access; a 403 surfaces as
 * an {@link ApiError} that the UI maps to an access-denied state.
 *
 * Report lifecycle:
 *   generate → pending → in_progress → completed (downloadable) | failed
 *
 * Download links (`fileUrl`) are backend-signed, so the download helper just
 * navigates to the URL the API returned rather than re-fetching the bytes.
 */

import { apiGet, apiPost, ApiError } from "./apiClient";
import type { ComplianceReportType } from "./formSchemas";

export { ApiError };

export type ComplianceReportStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed";

export interface ComplianceReport {
  id: string;
  type: ComplianceReportType;
  status: ComplianceReportStatus;
  /** ISO date (YYYY-MM-DD) — inclusive lower bound of the export window. */
  startDate: string;
  /** ISO date (YYYY-MM-DD) — inclusive upper bound of the export window. */
  endDate: string;
  createdBy: string;
  /** ISO datetime — when the report was requested. */
  createdAt: string;
  /** ISO datetime — when generation finished (completed or failed). */
  completedAt?: string;
  /** Backend-signed download URL, present once status is "completed". */
  fileUrl?: string;
  /** SHA-256 of the generated file, recorded at completion time. */
  sha256?: string;
  sizeBytes?: number;
  /** Present only when status is "failed". */
  errorMessage?: string;
}

export interface ComplianceReportListResponse {
  reports: ComplianceReport[];
  total: number;
}

export interface GenerateComplianceReportInput {
  type: ComplianceReportType;
  startDate: string;
  endDate: string;
}

export interface VerifyComplianceReportResult {
  id: string;
  /** True when the recomputed hash matches the recorded `sha256`. */
  match: boolean;
  /** Hash recorded at generation time. */
  expectedHash: string;
  /** Hash recomputed from the stored file at verification time. */
  actualHash: string;
  /** ISO datetime — when verification ran. */
  verifiedAt: string;
}

/** Base path for the compliance reports admin endpoints. */
const BASE_PATH = "/api/v1/admin/compliance/reports";

/** Newest-first list of compliance reports for the admin table. */
export async function listComplianceReports(): Promise<ComplianceReport[]> {
  const res = await apiGet<ComplianceReportListResponse>(BASE_PATH);
  return res.reports;
}

/** Queue a new report for generation. Returns the pending report record. */
export function generateComplianceReport(
  input: GenerateComplianceReportInput,
): Promise<ComplianceReport> {
  return apiPost<ComplianceReport>(BASE_PATH, input);
}

/** Recompute the file hash and compare it to the recorded `sha256`. */
export function verifyComplianceReport(
  id: string,
): Promise<VerifyComplianceReportResult> {
  return apiPost<VerifyComplianceReportResult>(
    `${BASE_PATH}/${encodeURIComponent(id)}/verify`,
    {},
  );
}

/**
 * Triggers a browser download of a completed report. The `fileUrl` is
 * backend-signed, so this navigates to it directly rather than routing the
 * bytes through the JSON-oriented apiClient. No-op when there is no URL.
 */
export function downloadComplianceReport(report: ComplianceReport): void {
  if (!report.fileUrl) return;
  const link = document.createElement("a");
  link.href = report.fileUrl;
  link.download = `compliance-${report.type}-${report.id}.csv`;
  link.rel = "noopener noreferrer";
  link.style.visibility = "hidden";
  document.body.appendChild(link);
  link.click();
  link.remove();
}
