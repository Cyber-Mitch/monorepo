'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { privatePageMetadata } from '@/lib/seo';
import { 
  fetchAgingSummary, 
  fetchMismatches, 
  closeMismatch, 
  runReconciliation, 
  fetchEventDrilldown,
  AgingSummary, 
  MismatchItem, 
  ReconciliationRunResult,
  EventSideBySide 
} from '@/lib/api/reconciliation';
import { closeMismatchSchema, CloseMismatchFormValues } from '@/schemas/reconciliation';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';

export default function AdminReconciliationPage() {
  const [aging, setAging] = useState<AgingSummary | null>(null);
  const [mismatches, setMismatches] = useState<MismatchItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState<string>('OPEN');
  const [classFilter, setClassFilter] = useState<string>('');

  // Run reconciliation state
  const [running, setRunning] = useState<boolean>(false);
  const [runResult, setRunResult] = useState<ReconciliationRunResult | null>(null);

  // Close mismatch modal state
  const [selectedMismatch, setSelectedMismatch] = useState<MismatchItem | null>(null);
  const [isCloseModalOpen, setIsCloseModalOpen] = useState<boolean>(false);

  // Drilldown state
  const [drilldownData, setDrilldownData] = useState<EventSideBySide | null>(null);
  const [isDrilldownOpen, setIsDrilldownOpen] = useState<boolean>(false);

  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<CloseMismatchFormValues>({
    resolver: zodResolver(closeMismatchSchema),
  });

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [agingRes, mismatchesRes] = await Promise.all([
        fetchAgingSummary(),
        fetchMismatches({ status: statusFilter || undefined, class: classFilter || undefined }),
      ]);
      setAging(agingRes);
      setMismatches(mismatchesRes);
    } catch (err: any) {
      setError(err?.message || 'Failed to load reconciliation data.');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, classFilter]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleRunReconciliation = async () => {
    if (!window.confirm('Are you sure you want to run reconciliation now?')) return;
    try {
      setRunning(true);
      const result = await runReconciliation();
      setRunResult(result);
      await loadData();
    } catch (err: any) {
      alert(`Reconciliation run failed: ${err?.message || 'Unknown error'}`);
    } finally {
      setRunning(false);
    }
  };

  const handleOpenCloseModal = (mismatch: MismatchItem) => {
    setSelectedMismatch(mismatch);
    reset({ reason: '' });
    setIsCloseModalOpen(true);
  };

  const onSubmitClose = async (data: CloseMismatchFormValues) => {
    if (!selectedMismatch) return;
    try {
      await closeMismatch(selectedMismatch.id, data.reason);
      setIsCloseModalOpen(false);
      setSelectedMismatch(null);
      await loadData();
    } catch (err: any) {
      alert(`Failed to close mismatch: ${err?.message || 'Unknown error'}`);
    }
  };

  const handleOpenDrilldown = async (id: string) => {
    try {
      const data = await fetchEventDrilldown(id);
      setDrilldownData(data);
      setIsDrilldownOpen(true);
    } catch (err: any) {
      alert(`Failed to load event drilldown: ${err?.message || 'Unknown error'}`);
    }
  };

  if (loading && !aging) {
    return <div className="p-8 text-center" aria-busy="true">Loading reconciliation data...</div>;
  }

  if (error) {
    return <div className="p-8 text-center text-red-600" role="alert">Error: {error}</div>;
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold">Admin Ledger Reconciliation</h1>
          <p className="text-sm text-gray-500">Monitor discrepancies, aging summaries, and execute reconciliation runs.</p>
        </div>
        <Button onClick={handleRunReconciliation} disabled={running}>
          {running ? 'Running Reconciliation...' : 'Run Reconciliation Now'}
        </Button>
      </div>

      {runResult && (
        <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-md">
          <h3 className="font-semibold text-green-800">Reconciliation Run Complete</h3>
          <p className="text-sm text-green-700">Run ID: {runResult.runId} | Processed: {runResult.processedCount} | Mismatches Found: {runResult.mismatchesFound}</p>
        </div>
      )}

      {/* Aging Summary Cards */}
      {aging && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <div className="p-4 bg-white border rounded-lg shadow-sm">
            <span className="text-sm text-gray-500">Total Mismatches</span>
            <p className="text-2xl font-bold">{aging.totalMismatches}</p>
          </div>
          <div className="p-4 bg-white border rounded-lg shadow-sm">
            <span className="text-sm text-gray-500">0 - 7 Days</span>
            <p className="text-2xl font-bold text-blue-600">{aging.aging0to7Days}</p>
          </div>
          <div className="p-4 bg-white border rounded-lg shadow-sm">
            <span className="text-sm text-gray-500">8 - 30 Days</span>
            <p className="text-2xl font-bold text-yellow-600">{aging.aging8to30Days}</p>
          </div>
          <div className="p-4 bg-white border rounded-lg shadow-sm">
            <span className="text-sm text-gray-500">30+ Days</span>
            <p className="text-2xl font-bold text-red-600">{aging.aging30PlusDays}</p>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-4 mb-6 items-center bg-gray-50 p-4 rounded-lg">
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Status Filter</label>
          <select 
            value={statusFilter} 
            onChange={(e) => setStatusFilter(e.target.value)}
            className="border rounded-md px-3 py-1.5 text-sm"
          >
            <option value="">All Statuses</option>
            <option value="OPEN">Open</option>
            <option value="RESOLVED">Resolved</option>
            <option value="CLOSED">Closed</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Class Filter</label>
          <input 
            type="text" 
            placeholder="e.g. deposit, conversion" 
            value={classFilter}
            onChange={(e) => setClassFilter(e.target.value)}
            className="border rounded-md px-3 py-1.5 text-sm"
          />
        </div>
      </div>

      {/* Mismatch Table */}
      <div className="bg-white border rounded-lg overflow-x-auto shadow-sm">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Class</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Amount</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Age</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Attempts</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {mismatches.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-6 py-8 text-center text-gray-500">No reconciliation mismatches found.</td>
              </tr>
            ) : (
              mismatches.map((item) => (
                <tr key={item.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{item.class}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{item.amount}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{item.age}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{item.attempts}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm">
                    <span className={`px-2 py-1 text-xs font-semibold rounded-full ${
                      item.status === 'OPEN' ? 'bg-red-100 text-red-800' : 'bg-green-100 text-green-800'
                    }`}>
                      {item.status}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium space-x-2">
                    <button 
                      onClick={() => handleOpenDrilldown(item.id)}
                      className="text-indigo-600 hover:text-indigo-900"
                    >
                      Inspect Events
                    </button>
                    {item.status === 'OPEN' && (
                      <button 
                        onClick={() => handleOpenCloseModal(item)}
                        className="text-red-600 hover:text-red-900"
                      >
                        Close
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Close Modal */}
      {isCloseModalOpen && selectedMismatch && (
        <Dialog isOpen={isCloseModalOpen} onClose={() => setIsCloseModalOpen(false)}>
          <div className="p-6">
            <h3 className="text-lg font-bold mb-4">Close Mismatch #{selectedMismatch.id}</h3>
            <form onSubmit={handleSubmit(onSubmitClose)}>
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-1">Mandatory Closing Reason</label>
                <textarea 
                  {...register('reason')} 
                  rows={4}
                  className="w-full border rounded-md p-2 text-sm"
                  placeholder="Provide detailed justification (minimum 10 characters)..."
                />
                {errors.reason && <p className="text-xs text-red-600 mt-1">{errors.reason.message}</p>}
              </div>
              <div className="flex justify-end space-x-2">
                <Button type="button" variant="secondary" onClick={() => setIsCloseModalOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={isSubmitting}>Confirm Close</Button>
              </div>
            </form>
          </div>
        </Dialog>
      )}

      {/* Side-by-Side Event Drilldown Modal */}
      {isDrilldownOpen && drilldownData && (
        <Dialog isOpen={isDrilldownOpen} onClose={() => setIsDrilldownOpen(false)}>
          <div className="p-6 max-w-4xl w-full">
            <h3 className="text-lg font-bold mb-4">Side-by-Side Event Comparison</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-gray-50 p-4 rounded-md border">
                <h4 className="font-semibold text-sm text-gray-700 mb-2">Ledger Event</h4>
                <pre className="text-xs overflow-x-auto bg-white p-2 border rounded">
                  {JSON.stringify(drilldownData.ledgerEvent, null, 2)}
                </pre>
              </div>
              <div className="bg-gray-50 p-4 rounded-md border">
                <h4 className="font-semibold text-sm text-gray-700 mb-2">Provider Event</h4>
                <pre className="text-xs overflow-x-auto bg-white p-2 border rounded">
                  {JSON.stringify(drilldownData.providerEvent, null, 2)}
                </pre>
              </div>
            </div>
            <div className="mt-6 flex justify-end">
              <Button onClick={() => setIsDrilldownOpen(false)}>Close</Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}