import { apiGet, apiPost } from '@/lib/apiClient';

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
  return apiGet<VestingSchedule | null>('/vesting/me');
}

export async function prepareClaim(): Promise<ClaimPrepareResponse> {
  return apiPost<ClaimPrepareResponse>('/vesting/claim/prepare', {});
}

export async function submitClaim(signedXdr: string): Promise<ClaimSubmitResponse> {
  return apiPost<ClaimSubmitResponse>('/vesting/claim/submit', { signedXdr });
}