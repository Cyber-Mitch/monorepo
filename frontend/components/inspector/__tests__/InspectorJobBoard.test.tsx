import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InspectorJobBoard } from "../InspectorJobBoard";
import * as inspectorApi from "@/lib/inspectorApi";

vi.mock("@/lib/inspectorApi", () => ({
  listAvailableJobs: vi.fn(),
  claimJob: vi.fn(),
}));

const job = {
  id: "11111111-1111-4111-8111-111111111111",
  listingId: "22222222-2222-4222-8222-222222222222",
  listingArea: "Lagos",
  status: "available" as const,
  offeredFeeNgn: 25000,
  inspectorId: null,
  claimDeadline: null,
  submittedAt: null,
  approvedAt: null,
  rejectionReason: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

describe("InspectorJobBoard (#1921)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows an error state with a retry when the board cannot load", async () => {
    vi.mocked(inspectorApi.listAvailableJobs).mockRejectedValue(new Error("offline"));
    render(<InspectorJobBoard />);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    // The retry re-enters loading then errors again — wait for the alert to return.
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("lists jobs with area, fee and listing summary", async () => {
    vi.mocked(inspectorApi.listAvailableJobs).mockResolvedValue([job]);
    render(<InspectorJobBoard />);
    expect(await screen.findByText(/₦25,000/)).toBeInTheDocument();
    expect(screen.getByText("Lagos")).toBeInTheDocument();
    expect(screen.getByText(/listing 22222222-222…/)).toBeInTheDocument();
  });

  it("claims a job and confirms with the claim deadline", async () => {
    vi.mocked(inspectorApi.listAvailableJobs).mockResolvedValue([job]);
    vi.mocked(inspectorApi.claimJob).mockResolvedValue({
      ...job,
      status: "claimed",
      inspectorId: "me",
      claimDeadline: "2030-01-01T12:00:00.000Z",
    });
    render(<InspectorJobBoard />);
    fireEvent.click(await screen.findByRole("button", { name: "Claim job" }));

    expect(await screen.findByText("Job claimed!")).toBeInTheDocument();
    // The board refreshes after a claim — listAvailableJobs called twice.
    expect(inspectorApi.listAvailableJobs).toHaveBeenCalledTimes(2);
  });

  it("shows the race-lost message and refreshes the board when the claim is lost", async () => {
    vi.mocked(inspectorApi.listAvailableJobs).mockResolvedValue([job]);
    vi.mocked(inspectorApi.claimJob).mockRejectedValue(new Error("Inspection job was claimed by another inspector"));
    render(<InspectorJobBoard />);
    fireEvent.click(await screen.findByRole("button", { name: "Claim job" }));

    await waitFor(() =>
      expect(
        screen.getByText(
          "This job was claimed by another inspector. The board below is the up-to-date picture.",
        ),
      ).toBeInTheDocument(),
    );
    // The board is refreshed so the stale "available" row disappears.
    expect(inspectorApi.listAvailableJobs).toHaveBeenCalledTimes(2);
  });

  it("shows an empty state when no jobs are available", async () => {
    vi.mocked(inspectorApi.listAvailableJobs).mockResolvedValue([]);
    render(<InspectorJobBoard />);
    expect(await screen.findByText("No inspection jobs available")).toBeInTheDocument();
  });
});
