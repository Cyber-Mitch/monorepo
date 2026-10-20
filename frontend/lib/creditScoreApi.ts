import { apiGet } from "./apiClient";

export type CreditScoreBand = "poor" | "fair" | "good" | "excellent";

export interface CreditScoreFactor {
  name: string;
  status: "pass" | "fail" | "warn";
  weight: number;
  detail: string;
}

export interface CreditScoreResponse {
  success: boolean;
  data: {
    score: number;
    band: CreditScoreBand;
    factors: CreditScoreFactor[];
    computedAt: string;
    tips: string[];
  } | null;
}

export interface CreditScoreHistoryItem {
  id: string;
  userId: string;
  score: number;
  band: CreditScoreBand;
  factors: CreditScoreFactor[];
  computedAt: string;
}

export interface CreditScoreHistoryResponse {
  success: boolean;
  data: CreditScoreHistoryItem[];
}

export async function getCreditScore(): Promise<CreditScoreResponse> {
  return apiGet<CreditScoreResponse>("/api/v1/tenant/credit-score");
}

export async function getCreditScoreHistory(
  limit = 10,
): Promise<CreditScoreHistoryResponse> {
  return apiGet<CreditScoreHistoryResponse>(
    `/api/v1/tenant/credit-score/history?limit=${limit}`,
  );
}
