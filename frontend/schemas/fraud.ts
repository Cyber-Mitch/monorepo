import { z } from 'zod';

export const releaseHoldSchema = z.object({
  reason: z.string().trim().min(10, 'Release reason must be at least 10 characters.'),
});

export type ReleaseHoldFormValues = z.infer<typeof releaseHoldSchema>;
