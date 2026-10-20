'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { privatePageMetadata } from '@/lib/seo';
import { 
  fetchFraudAssessments, 
  fetchActiveHolds, 
  releaseHold, 
  toggleFraudSignal,
  FraudAssessment, 
  ActiveHold 
} from '@/lib/api/fraud';
import { releaseHoldSchema, ReleaseHoldFormValues } from '@/schemas/fraud';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';

export default function AdminFraudReviewPage() {
  const [activeTab, setActiveTab] = useState<'assessments' | 'holds'>('assessments');
  const [assessments, setAssessments] = useState<FraudAssessment[]>([]);
  const [holds, setHolds] = useState<ActiveHold[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [decisionFilter, setDecisionFilter] = useState<string>('');

  // Release hold modal state
  const [selectedHold, setSelectedHold] = useState<ActiveHold | null>(null);
  const [isReleaseModalOpen, setIsReleaseModalOpen] = useState<boolean>(false);

  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<ReleaseHoldFormValues>({
    resolver: zodResolver(releaseHoldSchema),
  });

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [assessmentsRes, holdsRes] = await Promise.all([
        fetchFraudAssessments({ decision: decisionFilter || undefined }),
        fetchActiveHolds(),
      ]);
      setAssessments(assessmentsRes);
      setHolds(holdsRes);
    } catch (err: any) {
      setError(err?.message || 'Failed to load fraud review data.');
    } finally {
      setLoading(false);
    }
  }, [decisionFilter]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleOpenReleaseModal = (hold: ActiveHold) => {
    setSelectedHold(hold);
    reset({ reason: '' });
    setIsReleaseModalOpen(true);
  };

  const onSubmitRelease = async (data: ReleaseHoldFormValues) => {
    if (!selectedHold) return;
    try {
      await releaseHold(selectedHold.id, data.reason);
      setIsReleaseModalOpen(false);
      setSelectedHold(null);
      await loadData();
    } catch (err: any) {
      alert(`Failed to release hold: ${err?.message || 'Unknown error'}`);
    }
  };

  const handleToggleSignal = async (signalId: string, currentState: boolean) => {
    if (!window.confirm(`Are you sure you want to ${currentState ? 'disable' : 'enable'} this signal?`)) return;
    try {
      await toggleFraudSignal(signalId, !currentState);
      await loadData();
    } catch (err: any) {
      alert(`Failed to toggle signal: ${err?.message || 'Unknown error'}`);
    }
  };

  if (loading && assessments.length === 0 && holds.length === 0) {
    return <div className="p-8 text-center" aria-busy="true">Loading fraud review queue...</div>;
  }

  if (error) {
    return <div className="p-8 text-center text-red-600" role="alert">Error: {error}</div>;
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold">Admin Fraud Review Queue</h1>
          <p className="text-sm text-gray-500">Monitor risk assessments, inspect triggered signals, and manage active financial holds.</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b mb-6">
        <button
          onClick={() => setActiveTab('assessments')}
          className={`py-2 px-4 font-medium text-sm border-b-2 ${
            activeTab === 'assessments' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Assessments ({assessments.length})
        </button>
        <button
          onClick={() => setActiveTab('holds')}
          className={`py-2 px-4 font-medium text-sm border-b-2 ${
            activeTab === 'holds' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Active Holds ({holds.length})
        </button>
      </div>

      {/* Assessments Tab Content */}
      {activeTab === 'assessments' && (
        <div>
          {/* Filters */}
          <div className="flex gap-4 mb-6 items-center bg-gray-50 p-4 rounded-lg">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Decision Filter</label>
              <select 
                value={decisionFilter} 
                onChange={(e) => setDecisionFilter(e.target.value)}
                className="border rounded-md px-3 py-1.5 text-sm"
              >
                <option value="">All Decisions</option>
                <option value="APPROVE">Approve</option>
                <option value="REVIEW">Review</option>
                <option value="BLOCK">Block</option>
              </select>
            </div>
          </div>

          <div className="bg-white border rounded-lg overflow-x-auto shadow-sm">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Account</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Score</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Decision</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Signals Fired</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Date</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {assessments.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-8 text-center text-gray-500">No fraud assessments found.</td>
                  </tr>
                ) : (
                  assessments.map((item) => (
                    <tr key={item.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{item.account}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-bold text-gray-700">{item.score}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm">
                        <span className={`px-2 py-1 text-xs font-semibold rounded-full ${
                          item.decision === 'BLOCK' ? 'bg-red-100 text-red-800' :
                          item.decision === 'REVIEW' ? 'bg-yellow-100 text-yellow-800' : 'bg-green-100 text-green-800'
                        }`}>
                          {item.decision}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-500">
                        {item.signalsFired.join(', ') || 'None'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{new Date(item.createdAt).toLocaleString()}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Active Holds Tab Content */}
      {activeTab === 'holds' && (
        <div className="bg-white border rounded-lg overflow-x-auto shadow-sm">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Account</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Amount</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Reason</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Age</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {holds.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-8 text-center text-gray-500">No active holds found.</td>
                </tr>
              ) : (
                holds.map((hold) => (
                  <tr key={hold.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{hold.account}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{hold.amount}</td>
                    <td className="px-6 py-4 text-sm text-gray-500">{hold.reason}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{hold.age}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      <button 
                        onClick={() => handleOpenReleaseModal(hold)}
                        className="text-red-600 hover:text-red-900 font-semibold"
                      >
                        Release Hold
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Release Hold Modal */}
      {isReleaseModalOpen && selectedHold && (
        <Dialog isOpen={isReleaseModalOpen} onClose={() => setIsReleaseModalOpen(false)}>
          <div className="p-6">
            <h3 className="text-lg font-bold mb-4">Release Hold for Account {selectedHold.account}</h3>
            <form onSubmit={handleSubmit(onSubmitRelease)}>
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-1">Mandatory Release Reason</label>
                <textarea 
                  {...register('reason')} 
                  rows={4}
                  className="w-full border rounded-md p-2 text-sm"
                  placeholder="Provide detailed justification (minimum 10 characters)..."
                />
                {errors.reason && <p className="text-xs text-red-600 mt-1">{errors.reason.message}</p>}
              </div>
              <div className="flex justify-end space-x-2">
                <Button type="button" variant="secondary" onClick={() => setIsReleaseModalOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={isSubmitting}>Confirm Release</Button>
              </div>
            </form>
          </div>
        </Dialog>
      )}
    </div>
  );
}