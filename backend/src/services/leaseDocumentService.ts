/**
 * Lease Document Service
 *
 * Generates the lease agreement that tenant and landlord e-sign (#1954): a real
 * PDF rendered from a versioned template, stored under the lease's document key,
 * with a SHA-256 hash over the PDF bytes recorded on the lease so the signed
 * document can be verified later.
 *
 * Rendering is deterministic. Only standard (non-embedded) fonts are used, the
 * PDF metadata date is the deal's creation date and the lease start date is
 * derived from the deal, so the same inputs always produce the same bytes and
 * the same hash.
 */

import { randomUUID, createHash } from "node:crypto";
import PDFDocument from "pdfkit";
import { Deal, DealWithSchedule, ScheduleItem } from "../models/deal.js";
import { leaseAgreementStore } from "../models/leaseAgreementStore.js";
import { LeaseStatus } from "../models/leaseAgreement.js";
import { getPool } from "../db.js";
import { userStore } from "../models/authStore.js";
import { generateRepaymentSchedule } from "../utils/scheduleGenerator.js";
import { getStorageProvider } from "./storageService.js";
import { AppError } from "../errors/AppError.js";
import { ErrorCode } from "../errors/errorCodes.js";

/** Version of the lease template. Stored on the lease so a signed document can be tied to its wording. */
export const LEASE_TEMPLATE_VERSION = "lease-v1";

export interface LeaseTemplateData {
  dealId: string;
  templateVersion: string;
  tenantName: string;
  landlordName: string;
  propertyAddress: string;
  annualRentNgn: number;
  paymentType: string;
  depositAmount: number;
  financedAmountNgn: number;
  termMonths: number;
  startDate: string;
  leaseDuration: string;
  schedule: ScheduleItem[];
  platformTerms: string;
  platformClauses: string[];
}

export interface LeaseParties {
  tenantName: string;
  landlordName: string;
  tenantEmail?: string;
  landlordEmail?: string;
}

/** Raised when the data needed to draft a lease is missing; surfaces as a 422. */
export class LeaseDataError extends AppError {
  constructor(message: string) {
    super(ErrorCode.VALIDATION_ERROR, 422, message);
    this.name = "LeaseDataError";
  }
}

/**
 * SHA-256 of a lease document. Pass the PDF bytes; a string is hashed as-is,
 * which is only meant for legacy leases whose "document" was just its key.
 */
export function computeLeaseDocumentHash(
  document: string | Uint8Array,
): string {
  return createHash("sha256").update(document).digest("hex");
}

// ── Parties ───────────────────────────────────────────────────────────────────

export interface LeasePartyDeps {
  getUser(
    userId: string,
  ): Promise<{ name?: string; email?: string } | undefined>;
  getTenantLegalName(userId: string): Promise<string | undefined>;
  getLandlordCompanyName(userId: string): Promise<string | undefined>;
}

const defaultPartyDeps: LeasePartyDeps = {
  async getUser(userId) {
    return userStore.getById(userId);
  },
  async getTenantLegalName(userId) {
    const pool = await getPool();
    if (!pool) return undefined;
    const { rows } = await pool.query(
      `SELECT personal_info->>'fullName' AS full_name FROM onboarding_drafts WHERE user_id = $1`,
      [userId],
    );
    const name = (rows[0] as { full_name?: string | null } | undefined)
      ?.full_name;
    return name ?? undefined;
  },
  async getLandlordCompanyName(userId) {
    const profile = await userStore.getLandlordProfile(userId);
    return profile?.companyName ?? undefined;
  },
};

/** Accounts start out named after the local part of their email; that is not a legal name. */
function isEmailDerivedName(name: string, email?: string): boolean {
  return !!email && name.trim().toLowerCase() === email.split("@")[0]?.toLowerCase();
}

function usableName(name: string | undefined, email?: string): string | undefined {
  const trimmed = name?.trim();
  if (!trimmed || trimmed.length < 2) return undefined;
  if (isEmailDerivedName(trimmed, email)) return undefined;
  return trimmed;
}

/**
 * Looks up the legal names of the deal's tenant and landlord. The tenant's name
 * comes from their onboarding record (falling back to a name they set on their
 * account); the landlord's from their company name or account name. Throws a
 * `LeaseDataError` instead of ever inventing a name.
 */
