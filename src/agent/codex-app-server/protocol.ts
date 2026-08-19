import { z } from "zod";

export const MAXIMUM_PROTOCOL_LINE_BYTES = 1_048_576;

export class CodexAppServerProtocolError extends Error {
  public constructor() {
    super("CODEX_APP_SERVER_PROTOCOL_ERROR");
    this.name = "CodexAppServerProtocolError";
  }
}

export interface AppServerNotification {
  method: string;
  params: unknown;
}

export const requestIdSchema = z.union([
  z.number().int(),
  z.string().trim().min(1).max(256),
]);

export const responseEnvelopeSchema = z
  .object({
    id: z.number().int(),
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.number().int(),
        message: z.string(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .refine(
    (value) =>
      Object.hasOwn(value, "result") !== Object.hasOwn(value, "error"),
    "App Server responses require exactly one result or error field.",
  );

export const serverRequestEnvelopeSchema = z
  .object({
    id: requestIdSchema,
    method: z.string(),
    params: z.unknown(),
  })
  .passthrough();

export const notificationEnvelopeSchema = z
  .object({
    method: z.string(),
    params: z.unknown(),
  })
  .passthrough();

export const accountReadSchema = z
  .object({
    account: z
      .discriminatedUnion("type", [
        z.object({ type: z.literal("apiKey") }).passthrough(),
        z
          .object({
            type: z.literal("chatgpt"),
            email: z.string().nullable(),
            planType: z.string(),
          })
          .passthrough(),
        z.object({ type: z.literal("amazonBedrock") }).passthrough(),
      ])
      .nullable(),
    requiresOpenaiAuth: z.boolean(),
  })
  .passthrough();

export const initializeResponseSchema = z
  .object({
    codexHome: z.string(),
  })
  .passthrough();

export const deviceLoginSchema = z
  .object({
    type: z.literal("chatgptDeviceCode"),
    loginId: z.string().trim().min(1).max(512),
    verificationUrl: z
      .url()
      .max(2_048)
      .refine((value) => {
        const parsed = new URL(value);
        return (
          parsed.protocol === "https:" && parsed.hostname === "auth.openai.com"
        );
      }),
    userCode: z.string().trim().min(1).max(128),
  })
  .passthrough();

export const loginCompletedSchema = z
  .object({
    loginId: z.string().trim().min(1).max(512).nullable(),
    success: z.boolean(),
    error: z.string().nullable(),
  })
  .passthrough();

export const accountUpdatedSchema = z
  .object({
    authMode: z.string().trim().min(1).max(128).nullable(),
    planType: z.string().trim().min(1).max(64).nullable(),
  })
  .passthrough();

export const wireReasoningEffortSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_-]*$/iu);

export const codexModelOptionSchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    model: z.string().trim().min(1).max(128),
    displayName: z.string().trim().min(1).max(256),
    supportedReasoningEfforts: z
      .array(
        z
          .object({
            reasoningEffort: wireReasoningEffortSchema,
            description: z.string().max(2_000),
          })
          .passthrough(),
      )
      .min(1)
      .max(32),
    defaultReasoningEffort: wireReasoningEffortSchema,
    isDefault: z.boolean(),
  })
  .passthrough()
  .refine(
    (model) =>
      model.supportedReasoningEfforts.some(
        (effort) => effort.reasoningEffort === model.defaultReasoningEffort,
      ),
    "The default reasoning effort must be included in supportedReasoningEfforts.",
  );

export const modelListSchema = z
  .object({
    data: z.array(codexModelOptionSchema).max(1_000),
    nextCursor: z.string().trim().min(1).max(2_048).nullable(),
  })
  .passthrough();

export type AccountRead = z.infer<typeof accountReadSchema>;
export type DeviceLogin = z.infer<typeof deviceLoginSchema>;
export type LoginCompleted = z.infer<typeof loginCompletedSchema>;
export type WireCodexModelOption = z.infer<typeof codexModelOptionSchema>;
