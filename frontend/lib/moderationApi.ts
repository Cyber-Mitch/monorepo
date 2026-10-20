import { apiGet, apiPatch } from "./apiClient";

/**
 * Admin moderation API (#1891 listing reports, #1893 reviews, #1926).
 *
 * Paths are passed to apiFetch without `/api` (see referralsApi.ts, #1878).
 */

export const REPORT_CATEGORIES = [
  "fraud",
  "incorrect",
  "unavailable",
  "duplicate",
  "inappropriate",
  "other",
] as const;

export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

export interface ListingReport {
  reportId: string;
  propertyId: string;
  propertyTitle: string | null;
  category: ReportCategory;
  details: string;
  createdAt: string;
}

export interface ReportedReview {
  id: string;
  apartmentId: string;
  rating: number;
  content: string;
  authorName: string;
  isHidden: boolean;
  createdAt: string;
}

export interface ModerationPagination {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface ListingReportsResponse {
  reports: ListingReport[];
  pagination: ModerationPagination;
}

export interface ReportedReviewsResponse {
  reviews: ReportedReview[];
  pagination: ModerationPagination;
}

export async function listListingReports(params: {
  propertyId?: string;
  category?: ReportCategory | "all";
  page?: number;
}): Promise<ListingReportsResponse> {
  const search = new URLSearchParams();
  if (params.propertyId) search.set("propertyId", params.propertyId);
  if (params.category && params.category !== "all") search.set("category", params.category);
  if (params.page != null) search.set("page", String(params.page));
  const qs = search.toString();
  return apiGet<ListingReportsResponse>(
    `/admin/property-issue-reports${qs ? `?${qs}` : ""}`,
  );
}

/**
 * Reported reviews. The admin list endpoint is not in #1893 yet; this assumes
 * `isReported=true` on the admin route. Confirm with the backend before merge.
 */
export async function listReportedReviews(params: {
  page?: number;
}): Promise<ReportedReviewsResponse> {
  const search = new URLSearchParams({ isReported: "true" });
  if (params.page != null) search.set("page", String(params.page));
  return apiGet<ReportedReviewsResponse>(`/admin/apartment-reviews?${search.toString()}`);
}

export async function setReviewHidden(id: string, isHidden: boolean): Promise<void> {
  await apiPatch(`/admin/apartment-reviews/${encodeURIComponent(id)}`, { isHidden });
}
