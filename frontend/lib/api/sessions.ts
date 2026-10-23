import { apiGet, apiDelete, withQuery } from '@/lib/apiClient';

export interface SessionItem {
  id: string;
  device: string;
  location?: string;
  lastActive: string;
  isCurrent: boolean;
}

export async function fetchSessions(): Promise<SessionItem[]> {
  return apiGet<SessionItem[]>('/auth/sessions');
}

export async function revokeSession(id: string): Promise<void> {
  await apiDelete(`/auth/sessions/${id}`);
}

export async function revokeOtherSessions(): Promise<void> {
  await apiDelete(withQuery('/auth/sessions', { others: 'true' }));
}