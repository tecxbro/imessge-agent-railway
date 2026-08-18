import { z } from "zod";

export const REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export const reasoningEffortSchema = z.enum(REASONING_EFFORTS);

export const modelIdentifierSchema = z
  .string()
  .trim()
  .min(1, "model identifier is required")
  .max(128, "model identifier must be at most 128 characters")
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/i,
    "model identifier may contain only letters, numbers, dots, underscores, and hyphens",
  );

export const modelProfileSchema = z
  .object({
    model: modelIdentifierSchema,
    effort: reasoningEffortSchema,
  })
  .strict();

export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
export type ModelProfile = z.infer<typeof modelProfileSchema>;
