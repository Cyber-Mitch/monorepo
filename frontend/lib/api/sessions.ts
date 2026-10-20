import { apiClient } from '@/lib/apiClient';

export interface SessionItem {
  id: string;
  device: string;
  location?: string;
  lastActive: string;
  isCurrent: boolean;
}

export async function fetchSessions(): Promise<SessionItem[]> {
  const res = await apiClient.get<SessionItem[]>('/auth/sessions');
  return res.data;
}

export async function revokeSession(id: string): Promise<void> {
  await apiClient.delete(`/auth/sessions/${id}`);
}

export async function revokeOtherSessions(): Promise<void> {
  await apiClient.delete('/auth/sessions', { params: { others: 'true' } });
}