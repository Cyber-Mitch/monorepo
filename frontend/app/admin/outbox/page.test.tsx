import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AdminOutboxPage from "./page";
import {
  bulkRetryDeadLetters,
  dismissDeadLetterItem,
  fetchDeadLetterItems,
  retryDeadLetterItem,
} from "@/lib/outboxAdminApi";

vi.mock("@/lib/outboxAdminApi", () => ({
  fetchDeadLetterItems: vi.fn(),
  retryDeadLetterItem: vi.fn(),
  bulkRetryDeadLetters: vi.fn(),
  dismissDeadLetterItem: vi.fn(),
}));

vi.mock("@/lib/toast", () => ({
  showSuccessToast: vi.fn(),
  showErrorToast: vi.fn(),
}));

const item = {
  id: "dl-1",
  eventType: "receipt",
  txType: "payment",
  payload: { amount: 100 },
  failureReason: "rpc timeout",
  retryCount: 5,
  createdAt: new Date().toISOString(),
  lastAttemptedAt: new Date().toISOString(),
};

const page = (items: typeof item[]) => ({
  items,
  pagination: { page: 1, pageSize: 20, total: items.length, totalPages: 1 },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchDeadLetterItems).mockResolvedValue(page([item]));
  vi.mocked(retryDeadLetterItem).mockResolvedValue({ success: true, message: "Re-queued" });
  vi.mocked(dismissDeadLetterItem).mockResolvedValue({ success: true, message: "Dismissed" });
  vi.mocked(bulkRetryDeadLetters).mockResolvedValue({ success: true, reQueued: 3, message: "ok" });
});

describe("AdminOutboxPage", () => {
  it("lists dead-letter items", async () => {
    render(<AdminOutboxPage />);

    expect(await screen.findByText("rpc timeout")).toBeTruthy();
    expect(screen.getByText("receipt")).toBeTruthy();
    expect(fetchDeadLetterItems).toHaveBeenCalledWith(expect.objectContaining({ page: 1 }));
  });

  it("shows the empty state when nothing is stuck", async () => {
    vi.mocked(fetchDeadLetterItems).mockResolvedValue(page([]));

    render(<AdminOutboxPage />);

    expect(await screen.findByText("No failed items 🎉")).toBeTruthy();
  });

  it("applies an event-type filter", async () => {
    render(<AdminOutboxPage />);
    await screen.findByText("rpc timeout");

    fireEvent.change(screen.getByLabelText(/event type/i), { target: { value: "receipt" } });
    fireEvent.click(screen.getByRole("button", { name: /^apply$/i }));

    await waitFor(() =>
      expect(fetchDeadLetterItems).toHaveBeenLastCalledWith(
        expect.objectContaining({ eventType: "receipt", page: 1 }),
      ),
    );
  });

  it("retries a single item", async () => {
    render(<AdminOutboxPage />);
    await screen.findByText("rpc timeout");

    fireEvent.click(screen.getByRole("button", { name: "Retry dl-1" }));

    await waitFor(() => expect(retryDeadLetterItem).toHaveBeenCalledWith("dl-1"));
  });

  it("dismisses an item only after confirmation", async () => {
    render(<AdminOutboxPage />);
    await screen.findByText("rpc timeout");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss dl-1" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dismissDeadLetterItem).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: /dismiss item/i }));

    await waitFor(() => expect(dismissDeadLetterItem).toHaveBeenCalledWith("dl-1"));
  });

  it("bulk retries the filtered event type after confirmation", async () => {
    render(<AdminOutboxPage />);
    await screen.findByText("rpc timeout");

    fireEvent.change(screen.getByLabelText(/event type/i), { target: { value: "receipt" } });
    fireEvent.click(screen.getByRole("button", { name: /^apply$/i }));
    await waitFor(() => expect(fetchDeadLetterItems).toHaveBeenCalledTimes(2));

    fireEvent.click(await screen.findByRole("button", { name: /retry all "receipt"/i }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^retry all$/i }));

    await waitFor(() => expect(bulkRetryDeadLetters).toHaveBeenCalledWith("receipt"));
  });

  it("expands a row to show the payload", async () => {
    render(<AdminOutboxPage />);
    await screen.findByText("rpc timeout");

    fireEvent.click(screen.getByRole("button", { name: /show details for dl-1/i }));

    expect(await screen.findByText(/"amount": 100/)).toBeTruthy();
  });
});
