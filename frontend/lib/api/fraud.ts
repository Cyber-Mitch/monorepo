import { apiGet, apiPost, withQuery } from '@/lib/apiClient';

export interface FraudAssessment {
  id: string;
  account: string;
  score: number;
  decision: 'APPROVE' | 'REVIEW' | 'BLOCK';
  signalsFired: string[];
  createdAt: string;
}

export interface ActiveHold {
  id: string;
  account: string;
  amount: string;
  reason: string;
  age: string;
  createdAt: string;
}

export async function fetchFraudAssessments(params?: { decision?: string }): Promise<FraudAssessment[]> {
  return apiGet<FraudAssessment[]>(withQuery('/api/admin/fraud/assessments', { decision: params?.decision }));
}

export async function fetchActiveHolds(): Promise<ActiveHold[]> {
  return apiGet<ActiveHold[]>('/api/admin/fraud/holds');
}

export async function releaseHold(holdId: string, reason: string): Promise<void> {
  await apiPost(`/api/admin/fraud/holds/${holdId}/release`, { reason });
}

export async function toggleFraudSignal(signalId: string, enabled: boolean): Promise<void> {
  await apiPost(`/api/admin/fraud/signals/${signalId}/${enabled ? 'enable' : 'disable'}`, {});
}
