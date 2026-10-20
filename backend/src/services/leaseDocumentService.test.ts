import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// Use the local storage provider, in a throwaway directory, so uploads can be read back.
const storageDir = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const path = require("node:path") as typeof import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lease-docs-"));
  process.env.STORAGE_PROVIDER = "local";
  process.env.LOCAL_STORAGE_DIR = dir;
  return dir;
});

import { rmSync } from "node:fs";
import {
  generateLeaseDraft,
  buildLeaseTemplateData,
  renderLeasePdf,
  resolveLeaseParties,
  computeLeaseDocumentHash,
  formatNgn,
  LeaseDataError,
  LEASE_TEMPLATE_VERSION,
  type LeasePartyDeps,
} from "./leaseDocumentService.js";
import { getStorageProvider } from "./storageService.js";
import { leaseAgreementStore } from "../models/leaseAgreementStore.js";
import { LeaseStatus } from "../models/leaseAgreement.js";
import { Deal, DealStatus } from "../models/deal.js";
import { extractPdfText } from "../test-fixtures/pdfText.js";

const mockDeal: Deal = {
  dealId: "deal-123",
  tenantId: "tenant-1",
  landlordId: "landlord-1",
  listingId: "listing-1",
  annualRentNgn: 1200000,
  depositNgn: 600000,
  financedAmountNgn: 600000,
  termMonths: 12,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  status: DealStatus.ACTIVE,
  repaymentMethod: "self_pay",
};

const PARTIES = { tenantName: "Ada Obi", landlordName: "Chidi Eze" };
const ADDRESS = "12 Admiralty Way, Lekki, Lagos";

const pdfText = (pdf: Buffer) => extractPdfText(pdf).replace(/\s+/g, " ");

afterAll(() => {
  rmSync(storageDir, { recursive: true, force: true });
});

