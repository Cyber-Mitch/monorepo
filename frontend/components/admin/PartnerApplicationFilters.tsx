'use client';

import React from 'react';
import { PartnerApplicationStatus } from '@/lib/api/partnerApplications';

interface PartnerApplicationFiltersProps {
  search: string;
  onSearchChange: (search: string) => void;
  statusFilter: string;
  onStatusChange: (status: string) => void;
}

export function PartnerApplicationFilters({
  search,
  onSearchChange,
  statusFilter,
  onStatusChange,
}: PartnerApplicationFiltersProps) {
  const statuses: { label: string; value: string }[] = [
    { label: 'All Statuses', value: 'all' },
    { label: 'Pending', value: 'pending' },
    { label: 'Contacted', value: 'contacted' },
    { label: 'Approved', value: 'approved' },
    { label: 'Rejected', value: 'rejected' },
  ];

  return (
    <div className="bg-white p-4 border rounded-lg shadow-sm mb-6 flex flex-col md:flex-row gap-4 items-center justify-between">
      <div className="w-full md:w-96">
        <label htmlFor="partner-search" className="block text-xs font-medium text-gray-700 mb-1">
          Search Applications
        </label>
        <input
          id="partner-search"
          type="text"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Filter by name, email, or phone..."
          className="w-full border rounded-md p-2 text-sm focus:ring-indigo-500 focus:border-indigo-500"
        />
      </div>
      <div className="w-full md:w-64">
        <label htmlFor="status-filter" className="block text-xs font-medium text-gray-700 mb-1">
          Filter by Status
        </label>
        <select
          id="status-filter"
          value={statusFilter}
          onChange={(e) => onStatusChange(e.target.value)}
          className="w-full border rounded-md p-2 text-sm focus:ring-indigo-500 focus:border-indigo-500 bg-white"
        >
          {statuses.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}