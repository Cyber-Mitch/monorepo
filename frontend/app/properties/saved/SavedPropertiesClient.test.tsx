import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SavedPropertiesClient from "./SavedPropertiesClient";
import { isAuthenticated } from "@/lib/auth";
import { listPublicListings, type PropertyListing } from "@/lib/propertiesApi";
import { fetchSavedListingIds, setListingSaved } from "@/lib/savedPropertiesApi";

const { replaceMock } = vi.hoisted(() => ({ replaceMock: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/properties/saved",
}));

vi.mock("@/lib/auth", () => ({
  isAuthenticated: vi.fn(),
}));

vi.mock("@/lib/propertiesApi", () => ({
  listPublicListings: vi.fn(),
}));

vi.mock("@/lib/savedPropertiesApi", () => ({
  fetchSavedListingIds: vi.fn(),
  setListingSaved: vi.fn(),
}));

vi.mock("@/lib/toast", () => ({
  showSuccessToast: vi.fn(),
  showErrorToast: vi.fn(),
}));

function listing(listingId: string, address: string): PropertyListing {
  return {
    listingId,
    whistleblowerId: "wb-1",
    address,
    area: "Lekki",
    city: "Lagos",
    bedrooms: 2,
    bathrooms: 2,
    annualRentNgn: 1_000_000,
    outrightPriceNgn: 50_000_000,
    photos: [],
    status: "active",
    createdAt: "",
    updatedAt: "",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isAuthenticated).mockResolvedValue(true);
  vi.mocked(fetchSavedListingIds).mockResolvedValue(["L1"]);
  vi.mocked(listPublicListings).mockResolvedValue({
    success: true,
    data: [listing("L1", "12 Admiralty Way")],
    total: 1,
    page: 1,
    pageSize: 1,
    totalPages: 1,
  });
  vi.mocked(setListingSaved).mockResolvedValue(undefined);
});

describe("SavedPropertiesClient", () => {
  it("renders the saved listings in saved order", async () => {
    render(<SavedPropertiesClient />);

    expect(await screen.findByText("12 Admiralty Way")).toBeTruthy();
    expect(listPublicListings).toHaveBeenCalledWith(
      expect.objectContaining({ listingIds: ["L1"] }),
    );
  });

  it("removes the card when unsaved", async () => {
    render(<SavedPropertiesClient />);
    await screen.findByText("12 Admiralty Way");

    fireEvent.click(screen.getByRole("button", { name: /saved: 12 admiralty way/i }));

    await waitFor(() => expect(setListingSaved).toHaveBeenCalledWith("L1", false));
    expect(await screen.findByText("No saved properties yet")).toBeTruthy();
  });

  it("restores the card when unsaving fails", async () => {
    vi.mocked(setListingSaved).mockRejectedValue(new Error("network down"));
    render(<SavedPropertiesClient />);
    await screen.findByText("12 Admiralty Way");

    fireEvent.click(screen.getByRole("button", { name: /saved: 12 admiralty way/i }));

    await waitFor(() => expect(setListingSaved).toHaveBeenCalledWith("L1", false));
    expect(await screen.findByText("12 Admiralty Way")).toBeTruthy();
  });

  it("shows the empty state with a browse call to action", async () => {
    vi.mocked(fetchSavedListingIds).mockResolvedValue([]);
    render(<SavedPropertiesClient />);

    expect(await screen.findByText("No saved properties yet")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Browse properties" }).getAttribute("href")).toBe("/properties");
    expect(listPublicListings).not.toHaveBeenCalled();
  });

  it("redirects signed-out visitors to log in", async () => {
    vi.mocked(isAuthenticated).mockResolvedValue(false);
    render(<SavedPropertiesClient />);

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/login"));
    expect(fetchSavedListingIds).not.toHaveBeenCalled();
  });
});
