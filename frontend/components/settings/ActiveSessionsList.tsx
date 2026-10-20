'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { fetchSessions, revokeSession, revokeOtherSessions, SessionItem } from '@/lib/api/sessions';
import { Button } from '@/components/ui/Button';

export function ActiveSessionsList() {
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchSessions();
      setSessions(data);
    } catch (err: any) {
      setError(err?.message || 'Failed to load active sessions.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const handleRevoke = async (session: SessionItem) => {
    const confirmMsg = session.isCurrent 
      ? 'Revoking your current session will log you out immediately. Continue?' 
      : 'Are you sure you want to revoke this session?';
    
    if (!window.confirm(confirmMsg)) return;

    try {
      setActionLoadingId(session.id);
      await revokeSession(session.id);
      if (session.isCurrent) {
        window.location.href = '/login';
        return;
      }
      await loadSessions();
    } catch (err: any) {
      alert(`Failed to revoke session: ${err?.message || 'Unknown error'}`);
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleRevokeOthers = async () => {
    if (!window.confirm('Are you sure you want to log out of all other sessions everywhere else?')) return;

    try {
      setActionLoadingId('others');
      await revokeOtherSessions();
      await loadSessions();
    } catch (err: any) {
      alert(`Failed to revoke other sessions: ${err?.message || 'Unknown error'}`);
    } finally {
      setActionLoadingId(null);
    }
  };

  if (loading && sessions.length === 0) {
    return <div className="p-4 text-center text-sm text-gray-500" aria-busy="true">Loading active sessions...</div>;
  }

  if (error) {
    return <div className="p-4 text-center text-sm text-red-600" role="alert">Error: {error}</div>;
  }

  return (
    <div className="bg-white border rounded-lg p-6 shadow-sm space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h3 className="text-lg font-bold">Active Sessions</h3>
          <p className="text-sm text-gray-500">Manage your active login sessions across different devices and browsers.</p>
        </div>
        {sessions.length > 1 && (
          <Button 
            onClick={handleRevokeOthers} 
            disabled={actionLoadingId === 'others'} 
            variant="destructive"
            size="sm"
          >
            {actionLoadingId === 'others' ? 'Logging out...' : 'Log Out All Other Sessions'}
          </Button>
        )}
      </div>

      <div className="divide-y divide-gray-200">
        {sessions.length === 0 ? (
          <p className="py-4 text-sm text-gray-500 text-center">No active sessions found.</p>
        ) : (
          sessions.map((session) => (
            <div key={session.id} className="py-4 flex justify-between items-center">
              <div>
                <div className="flex items-center space-x-2">
                  <span className="font-medium text-sm text-gray-900">{session.device}</span>
                  {session.isCurrent && (
                    <span className="px-2 py-0.5 text-xs font-semibold bg-green-100 text-green-800 rounded-full">
                      This Device
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-500 mt-0.5">
                  {session.location ? `${session.location} • ` : ''}Last active: {new Date(session.lastActive).toLocaleString()}
                </p>
              </div>
              <Button 
                onClick={() => handleRevoke(session)} 
                disabled={actionLoadingId === session.id}
                variant="secondary"
                size="sm"
              >
                {actionLoadingId === session.id ? 'Revoking...' : session.isCurrent ? 'Log Out' : 'Revoke'}
              </Button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}