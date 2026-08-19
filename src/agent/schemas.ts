import { z } from "zod";

import { permissionProfileNameSchema } from "../security/permissions.js";
import {
  ACTION_TYPES,
  actionTypeSchema,
  jsonValueSchema,
  proposedActionSchema,
  type ActionType,
  type JsonValue,
  type ProposedAction,
} from "../security/action-schema.js";

export {
  ACTION_TYPES,
  actionTypeSchema,
  jsonValueSchema,
  proposedActionSchema,
};
export type { ActionType, JsonValue, ProposedAction };

const identifierSchema = z.uuid();
const boundedTextSchema = (maximum: number) =>
  z.string().trim().min(1).max(maximum);

const taskIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/i);

const workspaceBindingSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/i);

export const authorizedInboundSchema = z
  .object({
    deploymentId: identifierSchema,
    ownerId: identifierSchema,
    spaceId: identifierSchema,
    externalMessageId: boundedTextSchema(256),
    senderIdentityId: identifierSchema,
    text: boundedTextSchema(32_000),
    receivedAt: z.date(),
    routePhone: z.string().regex(/^\+[1-9]\d{7,14}$/).optional(),
    isGroup: z.boolean(),
  })
  .strict();

export const MEMORY_KINDS = [
  "preference",
  "relationship",
  "commitment",
  "project_fact",
  "project_summary",
  "correction",
] as const;

export const memoryCandidateSchema = z
  .object({
    kind: z.enum(MEMORY_KINDS),
    scope: z.enum(["owner", "space", "project"]),
    content: boundedTextSchema(2_000),
    confidence: z.number().min(0).max(1),
    source: z.enum(["authorized_user", "verified_task_result"]),
    projectId: identifierSchema.nullable(),
    replacesMemoryId: boundedTextSchema(256).nullable(),
  })
  .strict()
  .superRefine((candidate, context) => {
    if (candidate.scope === "project" && candidate.projectId === null) {
      context.addIssue({
        code: "custom",
        path: ["projectId"],
        message: "projectId is required for project-scoped memory",
      });
    }

    if (candidate.scope !== "project" && candidate.projectId !== null) {
      context.addIssue({
        code: "custom",
        path: ["projectId"],
        message: "projectId is allowed only for project-scoped memory",
      });
    }
  });

export const memoryCurationResultSchema = z
  .object({
    candidates: z.array(memoryCandidateSchema).max(20),
  })
  .strict();

export const approvalRequestSchema = z
  .object({
    id: identifierSchema,
    ownerId: identifierSchema,
    spaceId: identifierSchema,
    requestedByTaskId: identifierSchema,
    actionType: actionTypeSchema,
    normalizedPayload: jsonValueSchema,
    actionHash: z.string().regex(/^[a-f0-9]{64}$/),
    humanSummary: boundedTextSchema(1_000),
    expiresAt: z.iso.datetime(),
    status: z.enum([
      "pending",
      "approved",
      "rejected",
      "expired",
      "consumed",
    ]),
  })
  .strict();

export const artifactRefSchema = z
  .object({
    type: z.literal("file"),
    path: boundedTextSchema(1_024)
      .refine((value) => !value.startsWith("/"), "artifact path must be relative")
      .refine(
        (value) => !/^[a-z]:[\\/]/iu.test(value),
        "artifact path must not use an absolute drive path",
      )
      .refine(
        (value) => !value.split(/[\\/]+/u).includes(".."),
        "artifact path must remain inside the workspace",
      ),
    description: boundedTextSchema(500),
  })
  .strict();

export const executionTaskSchema = z
  .object({
    id: taskIdentifierSchema,
    agentName: workspaceBindingSchema,
    purpose: boundedTextSchema(500),
    instructions: boundedTextSchema(8_000),
    workspaceBinding: workspaceBindingSchema.nullable(),
    permissionProfile: permissionProfileNameSchema,
    dependsOn: z.array(taskIdentifierSchema).max(5),
  })
  .strict();

