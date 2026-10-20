import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ModerationClient } from "./ModerationClient";
import * as moderationApi from "@/lib/moderationApi";

vi.mock("@/lib/moderationApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/moderationApi")>();
  return {
    ...actual,
    listListingReports: vi.fn(),
    listReportedReviews: vi.fn(),
    setReviewHidden: vi.fn(),
  };
});

const pagination = { total: 1, page: 1, limit: 20, totalPages: 1 };

const report = {
  reportId: "r1",
  propertyId: "prop-9",
  propertyTitle: "12 Admiralty Way",
  category: "fraud" as const,
  details: "The photos do not match the flat.",
  createdAt: "2026-01-02T10:00:00Z",
};

const review = {
  id: "rev1",
  apartmentId: "apt1",
  rating: 2,
  content: "Misleading listing.",
  authorName: "Ada",
  isHidden: false,
  createdAt: "2026-01-03T10:00:00Z",
};

describe("ModerationClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(moderationApi.listListingReports).mockResolvedValue({
      reports: [report],
      pagination,
    });
    vi.mocked(moderationApi.listReportedReviews).mockResolvedValue({
      reviews: [review],
      pagination,
    });
  });

  it("lists listing reports with a link to the property", async () => {
    render(<ModerationClient />);

    expect(await screen.findByText("The photos do not match the flat.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "12 Admiralty Way" })).toHaveAttribute(
      "href",
      "/properties/prop-9",
    );
  });

  it("shows the reported reviews tab and hides a review", async () => {
    vi.mocked(moderationApi.setReviewHidden).mockResolvedValue(undefined);

    render(<ModerationClient />);
    fireEvent.mouseDown(screen.getByRole("tab", { name: /reported reviews/i }));
    fireEvent.click(screen.getByRole("tab", { name: /reported reviews/i }));

    fireEvent.click(await screen.findByRole("button", { name: /hide review/i }));

    await waitFor(() =>
      expect(moderationApi.setReviewHidden).toHaveBeenCalledWith("rev1", true),
    );
  });

  it("shows an access denied state for a 403 response", async () => {
    vi.mocked(moderationApi.listListingReports).mockRejectedValue(
      Object.assign(new Error("Forbidden"), { status: 403 }),
    );

    render(<ModerationClient />);

    expect(await screen.findByText("Access denied")).toBeInTheDocument();
  });

  it("shows an error state with retry for other failures", async () => {
    vi.mocked(moderationApi.listListingReports)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ reports: [report], pagination });

    render(<ModerationClient />);
    fireEvent.click(await screen.findByRole("button", { name: /try again/i }));

    expect(await screen.findByText("The photos do not match the flat.")).toBeInTheDocument();
  });
});
