import { apiClient } from '@/lib/apiClient';

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
  const res = await apiClient.get<FraudAssessment[]>('/admin/fraud/assessments', { params });
  return res.data;
}

export async function fetchActiveHolds(): Promise<ActiveHold[]> {
  const res = await apiClient.get<ActiveHold[]>('/admin/fraud/holds');
  return res.data;
}

export async function releaseHold(holdId: string, reason: string): Promise<void> {
  await apiClient.post(`/admin/fraud/holds/${holdId}/release`, { reason });
}

export async function toggleFraudSignal(signalId: string, enabled: boolean): Promise<void> {
  await apiClient.post(`/admin/fraud/signals/${signalId}/toggle`, { enabled });
}