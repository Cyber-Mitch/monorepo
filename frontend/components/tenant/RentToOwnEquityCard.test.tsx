import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RentToOwnEquityCard } from "./RentToOwnEquityCard";
import type {
  RentToOwnEquity,
  RentToOwnOnChainStatus,
} from "@/lib/rentToOwnApi";

const CONTRACT_ID = "CCRENTTOOWNCONTRACTID";

function makeEquity(onChain: Partial<RentToOwnOnChainStatus>): RentToOwnEquity {
  return {
    dealId: "deal-1",
    equityPercentageBps: 1250,
    equityAccumulatedUsdc: "12500.000000",
    propertyValueUsdc: "100000.000000",
    paymentsRecorded: 6,
    paymentsRequired: 48,
    projectedCompletionDate: "2030-04-01",
    onChain: {
      status: "consistent",
      contractId: CONTRACT_ID,
      network: "testnet",
      onChainEquityUsdc: "12500.000000",
      checkedAt: "2026-10-20T12:00:00Z",
      ...onChain,
    },
  };
}

describe("RentToOwnEquityCard", () => {
  it("shows equity, payments and projected completion", () => {
    render(<RentToOwnEquityCard equity={makeEquity({})} />);

    expect(
      screen.getByRole("heading", { name: "Your equity" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("equity-percentage")).toHaveTextContent("12.50%");
    expect(screen.getByTestId("payments-recorded")).toHaveTextContent(
      "6 of 48",
    );
    expect(screen.getByTestId("projected-completion")).not.toHaveTextContent(
      "Not yet projected",
    );
    expect(
      screen.getByRole("progressbar", { name: /equity owned: 12\.50%/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("progressbar", { name: "6 of 48 payments recorded" }),
    ).toBeInTheDocument();
  });

  it("shows a verified badge linking to the contract on Stellar Expert when consistent", () => {
    render(
      <RentToOwnEquityCard equity={makeEquity({ status: "consistent" })} />,
    );

    const link = screen.getByRole("link", { name: /verified on-chain/i });
    expect(link).toHaveAttribute(
      "href",
      `https://stellar.expert/explorer/testnet/contract/${CONTRACT_ID}`,
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByTestId("onchain-unavailable")).not.toBeInTheDocument();
  });

  it("shows the badge without a link when the contract id is unknown", () => {
    render(
      <RentToOwnEquityCard
        equity={makeEquity({ status: "consistent", contractId: null })}
      />,
    );

    expect(screen.getByText("Verified on-chain")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("warns clearly and never shows the verified badge on a mismatch", () => {
    render(
      <RentToOwnEquityCard
        equity={makeEquity({
          status: "mismatch",
          onChainEquityUsdc: "10000.000000",
        })}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/could not be verified on-chain/i);
    expect(screen.queryByText("Verified on-chain")).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /view contract on stellar expert/i }),
    ).toHaveAttribute(
      "href",
      `https://stellar.expert/explorer/testnet/contract/${CONTRACT_ID}`,
    );
  });

  it("explains when on-chain verification is unavailable", () => {
    render(
      <RentToOwnEquityCard
        equity={makeEquity({
          status: "unavailable",
          onChainEquityUsdc: null,
          checkedAt: null,
        })}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      /on-chain verification is temporarily unavailable/i,
    );
    expect(screen.queryByText("Verified on-chain")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // Figures from Shelterflex records are still shown.
    expect(screen.getByTestId("equity-percentage")).toHaveTextContent("12.50%");
  });

  it("does not invent an amount the server did not send", () => {
    render(
      <RentToOwnEquityCard
        equity={{ ...makeEquity({}), equityAccumulatedUsdc: "not-a-number" }}
      />,
    );

    expect(screen.getAllByText("Amount unavailable").length).toBeGreaterThan(0);
  });
});
