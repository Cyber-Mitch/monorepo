import { apiGet } from "./apiClient";

/**
 * Tenant referral API (#1895, #1927).
 *
 * Paths are passed to apiFetch without `/api`: it adds `/api/v1` itself.
 * Passing `/api/...` here would produce `/api/v1/api/...` (#1878).
 */

export interface ReferralStats {
  referredCount: number;
  creditedCount: number;
  /** Null when the reward total is unknown. Never render this as 0. */
  pendingRewardTotal: number | null;
}

export interface ReferralSummary {
  code: string;
  shareUrl: string;
  stats: ReferralStats;
}

export type ReferralConversionStatus = "pending" | "credited" | "rejected";

export interface ReferralConversion {
  id: string;
  /** Initials or a masked name only. The backend never returns the email. */
  referredName: string;
  status: ReferralConversionStatus;
  createdAt: string;
}

export interface ReferralPagination {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface ReferralConversionsResponse {
  conversions: ReferralConversion[];
  pagination: ReferralPagination;
}

export async function getMyReferrals(): Promise<ReferralSummary> {
  return apiGet<ReferralSummary>("/referrals/me");
}

export async function getMyReferralConversions(
  params: { page?: number; limit?: number } = {},
): Promise<ReferralConversionsResponse> {
  const search = new URLSearchParams();
  if (params.page != null) search.set("page", String(params.page));
  if (params.limit != null) search.set("limit", String(params.limit));
  const qs = search.toString();
  return apiGet<ReferralConversionsResponse>(
    `/referrals/me/conversions${qs ? `?${qs}` : ""}`,
  );
}
