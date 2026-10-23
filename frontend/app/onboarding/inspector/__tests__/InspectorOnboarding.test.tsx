import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { InspectorOnboardingClient } from "../InspectorOnboardingClient";
import * as inspectorApi from "@/lib/inspectorApi";

vi.mock("@/lib/inspectorApi", () => ({
  getInspectorProfile: vi.fn(),
  getKycStatus: vi.fn(),
  submitInspectorOnboarding: vi.fn(),
  SUPPORTED_INSPECTOR_SERVICE_AREAS: [
    "Lagos",
    "Abuja",
    "Port Harcourt",
    "Ibadan",
    "Kano",
    "Enugu",
    "Kaduna",
    "Benin City",
  ],
}));

describe("InspectorOnboardingClient (#1922)", () => {
  beforeAll(() => {
    // Some Node runtimes shadow jsdom's localStorage with an experimental stub
    // that lacks getItem/setItem; the form draft needs a working store.
    const candidate = globalThis.localStorage as unknown as
      | { getItem?: unknown; setItem?: unknown; removeItem?: unknown }
      | undefined;
    if (typeof candidate?.getItem !== "function") {
      const store = new Map<string, string>();
      (globalThis as unknown as { localStorage: unknown }).localStorage = {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
        clear: () => store.clear(),
      };
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: identity verification is out of the way; individual tests
    // override this with the status they are exercising.
    vi.mocked(inspectorApi.getKycStatus).mockResolvedValue({
      status: "approved",
      attemptsRemaining: 0,
    });
  });

  it("shows the KYC prerequisite gate when identity verification is not approved", async () => {
    vi.mocked(inspectorApi.getInspectorProfile).mockRejectedValue(new Error("No inspector profile"));
    vi.mocked(inspectorApi.getKycStatus).mockResolvedValue({
      status: "pending",
      attemptsRemaining: 3,
    });
    render(<InspectorOnboardingClient />);

    expect(
      await screen.findByText("Identity verification first"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Areas you cover")).not.toBeInTheDocument();
  });

  it("blocks the form until the applicant fills a bio", async () => {
    vi.mocked(inspectorApi.getInspectorProfile).mockRejectedValue(new Error("No inspector profile"));
    vi.mocked(inspectorApi.getKycStatus).mockResolvedValue({
      status: "approved",
      attemptsRemaining: 0,
    });
    render(<InspectorOnboardingClient />);

    await screen.findByText("About you (shown alongside your applications)");
    fireEvent.click(screen.getByRole("button", { name: /next: service areas/i }));

    expect(
      await screen.findByText("Tell applicants something about yourself in the bio"),
    ).toBeInTheDocument();
    // Still on step 1 — service areas are not yet in the DOM.
    expect(screen.queryByText("Areas you cover")).not.toBeInTheDocument();
  });

  it("moves through bio and service areas and submits", async () => {
    vi.mocked(inspectorApi.getInspectorProfile).mockRejectedValue(new Error("No inspector profile"));
    vi.mocked(inspectorApi.getKycStatus).mockResolvedValue({
      status: "approved",
      attemptsRemaining: 0,
    });
    vi.mocked(inspectorApi.submitInspectorOnboarding).mockResolvedValue({
      userId: "me",
      verificationStatus: "pending",
      bio: "Ten years inspecting Lagos rentals.",
      serviceAreas: ["Lagos"],
      completedInspections: 0,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    });

    render(<InspectorOnboardingClient />);
    await screen.findByText("About you (shown alongside your applications)");

    fireEvent.change(screen.getByLabelText(/about you/i), {
      target: { value: "Ten years inspecting Lagos rentals." },
    });
    fireEvent.click(screen.getByRole("button", { name: /next: service areas/i }));
    expect(await screen.findByText("Areas you cover")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "Cover Lagos" }));
    fireEvent.click(screen.getByRole("button", { name: /next: review/i }));
    expect(await screen.findByText("Review your application")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /submit application/i }));
    await waitFor(() =>
      expect(inspectorApi.submitInspectorOnboarding).toHaveBeenCalledWith({
        bio: "Ten years inspecting Lagos rentals.",
        serviceAreas: ["Lagos"],
      }),
    );
    // Lands on the pending status screen after submit.
    expect(
      await screen.findByText("Application pending review"),
    ).toBeInTheDocument();
  });

  it("lands returning verified applicants on the verified status screen", async () => {
    vi.mocked(inspectorApi.getInspectorProfile).mockResolvedValue({
      userId: "me",
      verificationStatus: "verified",
      bio: "x",
      serviceAreas: ["Lagos"],
      completedInspections: 4,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    render(<InspectorOnboardingClient />);
    expect(await screen.findByText("You are a verified inspector")).toBeInTheDocument();
  });

  it("shows the suspended status screen with a support contact", async () => {
    vi.mocked(inspectorApi.getInspectorProfile).mockResolvedValue({
      userId: "me",
      verificationStatus: "suspended",
      bio: "x",
      serviceAreas: [],
      completedInspections: 0,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    render(<InspectorOnboardingClient />);
    expect(await screen.findByText("Account suspended")).toBeInTheDocument();
    expect(screen.getByText(/support@shelterflex.com/)).toBeInTheDocument();
  });
});