export const executionTaskGraphSchema = z
  .array(executionTaskSchema)
  .max(5, "a turn may contain at most five execution tasks")
  .superRefine((tasks, context) => {
    const tasksById = new Map(tasks.map((task) => [task.id, task]));

    if (tasksById.size !== tasks.length) {
      context.addIssue({
        code: "custom",
        message: "execution task IDs must be unique",
      });
      return;
    }

    for (const [index, task] of tasks.entries()) {
      for (const dependency of task.dependsOn) {
        if (!tasksById.has(dependency)) {
          context.addIssue({
            code: "custom",
            path: [index, "dependsOn"],
            message: `unknown execution task dependency: ${dependency}`,
          });
        }

        if (dependency === task.id) {
          context.addIssue({
            code: "custom",
            path: [index, "dependsOn"],
            message: "an execution task cannot depend on itself",
          });
        }
      }
    }

    const depths = new Map<string, number>();
    const visiting = new Set<string>();

    const depthOf = (taskId: string): number => {
      const cached = depths.get(taskId);
      if (cached !== undefined) {
        return cached;
      }

      if (visiting.has(taskId)) {
        throw new Error(`cycle:${taskId}`);
      }

      const task = tasksById.get(taskId);
      if (task === undefined) {
        return 0;
      }

      visiting.add(taskId);
      const depth =
        task.dependsOn.length === 0
          ? 1
          : 1 + Math.max(...task.dependsOn.map((dependency) => depthOf(dependency)));
      visiting.delete(taskId);
      depths.set(taskId, depth);
      return depth;
    };

    try {
      for (const task of tasks) {
        if (depthOf(task.id) > 3) {
          context.addIssue({
            code: "custom",
            message: "execution task dependency depth must not exceed three",
          });
          break;
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("cycle:")) {
        context.addIssue({
          code: "custom",
          message: "execution task dependencies must be acyclic",
        });
        return;
      }
      throw error;
    }
  });

export const interactionDecisionSchema = z
  .object({
    mode: z.enum(["direct", "delegate", "confirm", "silent"]),
    userMessage: boundedTextSchema(16_000).nullable(),
    statusMessage: boundedTextSchema(500).nullable(),
    tasks: executionTaskGraphSchema,
    waitForTasks: z.boolean(),
    memoryCandidates: z.array(memoryCandidateSchema).max(20),
  })
  .strict()
  .superRefine((decision, context) => {
    const addIssue = (path: string, message: string) => {
      context.addIssue({ code: "custom", path: [path], message });
    };

    if (decision.mode === "direct") {
      if (decision.userMessage === null) {
        addIssue("userMessage", "direct decisions require a userMessage");
      }
      if (decision.tasks.length !== 0) {
        addIssue("tasks", "direct decisions cannot contain execution tasks");
      }
      if (decision.waitForTasks) {
        addIssue("waitForTasks", "direct decisions cannot wait for tasks");
      }
    }

    if (decision.mode === "delegate") {
      if (decision.tasks.length === 0) {
        addIssue("tasks", "delegate decisions require at least one execution task");
      }
      if (!decision.waitForTasks) {
        addIssue("waitForTasks", "delegate decisions must wait for task synthesis");
      }
      if (decision.userMessage !== null) {
        addIssue(
          "userMessage",
          "delegate decisions use statusMessage before synthesis, not userMessage",
        );
      }
    }

    if (decision.mode === "confirm") {
      if (decision.userMessage === null) {
        addIssue("userMessage", "confirm decisions require a userMessage");
      }
      if (decision.tasks.length !== 0 || decision.waitForTasks) {
        addIssue("tasks", "confirm decisions cannot start execution tasks");
      }
    }

    if (decision.mode === "silent") {
      if (
        decision.userMessage !== null ||
        decision.statusMessage !== null ||
        decision.tasks.length !== 0 ||
        decision.waitForTasks ||
        decision.memoryCandidates.length !== 0
      ) {
        addIssue(
          "mode",
          "silent decisions cannot contain user-visible output, tasks, or memory candidates",
        );
      }
    }

    if (decision.mode !== "delegate" && decision.statusMessage !== null) {
      addIssue("statusMessage", "statusMessage is allowed only for delegated work");
    }
  });

export const executionErrorSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
    retryable: z.boolean(),
    safeMessage: boundedTextSchema(1_000),
  })
  .strict();

