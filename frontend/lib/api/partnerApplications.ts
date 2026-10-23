import { apiGet, apiPatch, withQuery } from '@/lib/apiClient';

export type PartnerApplicationStatus = 'pending' | 'contacted' | 'approved' | 'rejected';

export interface PartnerApplication {
  id: string;
  name: string;
  phone: string;
  email: string;
  propertyCount: number;
  locations: string[];
  status: PartnerApplicationStatus;
  notes?: string;
  submittedAt: string;
}

export interface PartnerApplicationsResponse {
  data: PartnerApplication[];
  total: number;
  page: number;
  limit: number;
}

export async function fetchPartnerApplications(status?: string, search?: string, page = 1): Promise<PartnerApplicationsResponse> {
  const params = new URLSearchParams();
  if (status && status !== 'all') params.append('status', status);
  if (search) params.append('search', search);
  params.append('page', page.toString());
  
  const res = await apiGet<PartnerApplicationsResponse>(withQuery(`/admin/partner-applications`, Object.fromEntries(params)));
  return res;
}

export async function updatePartnerApplicationStatus(id: string, status: PartnerApplicationStatus, notes?: string): Promise<PartnerApplication> {
  return apiPatch<PartnerApplication>(`/admin/partner-applications/${id}`, { status, notes });
}