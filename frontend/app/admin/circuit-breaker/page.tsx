'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { privatePageMetadata } from '@/lib/seo';
import { 
  fetchCircuitBreakerStatus, 
  freezeEscrow, 
  proposeDrain, 
  executeDrain, 
  setRecoveryDelay,
  CircuitBreakerStatus 
} from '@/lib/api/circuitBreaker';
import { 
  proposeDrainSchema, 
  freezeSchema, 
  recoveryDelaySchema,
  ProposeDrainFormValues, 
  FreezeFormValues, 
  RecoveryDelayFormValues 
} from '@/schemas/circuitBreaker';
import { Button } from '@/components/ui/button';
import { ModalDialog as Dialog } from '@/components/admin/ModalDialog';

export default function AdminCircuitBreakerPage() {
  const [status, setStatus] = useState<CircuitBreakerStatus | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<boolean>(false);
  const [lastTxHash, setLastTxHash] = useState<string | null>(null);

  // Modals
  const [isFreezeModalOpen, setIsFreezeModalOpen] = useState<boolean>(false);
  const [isDrainModalOpen, setIsDrainModalOpen] = useState<boolean>(false);
  const [isDelayModalOpen, setIsDelayModalOpen] = useState<boolean>(false);

  // Forms
  const freezeForm = useForm<FreezeFormValues>({ resolver: zodResolver(freezeSchema) });
  const drainForm = useForm<ProposeDrainFormValues>({ resolver: zodResolver(proposeDrainSchema) });
  const delayForm = useForm<RecoveryDelayFormValues>({ resolver: zodResolver(recoveryDelaySchema) });

  const loadStatus = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchCircuitBreakerStatus();
      setStatus(data);
    } catch (err: any) {
      setError(err?.message || 'Failed to load circuit-breaker status.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const handleFreezeSubmit = async (data: FreezeFormValues) => {
    try {
      setActionLoading(true);
      const res = await freezeEscrow();
      setLastTxHash(res.txHash);
      setIsFreezeModalOpen(false);
      freezeForm.reset();
      await loadStatus();
    } catch (err: any) {
      alert(`Freeze failed: ${err?.message || 'Unknown error'}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleDrainSubmit = async (data: ProposeDrainFormValues) => {
    try {
      setActionLoading(true);
      const res = await proposeDrain(data.destinationAddress);
      setLastTxHash(res.txHash);
      setIsDrainModalOpen(false);
      drainForm.reset();
      await loadStatus();
    } catch (err: any) {
      alert(`Propose drain failed: ${err?.message || 'Unknown error'}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleExecuteDrain = async () => {
    if (!window.confirm('Are you sure you want to execute the escrow drain now?')) return;
    try {
      setActionLoading(true);
      const res = await executeDrain();
      setLastTxHash(res.txHash);
      await loadStatus();
    } catch (err: any) {
      alert(`Execute drain failed: ${err?.message || 'Delay has not elapsed or unauthorized'}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleDelaySubmit = async (data: RecoveryDelayFormValues) => {
    try {
      setActionLoading(true);
      const res = await setRecoveryDelay(data.recoveryDelaySeconds);
      setLastTxHash(res.txHash);
      setIsDelayModalOpen(false);
      delayForm.reset();
      await loadStatus();
    } catch (err: any) {
      alert(`Set recovery delay failed: ${err?.message || 'Unknown error'}`);
    } finally {
      setActionLoading(false);
    }
  };

  if (loading && !status) {
    return <div className="p-8 text-center" aria-busy="true">Loading circuit-breaker status...</div>;
  }

  if (error) {
    return <div className="p-8 text-center text-red-600" role="alert">Error: {error}</div>;
  }

  const isDrainExecutable = status?.drainExecutableAt 
    ? new Date().getTime() >= new Date(status.drainExecutableAt).getTime() 
    : false;

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold">Admin Escrow Circuit-Breaker</h1>
          <p className="text-sm text-gray-500">Emergency controls, freeze status, drainage proposals, and recovery delay governance.</p>
        </div>
        <div className="space-x-2">
          <Link href="/admin/audit-logs">
            <Button variant="secondary">View Audit Trail →</Button>
          </Link>
          <Button onClick={loadStatus} variant="secondary">Refresh Status</Button>
        </div>
      </div>

      {lastTxHash && (
        <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-md flex justify-between items-center">
          <div>
            <h3 className="font-semibold text-green-800">Action Successful</h3>
            <p className="text-xs text-green-700 font-mono">TxHash: {lastTxHash}</p>
          </div>
          <a 
            href={`https://stellar.expert/explorer/public/tx/${lastTxHash}`} 
            target="_blank" 
            rel="noreferrer"
            className="text-indigo-600 hover:underline text-sm font-medium"
          >
            View on Stellar Explorer ↗
          </a>
        </div>
      )}

      {/* Status Card */}
      {status && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <div className="p-4 bg-white border rounded-lg shadow-sm">
            <span className="text-sm text-gray-500">Escrow Frozen Status</span>
            <p className={`text-xl font-bold mt-1 ${status.isFrozen ? 'text-red-600' : 'text-green-600'}`}>
              {status.isFrozen ? 'FROZEN ❄️' : 'ACTIVE / NORMAL'}
            </p>
          </div>
          <div className="p-4 bg-white border rounded-lg shadow-sm">
            <span className="text-sm text-gray-500">Drain Proposed</span>
            <p className="text-xl font-bold mt-1">{status.drainProposed ? 'Yes' : 'No'}</p>
          </div>
          <div className="p-4 bg-white border rounded-lg shadow-sm">
            <span className="text-sm text-gray-500">Recovery Delay</span>
            <p className="text-xl font-bold mt-1">{status.recoveryDelaySeconds} seconds</p>
          </div>
          <div className="p-4 bg-white border rounded-lg shadow-sm">
            <span className="text-sm text-gray-500">Drain Executable At</span>
            <p className="text-sm font-semibold mt-1">
              {status.drainExecutableAt ? new Date(status.drainExecutableAt).toLocaleString() : 'Not Scheduled'}
            </p>
          </div>
        </div>
      )}

      {status?.drainProposed && (
        <div className="mb-8 p-4 bg-amber-50 border border-amber-200 rounded-md">
          <h3 className="font-semibold text-amber-800 mb-1">Drain Destination:</h3>
          <p className="font-mono text-xs text-amber-900 mb-3">{status.destinationAddress}</p>
          <p className="text-xs text-amber-700 mb-4">
            {isDrainExecutable ? 'Recovery delay has elapsed. Drainage execution is now permitted.' : 'Recovery delay is still active. Execution is disabled until the ETA passes.'}
          </p>
          <Button 
            onClick={handleExecuteDrain} 
            disabled={!isDrainExecutable || actionLoading}
            variant="destructive"
          >
            {actionLoading ? 'Executing Drain...' : 'Execute Escrow Drain Now'}
          </Button>
        </div>
      )}

      {/* Actions Toolbar */}
      <div className="bg-white border rounded-lg p-6 shadow-sm space-y-4">
        <h3 className="text-lg font-bold">Circuit-Breaker Emergency Controls</h3>
        <div className="flex flex-wrap gap-4">
          {!status?.isFrozen && (
            <Button onClick={() => setIsFreezeModalOpen(true)} variant="destructive">
              Freeze Escrow
            </Button>
          )}
          <Button onClick={() => setIsDrainModalOpen(true)} variant="secondary">
            Propose Escrow Drain
          </Button>
          <Button onClick={() => setIsDelayModalOpen(true)} variant="secondary">
            Set Recovery Delay
          </Button>
        </div>
      </div>

      {/* Freeze Confirmation Modal */}
      {isFreezeModalOpen && (
        <Dialog isOpen={isFreezeModalOpen} onClose={() => setIsFreezeModalOpen(false)}>
          <div className="p-6">
            <h3 className="text-lg font-bold text-red-600 mb-2">Emergency Freeze Escrow</h3>
            <p className="text-sm text-gray-600 mb-4">This will immediately halt all escrow activity. Type <strong>FREEZE</strong> to confirm.</p>
            <form onSubmit={freezeForm.handleSubmit(handleFreezeSubmit)}>
              <div className="mb-4">
                <input 
                  {...freezeForm.register('confirmKeyword')}
                  placeholder="Type FREEZE"
                  className="w-full border rounded-md p-2 text-sm font-mono uppercase"
                />
                {freezeForm.formState.errors.confirmKeyword && (
                  <p className="text-xs text-red-600 mt-1">{freezeForm.formState.errors.confirmKeyword.message}</p>
                )}
              </div>
              <div className="flex justify-end space-x-2">
                <Button type="button" variant="secondary" onClick={() => setIsFreezeModalOpen(false)}>Cancel</Button>
                <Button type="submit" variant="destructive" disabled={actionLoading}>Confirm Freeze</Button>
              </div>
            </form>
          </div>
        </Dialog>
      )}

      {/* Propose Drain Modal */}
      {isDrainModalOpen && (
        <Dialog isOpen={isDrainModalOpen} onClose={() => setIsDrainModalOpen(false)}>
          <div className="p-6">
            <h3 className="text-lg font-bold mb-2">Propose Escrow Drain</h3>
            <p className="text-sm text-gray-600 mb-4">Provide the safe destination address and type <strong>DRAIN</strong> to confirm.</p>
            <form onSubmit={drainForm.handleSubmit(handleDrainSubmit)}>
              <div className="mb-3">
                <label className="block text-xs font-medium text-gray-700 mb-1">Destination Stellar Address</label>
                <input 
                  {...drainForm.register('destinationAddress')}
                  placeholder="G..."
                  className="w-full border rounded-md p-2 text-sm font-mono"
                />
                {drainForm.formState.errors.destinationAddress && (
                  <p className="text-xs text-red-600 mt-1">{drainForm.formState.errors.destinationAddress.message}</p>
                )}
              </div>
              <div className="mb-4">
                <label className="block text-xs font-medium text-gray-700 mb-1">Confirmation Keyword</label>
                <input 
                  {...drainForm.register('confirmKeyword')}
                  placeholder="Type DRAIN"
                  className="w-full border rounded-md p-2 text-sm font-mono uppercase"
                />
                {drainForm.formState.errors.confirmKeyword && (
                  <p className="text-xs text-red-600 mt-1">{drainForm.formState.errors.confirmKeyword.message}</p>
                )}
              </div>
              <div className="flex justify-end space-x-2">
                <Button type="button" variant="secondary" onClick={() => setIsDrainModalOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={actionLoading}>Submit Drain Proposal</Button>
              </div>
            </form>
          </div>
        </Dialog>
      )}

      {/* Set Recovery Delay Modal */}
      {isDelayModalOpen && (
        <Dialog isOpen={isDelayModalOpen} onClose={() => setIsDelayModalOpen(false)}>
          <div className="p-6">
            <h3 className="text-lg font-bold mb-2">Configure Recovery Delay</h3>
            <p className="text-sm text-gray-600 mb-4">Set the mandatory timelock delay (in seconds) before a proposed drain can be executed.</p>
            <form onSubmit={delayForm.handleSubmit(handleDelaySubmit)}>
              <div className="mb-4">
                <label className="block text-xs font-medium text-gray-700 mb-1">Delay (seconds)</label>
                <input 
                  type="number"
                  {...delayForm.register('recoveryDelaySeconds')}
                  className="w-full border rounded-md p-2 text-sm"
                />
                {delayForm.formState.errors.recoveryDelaySeconds && (
                  <p className="text-xs text-red-600 mt-1">{delayForm.formState.errors.recoveryDelaySeconds.message}</p>
                )}
              </div>
              <div className="flex justify-end space-x-2">
                <Button type="button" variant="secondary" onClick={() => setIsDelayModalOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={actionLoading}>Update Delay</Button>
              </div>
            </form>
          </div>
        </Dialog>
      )}
    </div>
  );
}