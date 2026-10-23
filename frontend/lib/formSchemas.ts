/**
 * Centralised Zod schemas for all app forms.
 * Import the schema you need and pass it to useAppForm's `schema` option.
 */
import { z } from "zod";
import { SUPPORTED_INSPECTOR_SERVICE_AREAS } from "../config/inspectorServiceAreas";

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

// ── Inspector configuration (#1921/#1922) ────────────────────────────────

/** Overall inspection grade — mirrors backend INSPECTION_GRADES (#1903). */
export const INSPECTION_GRADES = ["A", "B", "C", "D"] as const;
export type InspectionGrade = (typeof INSPECTION_GRADES)[number];

/** Rooms an inspector is asked to walk through on every report. */
export const INSPECTION_ROOMS = [
  "Living room",
  "Kitchen",
  "Bedroom(s)",
  "Bathroom(s)",
  "Toilet",
  "Balcony / outdoor",
  "Compound",
] as const;

export const ROOM_CHECK_RESULTS = ["pass", "fail", "na"] as const;
export type RoomCheckResult = (typeof ROOM_CHECK_RESULTS)[number];

/** Backend migration 029 constraints: at least 3 photos, notes >= 20 chars. */
export const MIN_INSPECTION_PHOTOS = 3;
export const MIN_INSPECTION_NOTES_LENGTH = 20;

export const inspectionReportSchema = z.object({
  overallGrade: z.enum(INSPECTION_GRADES, {
    errorMap: () => ({ message: "Select an overall grade of A–D" }),
  }),
  rooms: z
    .array(
      z.object({
        room: z.string().trim().min(1).max(100),
        result: z.enum(ROOM_CHECK_RESULTS),
      }),
    )
    .min(1, "Fill the room checklist for at least one room")
    .max(30)
    .refine(
      (rooms) => new Set(rooms.map((room) => room.room)).size === rooms.length,
      "Each room can appear once",
    ),
  photoKeys: z
    .array(z.string().min(1).max(512))
    .min(MIN_INSPECTION_PHOTOS, `At least ${MIN_INSPECTION_PHOTOS} photos are required`)
    .max(50)
    .refine(
      (keys) => new Set(keys).size === keys.length,
      "Photo keys must be unique",
    ),
  notes: z
    .string()
    .trim()
    .min(
      MIN_INSPECTION_NOTES_LENGTH,
      `Notes must be at least ${MIN_INSPECTION_NOTES_LENGTH} characters`,
    )
    .max(5000, "Notes are capped at 5000 characters"),
});

export type InspectionReportFormValues = z.infer<typeof inspectionReportSchema>;

export const inspectorOnboardingFormSchema = z.object({
  bio: z
    .string()
    .trim()
    .min(1, "Tell applicants something about yourself in the bio")
    .max(1000, "Bio is capped at 1000 characters"),
  serviceAreas: z
    .array(z.enum(SUPPORTED_INSPECTOR_SERVICE_AREAS))
    .min(1, "Select at least one service area you cover")
    .refine(
      (areas) => new Set(areas).size === areas.length,
      "Select each service area only once",
    ),
});

export type InspectorOnboardingFormValues = z.infer<typeof inspectorOnboardingFormSchema>;

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
