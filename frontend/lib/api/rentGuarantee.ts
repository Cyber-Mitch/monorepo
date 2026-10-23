import { apiGet, apiPost } from '@/lib/apiClient';

export interface RentGuaranteePolicy {
  id: string;
  dealId: string;
  premium: string;
  coverageTermMonths: number;
  status: 'ACTIVE' | 'EXPIRED' | 'CLAIMED' | 'CANCELLED';
  providerTermsNotice: string;
  createdAt: string;
}

export interface QuoteResult {
  quoteId: string;
  premium: string;
  coverageTermMonths: number;
  providerTermsNotice: string;
}

export async function fetchLandlordPolicies(): Promise<RentGuaranteePolicy[]> {
  return apiGet<RentGuaranteePolicy[]>('/landlord/rent-guarantee/policies');
}

export async function requestQuote(dealId: string, coverageMonths: number): Promise<QuoteResult> {
  return apiPost<QuoteResult>('/landlord/rent-guarantee/quote', { dealId, coverageMonths });
}

export async function bindPolicy(quoteId: string): Promise<RentGuaranteePolicy> {
  return apiPost<RentGuaranteePolicy>('/landlord/rent-guarantee/bind', { quoteId });
}

export async function cancelPolicy(policyId: string): Promise<void> {
  await apiPost(`/landlord/rent-guarantee/policies/${policyId}/cancel`, {});
}

export async function fileClaim(policyId: string, claimAmount: string, reason: string): Promise<void> {
  await apiPost(`/landlord/rent-guarantee/policies/${policyId}/claims`, { claimAmount, reason });
}