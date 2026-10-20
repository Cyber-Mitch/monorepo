import { apiClient } from '@/lib/apiClient';

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
  const res = await apiClient.get<RentGuaranteePolicy[]>('/landlord/rent-guarantee/policies');
  return res.data;
}

export async function requestQuote(dealId: string, coverageMonths: number): Promise<QuoteResult> {
  const res = await apiClient.post<QuoteResult>('/landlord/rent-guarantee/quote', { dealId, coverageMonths });
  return res.data;
}

export async function bindPolicy(quoteId: string): Promise<RentGuaranteePolicy> {
  const res = await apiClient.post<RentGuaranteePolicy>('/landlord/rent-guarantee/bind', { quoteId });
  return res.data;
}

export async function cancelPolicy(policyId: string): Promise<void> {
  await apiClient.post(`/landlord/rent-guarantee/policies/${policyId}/cancel`);
}

export async function fileClaim(policyId: string, claimAmount: string, reason: string): Promise<void> {
  await apiClient.post(`/landlord/rent-guarantee/policies/${policyId}/claims`, { claimAmount, reason });
}