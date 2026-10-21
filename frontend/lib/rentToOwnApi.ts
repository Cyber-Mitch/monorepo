/**
 * Rent-to-Own API Client
 * Reads a tenant's accumulated equity on an existing rent-to-own deal (#1970).
 */

import { apiGet } from "./apiClient";

/**
 * Outcome of comparing the backend's equity ledger with the rent_to_own
 * contract's own state:
 * - `consistent`  — both agree; the figure can be shown as verified on-chain.
 * - `mismatch`    — they disagree; the figure must not be presented as verified.
 * - `unavailable` — the contract could not be read (RPC down, not yet registered).
 */
export type OnChainConsistencyStatus =
  "consistent" | "mismatch" | "unavailable";

export type StellarNetwork = "public" | "testnet";

export interface RentToOwnOnChainStatus {
  status: OnChainConsistencyStatus;
  /** rent_to_own contract id (C…); null when not known. */
  contractId: string | null;
  network: StellarNetwork;
  /** Equity the contract itself reports, in USDC; null when unavailable. */
  onChainEquityUsdc: string | null;
  /** ISO timestamp of the comparison; null when it never ran. */
  checkedAt: string | null;
}

export interface RentToOwnEquity {
  dealId: string;
  /** Equity as basis points of the property value (0-10000). */
  equityPercentageBps: number;
  /** Equity accumulated so far, in USDC (decimal string). */
  equityAccumulatedUsdc: string;
  /** Property value — the equity cap — in USDC (decimal string). */
  propertyValueUsdc: string;
  /** Equity payments confirmed so far. */
  paymentsRecorded: number;
  /** Equity payments the deal requires to complete. */
  paymentsRequired: number;
  /** ISO date the deal is projected to complete; null if it cannot be projected. */
  projectedCompletionDate: string | null;
  onChain: RentToOwnOnChainStatus;
}

export async function getRentToOwnEquity(
  dealId: string,
): Promise<{ success: boolean; data: RentToOwnEquity }> {
  return apiGet<{ success: boolean; data: RentToOwnEquity }>(
    `/api/deals/${encodeURIComponent(dealId)}/rent-to-own/equity`,
  );
}

/** Stellar Expert link for a contract, or null when there is no contract id. */
export function stellarExplorerContractUrl(
  contractId: string | null,
  network: StellarNetwork,
): string | null {
  if (!contractId) return null;
  return `https://stellar.expert/explorer/${network}/contract/${encodeURIComponent(contractId)}`;
}
