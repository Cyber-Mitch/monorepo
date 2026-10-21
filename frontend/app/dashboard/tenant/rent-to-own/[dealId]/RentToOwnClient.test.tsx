import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RentToOwnClient } from "./RentToOwnClient";
import * as rentToOwnApi from "@/lib/rentToOwnApi";
import { ApiError } from "@/lib/apiClient";
import { useFeatureFlag } from "@/lib/featureFlags";

vi.mock("@/lib/rentToOwnApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rentToOwnApi")>()),
  getRentToOwnEquity: vi.fn(),
}));

vi.mock("@/lib/featureFlags", () => ({
  useFeatureFlag: vi.fn(),
}));

vi.mock("@/components/dashboard-header", () => ({
  DashboardHeader: () => null,
}));

vi.mock("@/components/dashboard/DashboardSidebar", () => ({
  DashboardSidebar: () => null,
}));

const equity: rentToOwnApi.RentToOwnEquity = {
  dealId: "deal-1",
  equityPercentageBps: 2500,
  equityAccumulatedUsdc: "25000.000000",
  propertyValueUsdc: "100000.000000",
  paymentsRecorded: 12,
  paymentsRequired: 48,
  projectedCompletionDate: "2029-10-01",
  onChain: {
    status: "consistent",
    contractId: "CCONTRACT",
    network: "public",
    onChainEquityUsdc: "25000.000000",
    checkedAt: "2026-10-20T12:00:00Z",
  },
};

describe("RentToOwnClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useFeatureFlag).mockReturnValue(true);
  });

  it("renders nothing from the API when the feature flag is off", () => {
    vi.mocked(useFeatureFlag).mockReturnValue(false);

    render(<RentToOwnClient dealId="deal-1" />);

    expect(
      screen.getByText(/rent-to-own isn't available yet/i),
    ).toBeInTheDocument();
    expect(rentToOwnApi.getRentToOwnEquity).not.toHaveBeenCalled();
  });

  it("loads and shows the deal's equity", async () => {
    vi.mocked(rentToOwnApi.getRentToOwnEquity).mockResolvedValue({
      success: true,
      data: equity,
    });

    render(<RentToOwnClient dealId="deal-1" />);

    expect(screen.getByRole("status")).toHaveTextContent(
      /loading your equity/i,
    );
    expect(await screen.findByTestId("equity-percentage")).toHaveTextContent(
      "25%",
    );
    expect(rentToOwnApi.getRentToOwnEquity).toHaveBeenCalledWith("deal-1");
    expect(
      screen.getByRole("link", { name: /verified on-chain/i }),
    ).toHaveAttribute(
      "href",
      "https://stellar.expert/explorer/public/contract/CCONTRACT",
    );
  });

  it("shows an empty state when the deal is not rent-to-own", async () => {
    vi.mocked(rentToOwnApi.getRentToOwnEquity).mockRejectedValue(
      new ApiError({ message: "Not found", status: 404 }),
    );

    render(<RentToOwnClient dealId="deal-1" />);

    expect(
      await screen.findByText(/no rent-to-own deal found/i),
    ).toBeInTheDocument();
  });

  it("shows an error with a working retry", async () => {
    vi.mocked(rentToOwnApi.getRentToOwnEquity)
      .mockRejectedValueOnce(new Error("Network down"))
      .mockResolvedValueOnce({ success: true, data: equity });

    render(<RentToOwnClient dealId="deal-1" />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Network down");
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByTestId("equity-percentage")).toHaveTextContent(
      "25%",
    );
    expect(rentToOwnApi.getRentToOwnEquity).toHaveBeenCalledTimes(2);
  });
});
