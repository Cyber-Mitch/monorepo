import { apiClient } from '@/lib/apiClient';

export interface SupportMessage {
  id: string;
  name: string;
  email: string;
  subject: string;
  message: string;
  receivedAt: string;
}

export interface SupportMessagesResponse {
  data: SupportMessage[];
  total: number;
  page: number;
  limit: number;
}

export async function fetchSupportMessages(search?: string, page = 1): Promise<SupportMessagesResponse> {
  const params = new URLSearchParams();
  if (search) params.append('search', search);
  params.append('page', page.toString());
  
  const res = await apiClient.get<SupportMessagesResponse>(`/admin/support/messages?${params.toString()}`);
  return res.data;
}