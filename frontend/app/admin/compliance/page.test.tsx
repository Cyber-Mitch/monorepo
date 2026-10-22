/**
 * Component tests for the admin compliance reports page (#1982).
 *
 * Acceptance criteria covered:
 *  - Loading / empty / error / 403 states for the reports table
 *  - Form validation (required fields, date ordering, max 90-day range)
 *  - Generate flow (success → list refresh, server error banner)
 *  - Download action (downloadComplianceReport called on completed report)
 *  - Verify action (hash-match and hash-mismatch results rendered)
 *  - Polling (interval started while a report is pending; stops when settled)
 *
 * Interaction pattern: userEvent is the repo convention (login tests, etc.) and
 * correctly triggers RHF submit + zod refinements. fireEvent.change is used
 * only for the native <select> and <input type="date"> whose submit path was
 * independently confirmed to work with userEvent.click.
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ComplianceReportsClient,
  COMPLIANCE_REPORT_POLL_INTERVAL_MS,
} from "./ComplianceReportsClient";
import {
  listComplianceReports,
  generateComplianceReport,
  downloadComplianceReport,
  verifyComplianceReport,
} from "@/lib/complianceReportsApi";

/* ── Module mocks ─────────────────────────────────────────────────────────── */

vi.mock("@/lib/complianceReportsApi", () => ({
  ApiError: class ApiError extends Error {
    constructor(
      message: string,
      public status: number,
    ) {
      super(message);
    }
  },
  listComplianceReports: vi.fn(),
  generateComplianceReport: vi.fn(),
  downloadComplianceReport: vi.fn(),
  verifyComplianceReport: vi.fn(),
}));

vi.mock("@/lib/toast", () => ({
  showSuccessToast: vi.fn(),
  showErrorToast: vi.fn(),
}));

/* ── Fixture data ─────────────────────────────────────────────────────────── */

const pendingReport = {
  id: "rpt-1",
  type: "transactions" as const,
  status: "pending" as const,
  startDate: "2026-01-01",
  endDate: "2026-01-31",
  createdBy: "admin",
  createdAt: "2026-02-01T10:00:00Z",
};

const completedReport = {
  ...pendingReport,
  id: "rpt-2",
  status: "completed" as const,
  completedAt: "2026-02-01T10:05:00Z",
  fileUrl: "https://cdn.example.com/report-rpt-2.csv",
  sha256: "abc123def456",
};

const failedReport = {
  ...pendingReport,
  id: "rpt-3",
  status: "failed" as const,
  errorMessage: "Database timeout",
};

const verifyMatch = {
  id: "rpt-2",
  match: true,
  expectedHash: "abc123def456",
  actualHash: "abc123def456",
  verifiedAt: "2026-02-01T11:00:00Z",
};

const verifyMismatch = {
  ...verifyMatch,
  match: false,
  actualHash: "000000000000",
};

/* ── Setup ────────────────────────────────────────────────────────────────── */

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listComplianceReports).mockResolvedValue([]);
  vi.mocked(generateComplianceReport).mockResolvedValue(pendingReport);
  vi.mocked(downloadComplianceReport).mockReturnValue(undefined);
  vi.mocked(verifyComplianceReport).mockResolvedValue(verifyMatch);
});

afterEach(() => {
  vi.useRealTimers();
});

/* ── Helpers ──────────────────────────────────────────────────────────────── */

/** Wait for the initial list fetch to settle. */
async function waitForLoad() {
  // Either the empty state or actual rows will appear when loading is done.
  await screen.findByRole("button", { name: /^refresh$/i });
}

/**
 * Fill the generate form and submit it via userEvent (matches repo convention).
 * `type` must match one of the <option value>s.
 */
async function submitGenerateForm(
  user: ReturnType<typeof userEvent.setup>,
  { type, startDate, endDate }: { type: string; startDate: string; endDate: string },
) {
  // Native <select> — fireEvent is reliable here because we're not going
  // through RHF's onBlur; we call setValue directly in the component.
  fireEvent.change(screen.getByLabelText(/report type/i), {
    target: { value: type },
  });
  // Date inputs registered through RHF register() respond to fireEvent.change.
  fireEvent.change(screen.getByLabelText(/start date/i), {
    target: { value: startDate },
  });
  fireEvent.change(screen.getByLabelText(/end date/i), {
    target: { value: endDate },
  });
  // userEvent.click triggers RHF handleSubmit + validation correctly.
  await user.click(screen.getByRole("button", { name: "Generate report" }));
}

/* ── Tests: table states ───────────────────────────────────────────────────── */

