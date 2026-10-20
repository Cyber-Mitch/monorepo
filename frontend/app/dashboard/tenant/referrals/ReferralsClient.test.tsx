import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ReferralsClient } from "./ReferralsClient";
import * as referralsApi from "@/lib/referralsApi";

vi.mock("@/lib/referralsApi", () => ({
  getMyReferrals: vi.fn(),
  getMyReferralConversions: vi.fn(),
}));

const summary = {
  code: "ABC123",
  shareUrl: "https://shelterflex.test/signup?ref=ABC123",
  stats: { referredCount: 4, creditedCount: 2, pendingRewardTotal: 5000 },
};

const emptyConversions = {
  conversions: [],
  pagination: { total: 0, page: 1, limit: 10, totalPages: 1 },
};

describe("ReferralsClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("shows the code, stats and conversions", async () => {
    vi.mocked(referralsApi.getMyReferrals).mockResolvedValue(summary);
    vi.mocked(referralsApi.getMyReferralConversions).mockResolvedValue({
      conversions: [
        { id: "c1", referredName: "J. D.", status: "credited", createdAt: "2026-01-02T00:00:00Z" },
      ],
      pagination: { total: 1, page: 1, limit: 10, totalPages: 1 },
    });

    render(<ReferralsClient />);

    expect(await screen.findByTestId("referral-code")).toHaveTextContent("ABC123");
    expect(screen.getByText("J. D.")).toBeInTheDocument();
    expect(screen.getByText("Credited")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
  });

  it("copies the code and confirms it to the user", async () => {
    vi.mocked(referralsApi.getMyReferrals).mockResolvedValue(summary);
    vi.mocked(referralsApi.getMyReferralConversions).mockResolvedValue(emptyConversions);

    render(<ReferralsClient />);
    fireEvent.click(await screen.findByRole("button", { name: /copy code/i }));

    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("ABC123"),
    );
    expect(await screen.findByRole("button", { name: /copied/i })).toBeInTheDocument();
  });

  it("retries the summary request from the error state", async () => {
    vi.mocked(referralsApi.getMyReferrals)
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(summary);
    vi.mocked(referralsApi.getMyReferralConversions).mockResolvedValue(emptyConversions);

    render(<ReferralsClient />);
    fireEvent.click(await screen.findByRole("button", { name: /try again/i }));

    expect(await screen.findByTestId("referral-code")).toHaveTextContent("ABC123");
    expect(referralsApi.getMyReferrals).toHaveBeenCalledTimes(2);
  });

  it("shows the empty state when nobody has been referred yet", async () => {
    vi.mocked(referralsApi.getMyReferrals).mockResolvedValue(summary);
    vi.mocked(referralsApi.getMyReferralConversions).mockResolvedValue(emptyConversions);

    render(<ReferralsClient />);

    expect(await screen.findByText("No referrals yet")).toBeInTheDocument();
  });
});
