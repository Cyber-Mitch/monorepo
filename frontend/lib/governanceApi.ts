import { apiGet, apiPost } from "./apiClient";

/**
 * Governance API (#1912, #1925).
 *
 * Creating a proposal and voting are two-step: `prepare` returns an unsigned
 * XDR, the user signs it in their wallet, then `submit` sends the signed XDR.
 * Finalize and execute need no user signature; the server pays the fee.
 *
 * Paths are passed to apiFetch without `/api` (see referralsApi.ts, #1878).
 */

export type ProposalStatus = "active" | "passed" | "failed" | "executed";

export interface Proposal {
  id: string;
  parameterKey: string;
  proposedValue: string;
  status: ProposalStatus;
  votesFor: number;
  votesAgainst: number;
  /** Votes needed for the proposal to reach quorum. */
  quorumVotes: number;
  /** ISO timestamp for when voting closes. */
  votingEndsAt: string;
  /** Set when the connected wallet has already voted on this proposal. */
  hasVoted?: boolean;
  /** Server-computed: the time conditions for finalize or execute are met. */
  canFinalize?: boolean;
  canExecute?: boolean;
}

export interface ProposalListResponse {
  proposals: Proposal[];
  pagination: { total: number; page: number; limit: number; totalPages: number };
}

export interface PrepareResponse {
  xdr: string;
}

export interface SubmitResponse {
  txHash: string;
}

export interface GovernanceConfig {
  /** Stake a wallet needs before it can create a proposal. */
  minStakeToPropose: number;
}

export async function listProposals(
  params: { status?: ProposalStatus | "all"; page?: number } = {},
): Promise<ProposalListResponse> {
  const search = new URLSearchParams();
  if (params.status && params.status !== "all") search.set("status", params.status);
  if (params.page != null) search.set("page", String(params.page));
  const qs = search.toString();
  return apiGet<ProposalListResponse>(`/governance/proposals${qs ? `?${qs}` : ""}`);
}

export async function getProposal(id: string): Promise<Proposal> {
  return apiGet<Proposal>(`/governance/proposals/${encodeURIComponent(id)}`);
}

export async function getGovernanceConfig(): Promise<GovernanceConfig> {
  return apiGet<GovernanceConfig>("/governance/config");
}

export async function prepareProposal(input: {
  parameterKey: string;
  proposedValue: string;
}): Promise<PrepareResponse> {
  return apiPost<PrepareResponse>("/governance/proposals/prepare", input);
}

export async function submitProposal(signedXdr: string): Promise<SubmitResponse> {
  return apiPost<SubmitResponse>("/governance/proposals/submit", { signedXdr });
}

export async function prepareVote(id: string, support: boolean): Promise<PrepareResponse> {
  return apiPost<PrepareResponse>(
    `/governance/proposals/${encodeURIComponent(id)}/vote/prepare`,
    { support },
  );
}

export async function submitVote(id: string, signedXdr: string): Promise<SubmitResponse> {
  return apiPost<SubmitResponse>(
    `/governance/proposals/${encodeURIComponent(id)}/vote/submit`,
    { signedXdr },
  );
}

export async function finalizeProposal(id: string): Promise<SubmitResponse> {
  return apiPost<SubmitResponse>(
    `/governance/proposals/${encodeURIComponent(id)}/finalize`,
    {},
  );
}

export async function executeProposal(id: string): Promise<SubmitResponse> {
  return apiPost<SubmitResponse>(
    `/governance/proposals/${encodeURIComponent(id)}/execute`,
    {},
  );
}

export function explorerTxUrl(txHash: string): string {
  return `https://stellar.expert/explorer/public/tx/${txHash}`;
}