export async function resolveLeaseParties(
  deal: Pick<Deal, "tenantId" | "landlordId">,
  deps: LeasePartyDeps = defaultPartyDeps,
): Promise<LeaseParties> {
  const [tenantUser, landlordUser] = await Promise.all([
    deps.getUser(deal.tenantId),
    deps.getUser(deal.landlordId),
  ]);

  const tenantName =
    usableName(await deps.getTenantLegalName(deal.tenantId), tenantUser?.email) ??
    usableName(tenantUser?.name, tenantUser?.email);
  if (!tenantName) {
    throw new LeaseDataError(
      `Cannot draft the lease: no legal name on record for tenant ${deal.tenantId}. Complete onboarding first.`,
    );
  }

  const landlordName =
    usableName(await deps.getLandlordCompanyName(deal.landlordId), landlordUser?.email) ??
    usableName(landlordUser?.name, landlordUser?.email);
  if (!landlordName) {
    throw new LeaseDataError(
      `Cannot draft the lease: no legal name on record for landlord ${deal.landlordId}. Complete the landlord profile first.`,
    );
  }

  return {
    tenantName,
    landlordName,
    tenantEmail: tenantUser?.email,
    landlordEmail: landlordUser?.email,
  };
}

// ── Template data ─────────────────────────────────────────────────────────────

const PLATFORM_CLAUSES = [
  "This lease agreement is facilitated by Shelterflex. All payments under this agreement are processed through the Shelterflex platform.",
  "The tenant shall pay each instalment on or before its due date. Late payment may incur the charges set out in the Shelterflex terms of service.",
  "The tenant shall use the property as a residence only and shall keep it in good condition, fair wear and tear excepted.",
  "The landlord warrants that they are entitled to let the property and shall give the tenant quiet enjoyment of it for the term.",
  "Either party may end this agreement early only as permitted by the Shelterflex terms of service and applicable law.",
  "By signing, each party confirms the details above are correct and agrees to be bound by this agreement.",
];

/**
 * Builds the data the lease template needs from a deal, the property address
 * and the parties' legal names. Everything is derived from those inputs (the
 * start date is the deal's creation date, not "today") so it is reproducible.
 */
export function buildLeaseTemplateData(
  deal: Deal | DealWithSchedule,
  propertyAddress: string,
  parties: Pick<LeaseParties, "tenantName" | "landlordName">,
): LeaseTemplateData {
  const required: Array<[string, string | undefined]> = [
    ["tenant name", parties.tenantName],
    ["landlord name", parties.landlordName],
    ["property address", propertyAddress],
  ];
  for (const [label, value] of required) {
    if (!value || !value.trim()) {
      throw new LeaseDataError(`Cannot draft the lease: ${label} is missing.`);
    }
  }

  const startDate = deal.createdAt.toISOString().split("T")[0];
  const existing = "schedule" in deal ? deal.schedule : undefined;
  const schedule =
    existing && existing.length > 0
      ? existing
      : generateRepaymentSchedule({
          annualRentNgn: deal.annualRentNgn,
          depositNgn: deal.depositNgn,
          termMonths: deal.termMonths,
          startDate: deal.createdAt,
        });

  return {
    dealId: deal.dealId,
    templateVersion: LEASE_TEMPLATE_VERSION,
    tenantName: parties.tenantName.trim(),
    landlordName: parties.landlordName.trim(),
    propertyAddress: propertyAddress.trim(),
    annualRentNgn: deal.annualRentNgn,
    paymentType: "installment",
    depositAmount: deal.depositNgn,
    financedAmountNgn: deal.financedAmountNgn,
    termMonths: deal.termMonths,
    startDate,
    leaseDuration: `${deal.termMonths} months`,
    schedule,
    platformTerms: PLATFORM_CLAUSES[0],
    platformClauses: PLATFORM_CLAUSES,
  };
}

// ── PDF ───────────────────────────────────────────────────────────────────────

/** `1234567.5` -> `NGN 1,234,567.50`, independent of the runtime's locale. */
export function formatNgn(amount: number): string {
  const [whole, fraction] = amount.toFixed(2).split(".");
  return `NGN ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction}`;
}

const MARGIN = 56;
const PAGE_BOTTOM = 760;

/**
 * Renders the lease to PDF bytes. Pure function of `data`: no clock, no random
 * ids, standard fonts only.
 */
