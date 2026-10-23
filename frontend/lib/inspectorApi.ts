/**
 * Inspector API (#1921 job board / report submission, #1922 onboarding).
 *
 * Paths are passed to apiFetch without `/api` (see referralsApi.ts, #1878).
 * All backend envelope shapes `{ success, data }` are unwrapped here so
 * callers only ever see the payload.
 */
import { apiGet, apiPost, withQuery } from "./apiClient";
import { SUPPORTED_INSPECTOR_SERVICE_AREAS } from "../config/inspectorServiceAreas";

export { SUPPORTED_INSPECTOR_SERVICE_AREAS } from "../config/inspectorServiceAreas";
export type { InspectorServiceArea } from "../config/inspectorServiceAreas";

export type InspectorVerificationStatus = "pending" | "verified" | "suspended";

export interface InspectorProfile {
  userId: string;
  verificationStatus: InspectorVerificationStatus;
  bio: string | null;
  serviceAreas: string[];
  completedInspections: number;
  createdAt: string;
  updatedAt: string;
}

export type InspectionJobStatus =
  | "available"
  | "claimed"
  | "in_progress"
  | "submitted"
  | "approved"
  | "rejected";

export interface InspectorJob {
  id: string;
  listingId: string;
  listingArea: string | null;
  status: InspectionJobStatus;
  offeredFeeNgn: number;
  inspectorId: string | null;
  claimDeadline: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PresignedJobPhoto {
  uploadUrl: string;
  objectKey: string;
  expiresAt: string;
}

/** Content types the backend presign endpoint accepts (mirror of
 * backend/src/schemas/propertyInspection.ts INSPECTION_PHOTO_CONTENT_TYPES). */
export const INSPECTION_PHOTO_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
] as const;

export type InspectionPhotoContentType = (typeof INSPECTION_PHOTO_CONTENT_TYPES)[number];

/** Matches inspection_reports (backend migration 029): overall_grade A–D,
 * at least 3 photo keys and notes of at least 20 characters — mirrored in
 * lib/formSchemas.ts so the form warns before the server rejects. */
export type InspectionGrade = "A" | "B" | "C" | "D";

export interface InspectionReportInput {
  overallGrade: InspectionGrade;
  /** Room name -> pass | fail | na */
  roomChecklist: Record<string, "pass" | "fail" | "na">;
  photoKeys: string[];
  notes: string;
}

interface ApiEnvelope<T> {
  success: boolean;
  data: T;
}

// ── Onboarding (#1902) ──────────────────────────────────────────────────────

export async function getInspectorProfile(): Promise<InspectorProfile> {
  const res = await apiGet<ApiEnvelope<InspectorProfile>>("/api/v1/inspector/me");
  return res.data;
}

export async function submitInspectorOnboarding(
  input: { bio: string; serviceAreas: string[] },
): Promise<InspectorProfile> {
  const res = await apiPost<ApiEnvelope<InspectorProfile>>(
    "/api/v1/inspector/onboarding",
    input,
  );
  return res.data;
}

/** Backend GET /api/kyc/status — `{ status, ... }` without an envelope. */
export type KycStatus = {
  status: "not_submitted" | "pending" | "approved" | "rejected";
  attemptsRemaining: number;
  [key: string]: unknown;
};

export async function getKycStatus(): Promise<KycStatus> {
  return apiGet<KycStatus>("/api/kyc/status");
}

// ── Job board (#1903) ───────────────────────────────────────────────────────

export async function listAvailableJobs(area?: string): Promise<InspectorJob[]> {
  const res = await apiGet<ApiEnvelope<InspectorJob[]>>(
    withQuery("/api/v1/inspector/jobs", { area }),
  );
  return res.data;
}

export async function listMyJobs(): Promise<InspectorJob[]> {
  const res = await apiGet<ApiEnvelope<InspectorJob[]>>("/api/v1/inspector/jobs/mine");
  return res.data;
}

export async function claimJob(jobId: string): Promise<InspectorJob> {
  const res = await apiPost<ApiEnvelope<InspectorJob>>(
    `/api/v1/inspector/jobs/${encodeURIComponent(jobId)}/claim`,
    {},
  );
  return res.data;
}

export async function presignJobPhoto(
  jobId: string,
  contentType: InspectionPhotoContentType,
): Promise<PresignedJobPhoto> {
  const res = await apiPost<ApiEnvelope<PresignedJobPhoto>>(
    `/api/v1/inspector/jobs/${encodeURIComponent(jobId)}/photos/presign`,
    { contentType },
  );
  return res.data;
}

export async function submitJobReport(
  jobId: string,
  report: InspectionReportInput,
): Promise<{ jobId: string; status: "submitted"; submittedAt: string }> {
  const res = await apiPost<ApiEnvelope<{ jobId: string; status: "submitted"; submittedAt: string }>>(
    `/api/v1/inspector/jobs/${encodeURIComponent(jobId)}/report`,
    {
      overallGrade: report.overallGrade,
      roomChecklist: report.roomChecklist,
      photoKeys: report.photoKeys,
      notes: report.notes,
    },
  );
  return res.data;
}

/**
 * Upload one report photo: presign on the backend, then PUT the file straight
 * to the presigned storage URL. XHR is used for this storage hop only so the
 * caller can render progress; every backend call still flows through
 * lib/apiClient.ts.
 */
export interface PhotoUploadProgress {
  loaded: number;
  total: number;
}

export async function uploadJobPhoto(
  jobId: string,
  file: File,
  onProgress?: (update: PhotoUploadProgress) => void,
): Promise<PresignedJobPhoto> {
  const contentType = file.type as InspectionPhotoContentType;
  const presigned = await presignJobPhoto(jobId, contentType);

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", presigned.uploadUrl);
    xhr.setRequestHeader("Content-Type", contentType);

    if (onProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          onProgress({ loaded: event.loaded, total: event.total });
        }
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`Photo upload failed (HTTP ${xhr.status}).`));
      }
    };
    xhr.onerror = () => reject(new Error("Photo upload failed. Please try again."));
    xhr.send(file);
  });

  return presigned;
}
