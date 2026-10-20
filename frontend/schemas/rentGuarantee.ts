import { z } from 'zod';

export const quoteRequestSchema = z.object({
  dealId: z.string().min(1, 'Deal ID is required.'),
  coverageMonths: z.coerce.number().int().min(1, 'Coverage term must be at least 1 month.'),
});

export const fileClaimSchema = z.object({
  policyId: z.string().min(1, 'Policy ID is required.'),
  claimAmount: z.string().min(1, 'Claim amount is required.'),
  reason: z.string().min(15, 'Please provide a detailed reason of at least 15 characters for this insurance claim.'),
});

export type QuoteRequestFormValues = z.infer<typeof quoteRequestSchema>;
export type FileClaimFormValues = z.infer<typeof fileClaimSchema>;