export function renderLeasePdf(data: LeaseTemplateData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
      info: {
        Title: `Lease Agreement - ${data.dealId}`,
        Author: "Shelterflex",
        Subject: `Lease template ${data.templateVersion}`,
        // Fixed to the lease start so the file does not change between runs.
        CreationDate: new Date(`${data.startDate}T00:00:00.000Z`),
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const heading = (text: string) => {
      doc.moveDown(0.8).font("Helvetica-Bold").fontSize(12).text(text);
      doc.moveDown(0.3).font("Helvetica").fontSize(10);
    };
    const field = (label: string, value: string) => {
      doc
        .font("Helvetica-Bold")
        .text(`${label}: `, { continued: true })
        .font("Helvetica")
        .text(value);
    };

    doc.font("Helvetica-Bold").fontSize(18).text("Residential Lease Agreement", { align: "center" });
    doc
      .moveDown(0.3)
      .font("Helvetica")
      .fontSize(9)
      .text(`Template ${data.templateVersion} - Deal ${data.dealId}`, { align: "center" });
    doc.fontSize(10);

    heading("1. Parties");
    field("Tenant", data.tenantName);
    field("Landlord", data.landlordName);

    heading("2. Property");
    field("Address", data.propertyAddress);

    heading("3. Term");
    field("Start date", data.startDate);
    field("Duration", data.leaseDuration);

    heading("4. Rent and deposit");
    field("Annual rent", formatNgn(data.annualRentNgn));
    field("Deposit", formatNgn(data.depositAmount));
    field("Amount paid by instalments", formatNgn(data.financedAmountNgn));
    field("Payment type", data.paymentType);

    heading("5. Instalment schedule");
    const columns = [MARGIN, MARGIN + 70, MARGIN + 220];
    const drawRow = (cells: string[], bold = false) => {
      if (doc.y > PAGE_BOTTOM) doc.addPage();
      const y = doc.y;
      doc.font(bold ? "Helvetica-Bold" : "Helvetica");
      cells.forEach((cell, i) => {
        doc.text(cell, columns[i], y, { lineBreak: false });
      });
      doc.text("", MARGIN, y + 14);
    };
    drawRow(["No.", "Due date", "Amount"], true);
    for (const item of data.schedule) {
      drawRow([
        String(item.period),
        item.dueDate.split("T")[0],
        formatNgn(item.amountNgn),
      ]);
    }
    doc.font("Helvetica");

    heading("6. Platform clauses");
    data.platformClauses.forEach((clause, i) => {
      doc.text(`${6}.${i + 1} ${clause}`, MARGIN, doc.y, { align: "left" });
      doc.moveDown(0.3);
    });

    if (doc.y > PAGE_BOTTOM - 120) doc.addPage();
    heading("Signatures");
    const sigY = doc.y + 20;
    doc.text("______________________________", MARGIN, sigY);
    doc.text(`Tenant: ${data.tenantName}`, MARGIN, sigY + 14);
    doc.text("______________________________", MARGIN + 260, sigY);
    doc.text(`Landlord: ${data.landlordName}`, MARGIN + 260, sigY + 14);

    doc.end();
  });
}

// ── Generate and store ────────────────────────────────────────────────────────

/**
 * Generate a lease draft for a deal: render the PDF, upload it at the lease's
 * document key and record the template version and the SHA-256 of the PDF bytes.
 */
export async function generateLeaseDraft(
  dealId: string,
  templateData: LeaseTemplateData,
): Promise<{
  leaseId: string;
  documentKey: string;
  documentHash: string;
  templateVersion: string;
}> {
  // Check if a non-voided lease already exists for this deal
  const existingLease = await leaseAgreementStore.getByDealId(dealId);
  if (existingLease && existingLease.status !== LeaseStatus.VOIDED) {
    throw new Error(
      `A lease agreement already exists for deal ${dealId}. Void the existing lease first.`,
    );
  }

  const pdf = await renderLeasePdf(templateData);
  const documentHash = computeLeaseDocumentHash(pdf);
  const documentKey = `lease/${dealId}/${randomUUID()}.pdf`;

  const storage = getStorageProvider();
  await storage.uploadFile(documentKey, pdf, "application/pdf", {
    dealId,
    templateVersion: templateData.templateVersion,
    documentHash,
  });

  try {
    const lease = await leaseAgreementStore.create({
      dealId,
      documentKey,
      documentHash,
      templateVersion: templateData.templateVersion,
    });
    return {
      leaseId: lease.leaseId,
      documentKey,
      documentHash,
      templateVersion: templateData.templateVersion,
    };
  } catch (error) {
    // Do not leave an orphaned document behind a lease that was never recorded.
    await storage.deleteFile(documentKey).catch(() => undefined);
    throw error;
  }
}
