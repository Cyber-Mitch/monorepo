import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AdminQuotaPage from "./page";
import {
  createQuotaOverride,
  fetchQuotaOverrides,
  fetchQuotaStats,
  fetchQuotaUsage,
  resetQuota,
} from "@/lib/quotaAdminApi";

vi.mock("@/lib/quotaAdminApi", () => ({
  fetchQuotaStats: vi.fn(),
  fetchQuotaUsage: vi.fn(),
  fetchQuotaOverrides: vi.fn(),
  createQuotaOverride: vi.fn(),
  removeQuotaOverride: vi.fn(),
  resetQuota: vi.fn(),
}));

vi.mock("@/lib/toast", () => ({
  showSuccessToast: vi.fn(),
  showErrorToast: vi.fn(),
}));

const usage = {
  userId: "user-1",
  endpoint: "/api/properties",
  minuteUsage: 3,
  dayUsage: 40,
  minuteLimit: 10,
  dayLimit: 500,
  minuteReset: 0,
  dayReset: 0,
  nearLimit: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchQuotaStats).mockResolvedValue({ totalOverrides: 4, activeOverrides: 2 });
  vi.mocked(fetchQuotaUsage).mockResolvedValue(usage);
  vi.mocked(fetchQuotaOverrides).mockResolvedValue([]);
  vi.mocked(createQuotaOverride).mockResolvedValue({
    success: true,
    override: {
      userId: "user-1",
      elevatedLimit: 25,
      reason: "partner upgrade",
      createdBy: "admin",
      createdAt: 0,
    },
  });
  vi.mocked(resetQuota).mockResolvedValue({ success: true });
});

async function lookUpUser(userId = "user-1") {
  fireEvent.change(screen.getByLabelText(/user id/i), { target: { value: userId } });
  fireEvent.click(screen.getByRole("button", { name: /look up/i }));
  await screen.findByText("Current usage");
}

describe("AdminQuotaPage", () => {
  it("shows the stats header from fetchQuotaStats", async () => {
    render(<AdminQuotaPage />);

    expect(await screen.findByText("Total overrides")).toBeTruthy();
    expect(screen.getByText("4")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
  });

  it("looks up a user's usage and overrides", async () => {
    render(<AdminQuotaPage />);

    await lookUpUser();

    expect(fetchQuotaUsage).toHaveBeenCalledWith("user-1", undefined);
    expect(fetchQuotaOverrides).toHaveBeenCalledWith("user-1");
    expect(screen.getByText("/api/properties")).toBeTruthy();
  });

  it("creates an override for the looked-up user", async () => {
    render(<AdminQuotaPage />);
    await lookUpUser();

    fireEvent.change(screen.getByLabelText(/elevated limit/i), { target: { value: "25" } });
    fireEvent.change(screen.getByLabelText(/^reason/i), { target: { value: "partner upgrade" } });
    fireEvent.click(screen.getByRole("button", { name: /create override/i }));

    await waitFor(() =>
      expect(createQuotaOverride).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "user-1", elevatedLimit: 25, reason: "partner upgrade" }),
      ),
    );
  });

  it("requires confirmation before resetting usage", async () => {
    render(<AdminQuotaPage />);
    await lookUpUser();

    fireEvent.click(screen.getByRole("button", { name: /reset usage/i }));
    const dialog = await screen.findByRole("alertdialog");
    expect(resetQuota).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: /reset usage/i }));

    await waitFor(() => expect(resetQuota).toHaveBeenCalledWith("user-1", undefined));
  });
});