describe("ComplianceReportsClient — table states", () => {
  it("shows loading skeletons on initial fetch", () => {
    vi.mocked(listComplianceReports).mockReturnValue(new Promise(() => {}));
    render(<ComplianceReportsClient />);
    expect(screen.getByText("Loading compliance reports")).toBeDefined();
  });

  it("shows the empty state when no reports exist", async () => {
    render(<ComplianceReportsClient />);
    expect(await screen.findByText("No compliance reports yet")).toBeDefined();
  });

  it("shows the error state with a retry button when the list fails", async () => {
    vi.mocked(listComplianceReports).mockRejectedValue(new Error("Network error"));
    render(<ComplianceReportsClient />);
    await screen.findByText("Compliance reports are unavailable");
    expect(screen.getByRole("button", { name: /try again/i })).toBeDefined();
  });

  it("shows an access-denied error for 403", async () => {
    const { ApiError } = await import("@/lib/complianceReportsApi");
    vi.mocked(listComplianceReports).mockRejectedValue(
      new (ApiError as unknown as new (m: string, s: number) => Error)("Forbidden", 403),
    );
    render(<ComplianceReportsClient />);
    await screen.findByText("Access denied");
  });

  it("renders reports in the table", async () => {
    vi.mocked(listComplianceReports).mockResolvedValue([completedReport, failedReport]);
    render(<ComplianceReportsClient />);
    // Scope to the table element to avoid matching <option> text
    const table = await screen.findByRole("table");
    const cells = within(table).getAllByText("Transactions");
    expect(cells).toHaveLength(2);
    expect(within(table).getByText("Completed")).toBeDefined();
    expect(within(table).getByText("Failed")).toBeDefined();
  });
});

/* ── Tests: generate form validation ──────────────────────────────────────── */

describe("ComplianceReportsClient — form validation", () => {
  it("blocks submit when required date fields are empty", async () => {
    const user = userEvent.setup();
    render(<ComplianceReportsClient />);
    await waitForLoad();

    await user.click(screen.getByRole("button", { name: "Generate report" }));

    await screen.findByText("Start date is required");
    expect(screen.getByText("End date is required")).toBeDefined();
    expect(generateComplianceReport).not.toHaveBeenCalled();
  });

  it("shows a type-required error when type is not selected", async () => {
    const user = userEvent.setup();
    render(<ComplianceReportsClient />);
    await waitForLoad();

    // Fill dates only — leave type empty
    fireEvent.change(screen.getByLabelText(/start date/i), {
      target: { value: "2026-01-01" },
    });
    fireEvent.change(screen.getByLabelText(/end date/i), {
      target: { value: "2026-01-31" },
    });
    await user.click(screen.getByRole("button", { name: "Generate report" }));

    // Query the error by its id to avoid matching the placeholder <option>
    await waitFor(() => {
      const errorEl = document.getElementById("compliance-type-error");
      expect(errorEl).not.toBeNull();
      expect(errorEl?.textContent).toContain("Select a report type");
    });
    expect(generateComplianceReport).not.toHaveBeenCalled();
  });

  it("rejects an end date before the start date", async () => {
    const user = userEvent.setup();
    render(<ComplianceReportsClient />);
    await waitForLoad();

    // Select type first so zod's base validation passes and refinements run.
    fireEvent.change(screen.getByLabelText(/report type/i), {
      target: { value: "transactions" },
    });
    fireEvent.change(screen.getByLabelText(/start date/i), {
      target: { value: "2026-01-31" },
    });
    fireEvent.change(screen.getByLabelText(/end date/i), {
      target: { value: "2026-01-01" },
    });
    await user.click(screen.getByRole("button", { name: "Generate report" }));

    await screen.findByText("End date must be on or after the start date");
    expect(generateComplianceReport).not.toHaveBeenCalled();
  });

  it("rejects a date range exceeding the 90-day maximum", async () => {
    const user = userEvent.setup();
    render(<ComplianceReportsClient />);
    await waitForLoad();

    fireEvent.change(screen.getByLabelText(/report type/i), {
      target: { value: "transactions" },
    });
    fireEvent.change(screen.getByLabelText(/start date/i), {
      target: { value: "2026-01-01" },
    });
    fireEvent.change(screen.getByLabelText(/end date/i), {
      target: { value: "2026-05-01" },
    });
    await user.click(screen.getByRole("button", { name: "Generate report" }));

    await screen.findByText("Date range cannot exceed 90 days");
    expect(generateComplianceReport).not.toHaveBeenCalled();
  });
});

/* ── Tests: generate flow ──────────────────────────────────────────────────── */

