import { apiClient } from '@/lib/apiClient';

export type WithdrawalStatus = 'pending' | 'approved' | 'rejected';

export interface WithdrawalRequest {
  id: string;
  user: {
    name: string;
    email: string;
  };
  amount: number;
  currency: string;
  maskedBankAccount: string;
  status: WithdrawalStatus;
  riskFlags?: string[];
  requestedAt: string;
}

export interface WithdrawalsResponse {
  data: WithdrawalRequest[];
  total: number;
  page: number;
  limit: number;
}

export async function fetchWithdrawals(status?: string, page = 1): Promise<WithdrawalsResponse> {
  const params = new URLSearchParams();
  if (status && status !== 'all') params.append('status', status);
  params.append('page', page.toString());
  
  const res = await apiClient.get<WithdrawalsResponse>(`/admin/withdrawals?${params.toString()}`);
  return res.data;
}

export async function approveWithdrawal(id: string): Promise<WithdrawalRequest> {
  const res = await apiClient.post<WithdrawalRequest>(`/admin/withdrawals/${id}/approve`, {});
  return res.data;
}

export async function rejectWithdrawal(id: string, reason: string): Promise<WithdrawalRequest> {
  const res = await apiClient.post<WithdrawalRequest>(`/admin/withdrawals/${id}/reject`, { reason });
  return res.data;
}