describe("leaseDocumentService", () => {
  beforeEach(async () => {
    await leaseAgreementStore.clear();
  });

  describe("buildLeaseTemplateData", () => {
    it("populates template data with the deal terms and the parties' names", () => {
      const data = buildLeaseTemplateData(mockDeal, ADDRESS, PARTIES);

      expect(data.tenantName).toBe("Ada Obi");
      expect(data.landlordName).toBe("Chidi Eze");
      expect(data.propertyAddress).toBe(ADDRESS);
      expect(data.annualRentNgn).toBe(1200000);
      expect(data.depositAmount).toBe(600000);
      expect(data.termMonths).toBe(12);
      expect(data.leaseDuration).toBe("12 months");
      expect(data.templateVersion).toBe(LEASE_TEMPLATE_VERSION);
      expect(data.schedule).toHaveLength(12);
    });

    it("derives the start date from the deal, not from today's date", () => {
      const data = buildLeaseTemplateData(mockDeal, ADDRESS, PARTIES);

      expect(data.startDate).toBe("2026-01-01");
    });

    it("uses the deal's own schedule when it has one", () => {
      const schedule = [
        { period: 1, dueDate: "2026-02-01T00:00:00.000Z", amountNgn: 111, status: "upcoming" },
      ] as never;
      const data = buildLeaseTemplateData({ ...mockDeal, schedule } as never, ADDRESS, PARTIES);

      expect(data.schedule).toBe(schedule);
    });

    it("includes the platform clauses", () => {
      const data = buildLeaseTemplateData(mockDeal, ADDRESS, PARTIES);

      expect(data.platformTerms).toContain("Shelterflex");
      expect(data.platformClauses.length).toBeGreaterThan(1);
    });

    it("generates deterministic output for the same inputs", () => {
      expect(buildLeaseTemplateData(mockDeal, ADDRESS, PARTIES)).toEqual(
        buildLeaseTemplateData(mockDeal, ADDRESS, PARTIES),
      );
    });

    it("changes when deal terms change", () => {
      const data1 = buildLeaseTemplateData(mockDeal, ADDRESS, PARTIES);
      const data2 = buildLeaseTemplateData(
        { ...mockDeal, annualRentNgn: 2400000, depositNgn: 1200000 },
        ADDRESS,
        PARTIES,
      );

      expect(data2.annualRentNgn).toBe(2400000);
      expect(data1).not.toEqual(data2);
    });

    it.each([
      ["tenant name", { tenantName: " ", landlordName: "Chidi Eze" }, ADDRESS],
      ["landlord name", { tenantName: "Ada Obi", landlordName: "" }, ADDRESS],
      ["property address", PARTIES, "  "],
    ])("fails clearly when the %s is missing", (label, parties, address) => {
      expect(() => buildLeaseTemplateData(mockDeal, address, parties)).toThrow(LeaseDataError);
      expect(() => buildLeaseTemplateData(mockDeal, address, parties)).toThrow(
        new RegExp(`${label} is missing`),
      );
    });
  });

  describe("renderLeasePdf", () => {
    it("produces a PDF containing the parties, property, terms and schedule", async () => {
      const pdf = await renderLeasePdf(buildLeaseTemplateData(mockDeal, ADDRESS, PARTIES));
      const text = pdfText(pdf);

      expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
      expect(text).toContain("Residential Lease Agreement");
      expect(text).toContain("Tenant: Ada Obi");
      expect(text).toContain("Landlord: Chidi Eze");
      expect(text).toContain("Address: 12 Admiralty Way, Lekki, Lagos");
      expect(text).toContain("Start date: 2026-01-01");
      expect(text).toContain("Duration: 12 months");
      expect(text).toContain("Annual rent: NGN 1,200,000.00");
      expect(text).toContain("Deposit: NGN 600,000.00");
      expect(text).toContain("NGN 50,000.00");
      expect(text).toContain("2026-02-01");
      expect(text).toContain("2027-01-01");
      expect(text).toContain("Shelterflex");
      expect(text).toContain(LEASE_TEMPLATE_VERSION);
    });

    it("contains no placeholder party names", async () => {
      const pdf = await renderLeasePdf(buildLeaseTemplateData(mockDeal, ADDRESS, PARTIES));
      const text = pdfText(pdf);

      expect(text).not.toMatch(/Tenant tenant-1|Landlord landlord-1/);
    });

    it("is byte-for-byte deterministic for the same inputs", async () => {
      const data = buildLeaseTemplateData(mockDeal, ADDRESS, PARTIES);

      const first = await renderLeasePdf(data);
      const second = await renderLeasePdf({ ...data });

      expect(second.equals(first)).toBe(true);
      expect(computeLeaseDocumentHash(second)).toBe(computeLeaseDocumentHash(first));
    });

    it("changes the hash when a term changes", async () => {
      const base = buildLeaseTemplateData(mockDeal, ADDRESS, PARTIES);
      const hashOf = async (data = base) => computeLeaseDocumentHash(await renderLeasePdf(data));
      const original = await hashOf();

      expect(await hashOf({ ...base, depositAmount: 650000 })).not.toBe(original);
      expect(await hashOf({ ...base, propertyAddress: "Another address" })).not.toBe(original);
      expect(await hashOf({ ...base, tenantName: "Someone Else" })).not.toBe(original);
      expect(await hashOf({ ...base, termMonths: 6, leaseDuration: "6 months" })).not.toBe(original);
    });

    it("spills a long schedule onto further pages without losing rows", async () => {
      const long = { ...mockDeal, termMonths: 60 };
      const pdf = await renderLeasePdf(buildLeaseTemplateData(long, ADDRESS, PARTIES));
      const text = pdfText(pdf);

      expect(text).toContain("2031-01-01");
      expect(pdf.toString("latin1").match(/\/Type \/Page\b/g)!.length).toBeGreaterThan(1);
    });
  });

  describe("generateLeaseDraft", () => {
    const draft = (dealId = "deal-123") =>
      generateLeaseDraft(dealId, buildLeaseTemplateData({ ...mockDeal, dealId }, ADDRESS, PARTIES));

    it("stores a real PDF at the document key and hashes its bytes", async () => {
      const result = await draft();

      expect(result.documentKey).toMatch(/^lease\/deal-123\/.+\.pdf$/);
      const { buffer } = await getStorageProvider().downloadFile(result.documentKey);
      expect(buffer.subarray(0, 5).toString()).toBe("%PDF-");
      expect(pdfText(buffer)).toContain("Tenant: Ada Obi");
      expect(result.documentHash).toBe(computeLeaseDocumentHash(buffer));
    });

    it("records the hash and template version on the lease, in DRAFT status", async () => {
      const result = await draft();

      const lease = await leaseAgreementStore.getById(result.leaseId);
      expect(lease?.status).toBe(LeaseStatus.DRAFT);
      expect(lease?.dealId).toBe("deal-123");
      expect(lease?.documentHash).toBe(result.documentHash);
      expect(lease?.templateVersion).toBe(LEASE_TEMPLATE_VERSION);
    });

    it("produces the same hash for the same inputs on a new lease", async () => {
      const first = await draft();
      await leaseAgreementStore.void(first.leaseId);
      const second = await draft();

      expect(second.documentKey).not.toBe(first.documentKey);
      expect(second.documentHash).toBe(first.documentHash);
    });

    it("prevents creating a second lease for the same deal", async () => {
      await draft();

      await expect(draft()).rejects.toThrow(
        "A lease agreement already exists for deal deal-123",
      );
    });

    it("allows creating a new lease after voiding the old one", async () => {
      const first = await draft();
      await leaseAgreementStore.void(first.leaseId);

      const second = await draft();
      expect(second.leaseId).not.toBe(first.leaseId);
    });

    it("generates unique document keys for each lease", async () => {
      const first = await draft("deal-123");
      const second = await draft("deal-456");

      expect(first.documentKey).not.toBe(second.documentKey);
    });
  });

  describe("resolveLeaseParties", () => {
    const deps = (over: Partial<LeasePartyDeps> = {}): LeasePartyDeps => ({
      getUser: async (id) =>
        id === "tenant-1"
          ? { name: "tenantuser", email: "tenantuser@example.com" }
          : { name: "Chidi Eze", email: "chidi@example.com" },
      getTenantLegalName: async () => "Ada Obi",
      getLandlordCompanyName: async () => undefined,
      ...over,
    });

    it("uses the tenant's onboarding name and the landlord's account name", async () => {
      const parties = await resolveLeaseParties(mockDeal, deps());

      expect(parties).toMatchObject({
        tenantName: "Ada Obi",
        landlordName: "Chidi Eze",
        tenantEmail: "tenantuser@example.com",
        landlordEmail: "chidi@example.com",
      });
    });

    it("prefers a landlord company name", async () => {
      const parties = await resolveLeaseParties(
        mockDeal,
        deps({ getLandlordCompanyName: async () => "Eze Properties Ltd" }),
      );

      expect(parties.landlordName).toBe("Eze Properties Ltd");
    });

    it("never accepts a name derived from the email address", async () => {
      await expect(
        resolveLeaseParties(mockDeal, deps({ getTenantLegalName: async () => undefined })),
      ).rejects.toThrow(/no legal name on record for tenant tenant-1/);
    });

    it("fails clearly when the landlord has no usable name", async () => {
      await expect(
        resolveLeaseParties(
          mockDeal,
          deps({
            getUser: async (id) =>
              id === "tenant-1"
                ? { name: "Ada Obi", email: "ada@example.com" }
                : { name: "landlord", email: "landlord@example.com" },
          }),
        ),
      ).rejects.toThrow(/no legal name on record for landlord landlord-1/);
    });

    it("fails when a party does not exist at all", async () => {
      await expect(
        resolveLeaseParties(
          mockDeal,
          deps({ getUser: async () => undefined, getTenantLegalName: async () => undefined }),
        ),
      ).rejects.toBeInstanceOf(LeaseDataError);
    });
  });

  describe("formatNgn", () => {
    it.each([
      [0, "NGN 0.00"],
      [999.5, "NGN 999.50"],
      [1200000, "NGN 1,200,000.00"],
      [1234567.891, "NGN 1,234,567.89"],
    ])("formats %s as %s", (amount, expected) => {
      expect(formatNgn(amount)).toBe(expected);
    });
  });
});
