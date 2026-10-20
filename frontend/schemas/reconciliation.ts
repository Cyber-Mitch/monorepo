import { apiClient } from '@/lib/apiClient';

export interface MismatchItem {
  id: string;
  class: string;
  amount: string;
  age: string;
  attempts: number;
  status: 'OPEN' | 'RESOLVED' | 'CLOSED';
  createdAt: string;
}

export interface AgingSummary {
  totalMismatches: number;
  aging0to7Days: number;
  aging8to30Days: number;
  aging30PlusDays: number;
}

export interface ReconciliationRunResult {
  runId: string;
  processedCount: number;
  mismatchesFound: number;
  timestamp: string;
}

export interface EventSideBySide {
  ledgerEvent: Record<string, unknown>;
  providerEvent: Record<string, unknown>;
}

export async function fetchAgingSummary(): Promise<AgingSummary> {
  const res = await apiClient.get<AgingSummary>('/admin/reconciliation/aging');
  return res.data;
}

export async function fetchMismatches(params?: { status?: string; class?: string }): Promise<MismatchItem[]> {
  const res = await apiClient.get<MismatchItem[]>('/admin/reconciliation/mismatches', { params });
  return res.data;
}

export async function closeMismatch(id: string, reason: string): Promise<void> {
  await apiClient.post(`/admin/reconciliation/mismatches/${id}/close`, { reason });
}

export async function runReconciliation(): Promise<ReconciliationRunResult> {
  const res = await apiClient.post<ReconciliationRunResult>('/admin/reconciliation/run');
  return res.data;
}

export async function fetchEventDrilldown(id: string): Promise<EventSideBySide> {
  const res = await apiClient.get<EventSideBySide>(`/admin/reconciliation/mismatches/${id}/events`);
  return res.data;
}