import { z } from 'zod';

export const closeMismatchSchema = z.object({
  reason: z.string().trim().min(10, 'Close reason must be at least 10 characters.'),
});

export type CloseMismatchFormValues = z.infer<typeof closeMismatchSchema>;
