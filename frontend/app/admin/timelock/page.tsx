'use client';

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { privatePageMetadata } from '@/lib/seo';
import { 
  getTimelockTransactions, 
  executeTimelockTransaction, 
  cancelTimelockTransaction,
  TimelockTransaction 
} from '@/lib/timelockApi';
import { Button } from '@/components/ui/Button';

export default function AdminTimelockPage() {
  const [transactions, setTransactions] = useState<TimelockTransaction[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
  const [txHashes, setTxHashes] = useState<Record<string, string>>({});

  // Countdown timer ticker
  const [, setTick] = useState<number>(0);
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  const loadTransactions = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getTimelockTransactions();
      setTransactions(data);
    } catch (err: any) {
      setError(err?.message || 'Failed to load timelock queue transactions.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTransactions();
  }, [loadTransactions]);

  const handleExecute = async (id: string) => {
    try {
      setActionLoadingId(id);
      const result = await executeTimelockTransaction(id);
      if (result?.txHash) {
        setTxHashes((prev) => ({ ...prev, [id]: result.txHash }));
      }
      await loadTransactions();
    } catch (err: any) {
      alert(`Execution failed: ${err?.message || 'Too early or transaction expired'}`);
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleCancel = async (id: string) => {
    if (!window.confirm('Are you sure you want to cancel this queued timelock transaction?')) return;
    try {
      setActionLoadingId(id);
      await cancelTimelockTransaction(id);
      await loadTransactions();
    } catch (err: any) {
      alert(`Cancellation failed: ${err?.message || 'Unknown error'}`);
    } finally {
      setActionLoadingId(null);
    }
  };

  if (loading && transactions.length === 0) {
    return <div className="p-8 text-center" aria-busy="true">Loading timelock queue...</div>;
  }

  if (error) {
    return <div className="p-8 text-center text-red-600" role="alert">Error: {error}</div>;
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold">Admin Timelock Queue</h1>
          <p className="text-sm text-gray-500">Manage queued governance and administrative transactions awaiting timelock release.</p>
        </div>
        <Button onClick={loadTransactions} variant="secondary">Refresh Queue</Button>
      </div>

      <div className="bg-white border rounded-lg overflow-x-auto shadow-sm">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Target</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Function</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Arguments</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">ETA Countdown</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {transactions.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-6 py-8 text-center text-gray-500">No queued timelock transactions found.</td>
              </tr>
            ) : (
              transactions.map((tx) => {
                const etaTime = new Date(tx.eta).getTime();
                const now = Date.now();
                const timeLeft = etaTime - now;
                const isReady = timeLeft <= 0 && tx.status === 'QUEUED';

                let countdownText = '';
                if (timeLeft > 0) {
                  const hours = Math.floor(timeLeft / (1000 * 60 * 60));
                  const minutes = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
                  const seconds = Math.floor((timeLeft % (1000 * 60)) / 1000);
                  countdownText = `${hours}h ${minutes}m ${seconds}s`;
                } else {
                  countdownText = 'Ready for Execution';
                }

                return (
                  <tr key={tx.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-mono text-gray-900">{tx.target}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-800">{tx.functionName}</td>
                    <td className="px-6 py-4 text-sm font-mono text-gray-500 max-w-xs truncate">{JSON.stringify(tx.args)}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm">
                      <span className={isReady ? 'text-green-600 font-semibold' : 'text-amber-600'}>
                        {countdownText}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm">
                      <span className={`px-2 py-1 text-xs font-semibold rounded-full ${
                        tx.status === 'QUEUED' ? 'bg-blue-100 text-blue-800' :
                        tx.status === 'EXECUTED' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                      }`}>
                        {tx.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium space-x-2">
                      {tx.status === 'QUEUED' && (
                        <>
                          <Button 
                            onClick={() => handleExecute(tx.id)} 
                            disabled={!isReady || actionLoadingId === tx.id}
                            size="sm"
                          >
                            {actionLoadingId === tx.id ? 'Executing...' : 'Execute'}
                          </Button>
                          <Button 
                            onClick={() => handleCancel(tx.id)} 
                            disabled={actionLoadingId === tx.id}
                            variant="secondary"
                            size="sm"
                          >
                            Cancel
                          </Button>
                        </>
                      )}
                      {txHashes[tx.id] && (
                        <a 
                          href={`https://stellar.expert/explorer/public/tx/${txHashes[tx.id]}`} 
                          target="_blank" 
                          rel="noreferrer"
                          className="text-indigo-600 hover:underline block text-xs mt-1"
                        >
                          View Tx on Explorer ↗
                        </a>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}