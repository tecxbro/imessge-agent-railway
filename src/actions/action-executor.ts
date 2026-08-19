import { z } from "zod";

import {
  normalizedApprovedActionSchema,
  type ActionType,
  type JsonValue,
} from "../security/action-schema.js";

const boundedTextSchema = (maximum: number) =>
  z.string().trim().min(1).max(maximum);
const safeMetadataSchema = z
  .record(
    z.string().min(1).max(64).regex(/^[a-z][a-z0-9_.-]*$/iu),
    z.union([
      z.string().max(500),
      z.number().finite(),
      z.boolean(),
      z.null(),
    ]),
  )
  .refine(
    (metadata) => Object.keys(metadata).length <= 20,
    "safeMetadata may contain at most 20 entries",
  );

export const actionExecutorInputSchema = normalizedApprovedActionSchema.extend({
  actionExecutionId: z.uuid(),
});

export const actionExecutorResultSchema = z
  .object({
    safeSummary: boundedTextSchema(1_000),
    providerReference: boundedTextSchema(512).nullable(),
    safeMetadata: safeMetadataSchema,
  })
  .strict();

export interface ActionExecutorInput {
  readonly actionExecutionId: string;
  readonly actionType: ActionType;
  readonly target: string;
  readonly normalizedPayload: JsonValue;
}

export type ActionExecutorResult = z.infer<typeof actionExecutorResultSchema>;

export interface ActionExecutor {
  readonly actionType: ActionType;
  /** Every side-effecting provider call must use input.actionExecutionId idempotently. */
  execute(
    input: ActionExecutorInput,
    signal: AbortSignal,
  ): Promise<ActionExecutorResult>;
}

export class ActionExecutorError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly safeMessage: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ActionExecutorError";
    if (!/^[A-Z][A-Z0-9_]{2,63}$/u.test(code)) {
      throw new Error("Action executor error codes must be bounded uppercase identifiers.");
    }
    boundedTextSchema(1_000).parse(safeMessage);
  }
}
