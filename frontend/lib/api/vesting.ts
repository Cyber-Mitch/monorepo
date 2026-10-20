import { apiClient } from '@/lib/apiClient';

export interface VestingSchedule {
  total: string;
  vested: string;
  claimable: string;
  start: string;
  cliff: string;
  end: string;
  revocable: boolean;
  history?: { date: string; vested: number; claimed: number }[];
}

export interface ClaimPrepareResponse {
  unsignedXdr: string;
}

export interface ClaimSubmitResponse {
  txHash: string;
}

export async function fetchVestingSchedule(): Promise<VestingSchedule | null> {
  const res = await apiClient.get<VestingSchedule | null>('/vesting/me');
  return res.data;
}

export async function prepareClaim(): Promise<ClaimPrepareResponse> {
  const res = await apiClient.post<ClaimPrepareResponse>('/vesting/claim/prepare');
  return res.data;
}

export async function submitClaim(signedXdr: string): Promise<ClaimSubmitResponse> {
  const res = await apiClient.post<ClaimSubmitResponse>('/vesting/claim/submit', { signedXdr });
  return res.data;
}