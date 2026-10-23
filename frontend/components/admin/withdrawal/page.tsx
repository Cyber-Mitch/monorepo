'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { privatePageMetadata } from '@/lib/seo';
import { fetchWithdrawals, approveWithdrawal, rejectWithdrawal, WithdrawalRequest, WithdrawalStatus } from '@/lib/api/withdrawals';
import { WithdrawalFilters } from '@/components/admin/WithdrawalFilters';
import { Button } from '@/components/ui/button';
import { ModalDialog } from '@/components/admin/ModalDialog';

export default function AdminWithdrawalsPage() {
  const [withdrawals, setWithdrawals] = useState<WithdrawalRequest[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('pending');
  const [page, setPage] = useState<number>(1);

  // Action modal state
  const [actionModal, setActionModal] = useState<{ type: 'approve' | 'reject'; withdrawal: WithdrawalRequest } | null>(null);
  const [rejectionReason, setRejectionReason] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);

  const loadWithdrawals = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetchWithdrawals(statusFilter, page);
      setWithdrawals(res.data);
    } catch (err: any) {
      setError(err?.message || 'Failed to load withdrawals queue.');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, page]);

  useEffect(() => {
    loadWithdrawals();
  }, [loadWithdrawals]);

  const handleConfirmAction = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!actionModal) return;

    try {
      setSubmitting(true);
      if (actionModal.type === 'approve') {
        await approveWithdrawal(actionModal.withdrawal.id);
      } else {
        if (!rejectionReason.trim()) {
          alert('Rejection reason is required.');
          return;
        }
        await rejectWithdrawal(actionModal.withdrawal.id, rejectionReason);
      }
      setActionModal(null);
      setRejectionReason('');
      await loadWithdrawals();
    } catch (err: any) {
      alert(err?.message || 'Failed to process withdrawal action.');
    } finally {
      setSubmitting(false);
    }
  };

  const getStatusBadgeClass = (status: WithdrawalStatus) => {
    switch (status) {
      case 'approved': return 'bg-green-100 text-green-800';
      case 'rejected': return 'bg-red-100 text-red-800';
      default: return 'bg-yellow-100 text-yellow-800';
    }
  };

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Withdrawals Approval Queue</h1>
        <p className="text-sm text-gray-500">Review, verify risk flags, and approve or reject user payout requests.</p>
      </div>

      <WithdrawalFilters
        statusFilter={statusFilter}
        onStatusChange={(val) => { setStatusFilter(val); setPage(1); }}
      />

      {loading && withdrawals.length === 0 ? (
        <div className="p-8 text-center text-gray-500" aria-busy="true">Loading withdrawals queue...</div>
      ) : error ? (
        <div className="p-8 text-center text-red-600 bg-red-50 rounded-lg border border-red-200" role="alert">
          Error: {error}
        </div>
      ) : (
        <div className="bg-white border rounded-lg overflow-x-auto shadow-sm">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">User</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Amount</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Bank Account</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Risk Flags</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Requested</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {withdrawals.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-12 text-center text-gray-500">
                    No withdrawal requests found for this filter.
                  </td>
                </tr>
              ) : (
                withdrawals.map((item) => (
                  <tr key={item.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap text-sm">
                      <div className="font-medium text-gray-900">{item.user.name}</div>
                      <div className="text-gray-500 text-xs">{item.user.email}</div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-semibold text-gray-900">
                      {item.currency} {item.amount.toLocaleString()}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-mono text-gray-600">
                      {item.maskedBankAccount}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm">
                      {item.riskFlags && item.riskFlags.length > 0 ? (
                        <span className="px-2 py-0.5 text-xs font-semibold rounded bg-red-100 text-red-700">
                          {item.riskFlags.join(', ')}
                        </span>
                      ) : (
                        <span className="text-gray-400 text-xs">None</span>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm">
                      <span className={`px-2.5 py-1 text-xs font-semibold rounded-full capitalize ${getStatusBadgeClass(item.status)}`}>
                        {item.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {new Date(item.requestedAt).toLocaleString()}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium space-x-2">
                      {item.status === 'pending' && (
                        <>
                          <Button variant="primary" size="sm" onClick={() => setActionModal({ type: 'approve', withdrawal: item })}>
                            Approve
                          </Button>
                          <Button variant="secondary" size="sm" className="text-red-600 border-red-200 hover:bg-red-50" onClick={() => { setActionModal({ type: 'reject', withdrawal: item }); setRejectionReason(''); }}>
                            Reject
                          </Button>
                        </>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Confirmation / Rejection Modal */}
      {actionModal && (
        <ModalDialog isOpen={!!actionModal} onClose={() => setActionModal(null)}>
          <form onSubmit={handleConfirmAction} className="p-6 max-w-md w-full space-y-4">
            <h3 className="text-lg font-bold capitalize">
              {actionModal.type} Withdrawal
            </h3>
            <p className="text-sm text-gray-600">
              User: <span className="font-semibold">{actionModal.withdrawal.user.name}</span> ({actionModal.withdrawal.currency} {actionModal.withdrawal.amount.toLocaleString()})
            </p>

            {actionModal.type === 'reject' ? (
              <div>
                <label htmlFor="rejection-reason" className="block text-xs font-medium text-gray-700 mb-1">
                  Reason for Rejection (Required)
                </label>
                <textarea
                  id="rejection-reason"
                  value={rejectionReason}
                  onChange={(e) => setRejectionReason(e.target.value)}
                  rows={3}
                  required
                  placeholder="Provide a clear reason for rejecting this payout..."
                  className="w-full border rounded-md p-2 text-sm"
                />
              </div>
            ) : (
              <p className="text-sm text-gray-500">
                Are you sure you want to approve this withdrawal request? Funds will be scheduled for transfer.
              </p>
            )}

            <div className="flex justify-end space-x-2 pt-2">
              <Button type="button" variant="secondary" onClick={() => setActionModal(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={submitting} className={actionModal.type === 'reject' ? 'bg-red-600 hover:bg-red-700 text-white' : ''}>
                {submitting ? 'Processing...' : `Confirm ${actionModal.type}`}
              </Button>
            </div>
          </form>
        </ModalDialog>
      )}
    </div>
  );
}