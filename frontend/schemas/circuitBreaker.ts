import { z } from 'zod';

export const proposeDrainSchema = z.object({
  destinationAddress: z
    .string()
    .min(56, 'Valid Stellar public address is required (e.g., G...)'),
  confirmKeyword: z.string().refine((val) => val === 'DRAIN', {
    message: 'You must type exactly "DRAIN" to confirm this action.',
  }),
});

export const freezeSchema = z.object({
  confirmKeyword: z.string().refine((val) => val === 'FREEZE', {
    message: 'You must type exactly "FREEZE" to confirm this action.',
  }),
});

export const recoveryDelaySchema = z.object({
  recoveryDelaySeconds: z
    .coerce
    .number()
    .int()
    .min(60, 'Recovery delay must be at least 60 seconds.'),
});

export type ProposeDrainFormValues = z.infer<typeof proposeDrainSchema>;
export type FreezeFormValues = z.infer<typeof freezeSchema>;
export type RecoveryDelayFormValues = z.infer<typeof recoveryDelaySchema>;