const codexNormalizedPayloadSchema = boundedTextSchema(32_000).transform(
  (value, context): JsonValue => {
    let decoded: unknown;
    try {
      decoded = JSON.parse(value) as unknown;
    } catch {
      context.addIssue({
        code: "custom",
        message: "normalizedPayload must contain valid JSON text",
      });
      return z.NEVER;
    }
    const parsed = jsonValueSchema.safeParse(decoded);
    if (!parsed.success) {
      context.addIssue({
        code: "custom",
        message: "normalizedPayload must decode to a finite JSON value",
      });
      return z.NEVER;
    }
    return parsed.data;
  },
);

const codexProposedActionSchema = z
  .object({
    actionType: actionTypeSchema,
    target: boundedTextSchema(512),
    normalizedPayload: codexNormalizedPayloadSchema,
    humanSummary: boundedTextSchema(1_000),
  })
  .strict();

interface ExecutionResultInvariant {
  status: "succeeded" | "failed" | "canceled" | "needs_approval";
  proposedActions: readonly unknown[];
  error: z.infer<typeof executionErrorSchema> | null;
}

function validateExecutionResult(
  result: ExecutionResultInvariant,
  context: z.core.$RefinementCtx<ExecutionResultInvariant>,
): void {
  if (result.status === "failed" && result.error === null) {
    context.addIssue({
      code: "custom",
      path: ["error"],
      message: "failed execution results require a safe error",
    });
  }

  if (result.status === "succeeded" && result.error !== null) {
    context.addIssue({
      code: "custom",
      path: ["error"],
      message: "succeeded execution results cannot contain an error",
    });
  }

  if (result.status === "needs_approval" && result.proposedActions.length !== 1) {
    context.addIssue({
      code: "custom",
      path: ["proposedActions"],
      message: "needs_approval results require exactly one proposed action",
    });
  }

  if (result.status !== "needs_approval" && result.proposedActions.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["proposedActions"],
      message: "proposed actions require needs_approval status",
    });
  }
}

const executionResultShape = {
  taskId: taskIdentifierSchema,
  status: z.enum(["succeeded", "failed", "canceled", "needs_approval"]),
  userSafeSummary: boundedTextSchema(4_000),
  artifacts: z.array(artifactRefSchema).max(20),
  memoryCandidates: z.array(memoryCandidateSchema).max(20),
  error: executionErrorSchema.nullable(),
} as const;

export const executionResultSchema = z
  .object({
    ...executionResultShape,
    proposedActions: z.array(proposedActionSchema).max(1),
  })
  .strict()
  .superRefine(validateExecutionResult);

/**
 * Provider-facing execution schema. Arbitrary JSON objects are encoded as JSON
 * text because strict Structured Outputs cannot describe free-form object keys.
 * Parsing decodes that text back into the operational ExecutionResult contract.
 */
export const codexExecutionResultSchema = z
  .object({
    ...executionResultShape,
    proposedActions: z.array(codexProposedActionSchema).max(1),
  })
  .strict()
  .superRefine(validateExecutionResult);

export type AuthorizedInbound = z.infer<typeof authorizedInboundSchema>;
export type MemoryCandidate = z.infer<typeof memoryCandidateSchema>;
export type MemoryCurationResult = z.infer<typeof memoryCurationResultSchema>;
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;
export type ArtifactRef = z.infer<typeof artifactRefSchema>;
export type ExecutionTask = z.infer<typeof executionTaskSchema>;
export type InteractionDecision = z.infer<typeof interactionDecisionSchema>;
export type ExecutionError = z.infer<typeof executionErrorSchema>;
export type ExecutionResult = z.infer<typeof executionResultSchema>;
