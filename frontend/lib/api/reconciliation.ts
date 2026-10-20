import { apiGet, apiPost, withQuery } from '@/lib/apiClient';

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

const BASE = '/api/v1/admin/reconciliation';

export async function fetchAgingSummary(): Promise<AgingSummary> {
  return apiGet<AgingSummary>(`${BASE}/aging`);
}

export async function fetchMismatches(params?: { status?: string; class?: string }): Promise<MismatchItem[]> {
  return apiGet<MismatchItem[]>(withQuery(`${BASE}/mismatches`, { status: params?.status, class: params?.class }));
}

export async function closeMismatch(id: string, reason: string): Promise<void> {
  await apiPost(`${BASE}/mismatches/${id}/close`, { reason });
}

export async function runReconciliation(): Promise<ReconciliationRunResult> {
  return apiPost<ReconciliationRunResult>(`${BASE}/run`, {});
}

export async function fetchEventDrilldown(id: string): Promise<EventSideBySide> {
  return apiGet<EventSideBySide>(`${BASE}/mismatches/${id}/events`);
}
