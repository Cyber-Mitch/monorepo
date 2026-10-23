'use client';

import React from 'react';
import type { WithdrawalStatus } from '@/lib/api/withdrawals';

/**
 * Status filter for the withdrawals approval queue.
 *
 * Restores the missing piece of ca79b2c2 (PR #2025): the admin withdrawals
 * page imports this component but the file was never added, which breaks
 * `pnpm run build` for every PR. Kept deliberately simple — a keyboard
 * accessible radio group matching the flat admin style of that page.
 */

type FilterValue = WithdrawalStatus | 'all';

const FILTERS: Array<{ value: FilterValue; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
];

interface WithdrawalFiltersProps {
  statusFilter: string;
  onStatusChange: (value: string) => void;
}

export function WithdrawalFilters({ statusFilter, onStatusChange }: WithdrawalFiltersProps) {
  const current: FilterValue = (FILTERS.some((filter) => filter.value === statusFilter)
    ? statusFilter
    : 'all') as FilterValue;

  return (
    <div className="mb-6" role="radiogroup" aria-label="Filter withdrawals by status">
      <div className="inline-flex rounded-lg border border-gray-200 bg-white p-1 shadow-sm">
        {FILTERS.map((filter) => {
          const active = current === filter.value;
          return (
            <button
              key={filter.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onStatusChange(filter.value)}
              className={`px-4 py-2 text-sm font-medium rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                active
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
              }`}
            >
              {filter.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
