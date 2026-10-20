import { apiGet, apiPost } from '@/lib/apiClient';

export interface CircuitBreakerStatus {
  isFrozen: boolean;
  drainProposed: boolean;
  destinationAddress?: string;
  recoveryDelaySeconds: number;
  drainExecutableAt?: string;
}

export interface CircuitBreakerActionResult {
  success: boolean;
  txHash: string;
  message: string;
}

interface StatusResponse {
  frozen: boolean;
  state: {
    frozen: boolean;
    drainProposed: boolean;
    drainDestination?: string;
    recoveryDelay: number;
  };
}

const BASE = '/api/v1/admin/circuit-breaker';

export async function fetchCircuitBreakerStatus(): Promise<CircuitBreakerStatus> {
  const res = await apiGet<StatusResponse>(`${BASE}/status`);
  return {
    isFrozen: res.frozen,
    drainProposed: res.state.drainProposed,
    destinationAddress: res.state.drainDestination,
    recoveryDelaySeconds: res.state.recoveryDelay,
  };
}

export async function freezeEscrow(): Promise<CircuitBreakerActionResult> {
  return apiPost<CircuitBreakerActionResult>(`${BASE}/freeze`, {});
}

export async function proposeDrain(destination: string, drainHash?: string): Promise<CircuitBreakerActionResult> {
  return apiPost<CircuitBreakerActionResult>(`${BASE}/propose-drain`, { destination, drainHash });
}

export async function executeDrain(drainHash?: string): Promise<CircuitBreakerActionResult> {
  return apiPost<CircuitBreakerActionResult>(`${BASE}/execute-drain`, { drainHash });
}

export async function setRecoveryDelay(delaySeconds: number): Promise<CircuitBreakerActionResult> {
  return apiPost<CircuitBreakerActionResult>(`${BASE}/set-recovery-delay`, { delaySeconds });
}