describe("ComplianceReportsClient — generate", () => {
  it("calls generateComplianceReport and refreshes the list on success", async () => {
    const user = userEvent.setup();
    vi.mocked(listComplianceReports)
      .mockResolvedValueOnce([])          // initial load → empty
      .mockResolvedValueOnce([pendingReport]); // refresh after generate

    render(<ComplianceReportsClient />);
    await waitForLoad();

    await submitGenerateForm(user, {
      type: "transactions",
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });

    await waitFor(() =>
      expect(generateComplianceReport).toHaveBeenCalledWith({
        type: "transactions",
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      }),
    );
    // After success the list refreshes and the pending row appears
    expect(await screen.findByText("Pending")).toBeDefined();
  });

  it("shows a server error banner when generation fails", async () => {
    const user = userEvent.setup();
    vi.mocked(generateComplianceReport).mockRejectedValue(
      new Error("Internal server error"),
    );

    render(<ComplianceReportsClient />);
    await waitForLoad();

    await submitGenerateForm(user, {
      type: "kyc",
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });

    await waitFor(() => expect(generateComplianceReport).toHaveBeenCalled());
    // Root server error banner must appear
    expect(await screen.findByRole("alert")).toBeDefined();
  });
});

/* ── Tests: download ───────────────────────────────────────────────────────── */

describe("ComplianceReportsClient — download", () => {
  it("calls downloadComplianceReport for a completed report", async () => {
    const user = userEvent.setup();
    vi.mocked(listComplianceReports).mockResolvedValue([completedReport]);
    render(<ComplianceReportsClient />);
    await screen.findByText("Completed");

    await user.click(
      screen.getByRole("button", { name: /download transactions report/i }),
    );
    expect(downloadComplianceReport).toHaveBeenCalledWith(completedReport);
  });

  it("disables Download for pending reports", async () => {
    vi.mocked(listComplianceReports).mockResolvedValue([pendingReport]);
    render(<ComplianceReportsClient />);
    await screen.findByText("Pending");

    const btn = screen.getByRole("button", {
      name: /download transactions report/i,
    });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });
});

/* ── Tests: verify ────────────────────────────────────────────────────────── */

describe("ComplianceReportsClient — verify", () => {
  it("renders a hash-match result after Verify is clicked", async () => {
    const user = userEvent.setup();
    vi.mocked(listComplianceReports).mockResolvedValue([completedReport]);
    render(<ComplianceReportsClient />);
    await screen.findByText("Completed");

    await user.click(
      screen.getByRole("button", { name: /verify transactions report/i }),
    );

    await screen.findByText("Hash verified — file integrity confirmed");
    expect(
      screen.getByText(`Expected: ${verifyMatch.expectedHash}`),
    ).toBeDefined();
    expect(
      screen.getByText(`Actual: ${verifyMatch.actualHash}`),
    ).toBeDefined();
  });

  it("renders a hash-mismatch result when hashes differ", async () => {
    const user = userEvent.setup();
    vi.mocked(listComplianceReports).mockResolvedValue([completedReport]);
    vi.mocked(verifyComplianceReport).mockResolvedValue(verifyMismatch);
    render(<ComplianceReportsClient />);
    await screen.findByText("Completed");

    await user.click(
      screen.getByRole("button", { name: /verify transactions report/i }),
    );

    await screen.findByText("Hash mismatch — the file may have been tampered with");
    expect(
      screen.getByText(`Actual: ${verifyMismatch.actualHash}`),
    ).toBeDefined();
  });
});

/* ── Tests: polling ───────────────────────────────────────────────────────── */

describe("ComplianceReportsClient — polling", () => {
  it("starts polling while a report is pending", async () => {
    vi.useFakeTimers();
    vi.mocked(listComplianceReports)
      .mockResolvedValueOnce([pendingReport])
      .mockResolvedValue([completedReport]);

    render(<ComplianceReportsClient />);

    // Flush the initial load effect (microtasks + first resolved promise)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const callsAfterLoad = vi.mocked(listComplianceReports).mock.calls.length;
    expect(callsAfterLoad).toBeGreaterThanOrEqual(1);

    // Advance exactly one poll interval — the interval must have fired once
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COMPLIANCE_REPORT_POLL_INTERVAL_MS + 100);
    });

    expect(vi.mocked(listComplianceReports).mock.calls.length).toBeGreaterThan(
      callsAfterLoad,
    );
  });

  it("stops polling once all reports are settled", async () => {
    vi.useFakeTimers();
    vi.mocked(listComplianceReports).mockResolvedValue([completedReport]);

    render(<ComplianceReportsClient />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const before = vi.mocked(listComplianceReports).mock.calls.length;

    // Advance several poll intervals — nothing is pending so no extra calls
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COMPLIANCE_REPORT_POLL_INTERVAL_MS * 3);
    });

    expect(vi.mocked(listComplianceReports).mock.calls.length).toBe(before);
  });
});
