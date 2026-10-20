import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GovernanceClient } from "./GovernanceClient";
import * as governanceApi from "@/lib/governanceApi";
import * as governanceWallet from "@/lib/governanceWallet";
import * as featureFlags from "@/lib/featureFlags";

vi.mock("@/lib/featureFlags", () => ({ useFeatureFlag: vi.fn() }));
vi.mock("@/lib/governanceWallet", () => ({
  signGovernanceXdr: vi.fn(),
  describeGovernanceError: vi.fn(() => "You rejected the request in your wallet. Nothing was submitted."),
}));
vi.mock("@/lib/governanceApi", () => ({
  listProposals: vi.fn(),
  getGovernanceConfig: vi.fn(),
  prepareVote: vi.fn(),
  submitVote: vi.fn(),
  prepareProposal: vi.fn(),
  submitProposal: vi.fn(),
  finalizeProposal: vi.fn(),
  executeProposal: vi.fn(),
  explorerTxUrl: (hash: string) => `https://stellar.expert/explorer/public/tx/${hash}`,
}));

const proposal = {
  id: "p1",
  parameterKey: "late_fee_bps",
  proposedValue: "250",
  status: "active" as const,
  votesFor: 30,
  votesAgainst: 10,
  quorumVotes: 50,
  votingEndsAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
  hasVoted: false,
};

describe("GovernanceClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(featureFlags.useFeatureFlag).mockReturnValue(true);
    vi.mocked(governanceApi.listProposals).mockResolvedValue({
      proposals: [proposal],
      pagination: { total: 1, page: 1, limit: 20, totalPages: 1 },
    });
    vi.mocked(governanceApi.getGovernanceConfig).mockResolvedValue({ minStakeToPropose: 1000 });
  });

  it("shows a not-available state when the flag is off", () => {
    vi.mocked(featureFlags.useFeatureFlag).mockReturnValue(false);

    render(<GovernanceClient />);

    expect(screen.getByText("Governance is not available yet")).toBeInTheDocument();
    expect(governanceApi.listProposals).not.toHaveBeenCalled();
  });

  it("lists proposals with a for/against bar and quorum indicator", async () => {
    render(<GovernanceClient />);

    expect(await screen.findByText("late_fee_bps")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: /30 for, 10 against \(75% for\)/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/quorum 40 \/ 50/i)).toBeInTheDocument();
  });

  it("votes for a proposal: prepare, sign, submit, and link the transaction", async () => {
    vi.mocked(governanceApi.prepareVote).mockResolvedValue({ xdr: "unsigned-xdr" });
    vi.mocked(governanceWallet.signGovernanceXdr).mockResolvedValue("signed-xdr");
    vi.mocked(governanceApi.submitVote).mockResolvedValue({ txHash: "abc123" });

    render(<GovernanceClient />);
    fireEvent.click(await screen.findByRole("button", { name: /open proposal/i }));
    fireEvent.click(screen.getByRole("button", { name: /vote for/i }));

    await waitFor(() => expect(governanceApi.submitVote).toHaveBeenCalledWith("p1", "signed-xdr"));
    expect(governanceApi.prepareVote).toHaveBeenCalledWith("p1", true);
    expect(governanceWallet.signGovernanceXdr).toHaveBeenCalledWith("unsigned-xdr");

    const link = await screen.findByRole("link", { name: /view transaction/i });
    expect(link).toHaveAttribute("href", "https://stellar.expert/explorer/public/tx/abc123");
  });

  it("shows a clear message when the user rejects the wallet prompt", async () => {
    vi.mocked(governanceApi.prepareVote).mockResolvedValue({ xdr: "unsigned-xdr" });
    vi.mocked(governanceWallet.signGovernanceXdr).mockRejectedValue(new Error("User declined"));

    render(<GovernanceClient />);
    fireEvent.click(await screen.findByRole("button", { name: /open proposal/i }));
    fireEvent.click(screen.getByRole("button", { name: /vote against/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/rejected the request in your wallet/i);
    expect(governanceApi.submitVote).not.toHaveBeenCalled();
  });
});
