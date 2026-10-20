'use client';

import React from 'react';

interface SupportMessageFiltersProps {
  search: string;
  onSearchChange: (search: string) => void;
}

export function SupportMessageFilters({ search, onSearchChange }: SupportMessageFiltersProps) {
  return (
    <div className="bg-white p-4 border rounded-lg shadow-sm mb-6 flex flex-col md:flex-row gap-4 items-center justify-between">
      <div className="w-full md:w-96">
        <label htmlFor="support-search" className="block text-xs font-medium text-gray-700 mb-1">
          Search Messages
        </label>
        <input
          id="support-search"
          type="text"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Filter by name, email, or subject..."
          className="w-full border rounded-md p-2 text-sm focus:ring-indigo-500 focus:border-indigo-500"
        />
      </div>
    </div>
  );
}