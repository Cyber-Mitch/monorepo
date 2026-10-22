/**
 * Centralised Zod schemas for all app forms.
 * Import the schema you need and pass it to useAppForm's `schema` option.
 */
import { z } from "zod";

// ── Primitives ────────────────────────────────────────────────────────────────

export const emailSchema = z
  .string()
  .min(1, "Email is required")
  .email("Enter a valid email address");

export const amountSchema = z
  .string()
  .min(1, "Amount is required")
  .refine((v: string) => !isNaN(Number(v)) && Number(v) > 0, {
    message: "Amount must be a positive number",
  });

// ── Auth ──────────────────────────────────────────────────────────────────────

export const loginSchema = z.object({
  email: emailSchema,
});

export const otpSchema = z.object({
  otp: z
    .string()
    .length(6, "OTP must be exactly 6 digits")
    .regex(/^\d+$/, "OTP must contain only digits"),
});

export const signupSchema = z.object({
  email: emailSchema,
  name: z.string().min(2, "Name must be at least 2 characters"),
});

export const accountSignupSchema = z.object({
  fullName: z.string().min(2, "Full name must be at least 2 characters"),
  email: emailSchema,
  phone: z.string().min(10, "Phone number must be at least 10 digits"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .regex(/\d/, "Password must contain at least one number"),
  terms: z.literal(true, {
    errorMap: () => ({ message: "You must agree to the Terms and Privacy Policy" }),
  }),
});

// ── Staking ───────────────────────────────────────────────────────────────────

export const stakeSchema = z.object({
  amount: amountSchema,
  currency: z.enum(["USDC", "NGN"], { required_error: "Select a currency" }),
  duration: z.number().min(1, "Duration must be at least 1 day"),
});

// ── Deposit ───────────────────────────────────────────────────────────────────

export const depositSchema = z.object({
  amount: amountSchema,
  reference: z.string().optional(),
});

// ── Whistleblower ─────────────────────────────────────────────────────────────

export const whistleblowerSchema = z.object({
  subject: z.string().min(5, "Subject must be at least 5 characters"),
  description: z.string().min(20, "Please provide more detail (min 20 chars)"),
  attachments: z
    .array(
      z.object({
        name: z.string(),
        url: z.string().url(),
      })
    )
    .optional(),
});

// ── Contact ───────────────────────────────────────────────────────────────────

export const contactSchema = z.object({
  name: z.string().min(2, "Name is required"),
  email: emailSchema,
  message: z.string().min(10, "Message must be at least 10 characters"),
});

// ── Pre-Screening ──────────────────────────────────────────────────────────────

export const employmentStatusSchema = z.enum(["employed", "self-employed", "contract", "student"], {
  required_error: "Please select your employment status",
});

export const preScreenSchema = z.object({
  monthlyNetIncome: z
    .string()
    .min(1, "Monthly net income is required")
    .refine((v: string) => !isNaN(Number(v)) && Number(v) > 0, {
      message: "Income must be a positive number",
    }),
  monthlyRent: z
    .string()
    .min(1, "Monthly rent is required")
    .refine((v: string) => !isNaN(Number(v)) && Number(v) >= 0, {
      message: "Rent must be a valid number",
    }),
  employmentStatus: employmentStatusSchema,
  depositPercentage: z.number().min(0, "Deposit percentage must be at least 0").max(100, "Deposit percentage cannot exceed 100"),
});

// ── Admin ─────────────────────────────────────────────────────────────────────

export const quotaLookupSchema = z.object({
  userId: z.string().trim().min(1, "User ID is required"),
  endpoint: z.string().trim().optional(),
});

export const quotaOverrideSchema = z.object({
  endpoint: z.string().trim().optional(),
  elevatedLimit: z
    .number({ invalid_type_error: "Limit must be a number" })
    .int("Limit must be a whole number")
    .min(1, "Limit must be at least 1"),
  reason: z.string().trim().min(3, "Give a reason of at least 3 characters"),
  expiresAt: z
    .string()
    .optional()
    .refine((v) => !v || new Date(v).getTime() > Date.now(), {
      message: "Expiry must be in the future",
    }),
});

// ── Type exports ──────────────────────────────────────────────────────────────

export type LoginFormValues = z.infer<typeof loginSchema>;
export type OtpFormValues = z.infer<typeof otpSchema>;
export type SignupFormValues = z.infer<typeof signupSchema>;
export type AccountSignupFormValues = z.infer<typeof accountSignupSchema>;
export type StakeFormValues = z.infer<typeof stakeSchema>;
export type DepositFormValues = z.infer<typeof depositSchema>;
export type WhistleblowerFormValues = z.infer<typeof whistleblowerSchema>;
export type ContactFormValues = z.infer<typeof contactSchema>;
export type PreScreenFormValues = z.infer<typeof preScreenSchema>;
export type QuotaLookupFormValues = z.infer<typeof quotaLookupSchema>;
export type QuotaOverrideFormValues = z.infer<typeof quotaOverrideSchema>;

// ── Compliance reports ────────────────────────────────────────────────────────

/**
 * Maximum allowed span (inclusive of both dates) of a compliance report's
 * date range. Enforced by `complianceReportSchema` so an admin cannot queue
 * an export that would scan an unbounded window.
 */
export const COMPLIANCE_REPORT_MAX_RANGE_DAYS = 90;

/** Report types an admin can export. Mirrors the backend compliance domain. */
export const complianceReportTypes = [
  "transactions",
  "kyc",
  "settlements",
  "audit_log",
] as const;
export type ComplianceReportType = (typeof complianceReportTypes)[number];

/**
 * Parses a `type="date"` input value (YYYY-MM-DD) as a local calendar date.
 * Returns null for empty or unparseable input so field-level rules report
 * "required" first and range refinements only run when both dates are present.
 */
function parseFormDate(value: string): Date | null {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export const complianceReportSchema = z
  .object({
    type: z.enum(complianceReportTypes, {
      required_error: "Select a report type",
    }),
    startDate: z.string().min(1, "Start date is required"),
    endDate: z.string().min(1, "End date is required"),
  })
  .refine(
    (data) => {
      const start = parseFormDate(data.startDate);
      const end = parseFormDate(data.endDate);
      if (!start || !end) return true;
      return end.getTime() >= start.getTime();
    },
    { message: "End date must be on or after the start date", path: ["endDate"] },
  )
  .refine(
    (data) => {
      const start = parseFormDate(data.startDate);
      const end = parseFormDate(data.endDate);
      if (!start || !end) return true;
      const days = (end.getTime() - start.getTime()) / 86_400_000;
      return days <= COMPLIANCE_REPORT_MAX_RANGE_DAYS;
    },
    {
      message: `Date range cannot exceed ${COMPLIANCE_REPORT_MAX_RANGE_DAYS} days`,
      path: ["endDate"],
    },
  );

export type ComplianceReportFormValues = z.infer<typeof complianceReportSchema>;
