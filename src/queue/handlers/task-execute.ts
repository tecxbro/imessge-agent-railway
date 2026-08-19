import {
  CodexRuntimeError,
  type CodexRuntimeErrorCode,
} from "../../agent/codex-client.js";
import type { ExecutionRuntime } from "../../agent/execution-runtime.js";
import {
  asCodexModelProfile,
  type ModelSelection,
} from "../../agent/model-selection.js";
import type { PromptSection } from "../../agent/prompt-builder.js";
import {
  executionResultSchema,
  executionTaskSchema,
  type ExecutionResult,
  type ExecutionTask,
} from "../../agent/schemas.js";
import type { PromptBundle } from "../../config/prompt-bundle.js";
import type { PermissionProfileName } from "../../security/permissions.js";
import { CodexStartDeniedError } from "../../security/queued-authorization.js";
import type { QueuePublisher } from "../publisher.js";
import type { TaskExecutePayload } from "../payloads.js";

export interface TaskExecutionContext {
  chainId: string;
  ownerId: string;
  task: ExecutionTask;
  modelSelection: ModelSelection;
  /** Re-resolved exact code-owned permission set at claim time. */
  authorizedPermissionProfiles: readonly PermissionProfileName[];
  resolvedWorkspacePath: string;
  relevantContext: readonly string[];
  recoverySummary?: string;
}

export interface ReadyExecutionTask {
  taskId: string;
}

export interface TaskTerminalOutcome {
  accepted: boolean;
  readyTasks: readonly ReadyExecutionTask[];
  shouldSynthesize: boolean;
}

export interface TaskAttemptFailureOutcome extends TaskTerminalOutcome {
  retry: boolean;
}

export interface TaskExecutionRepository {
  claimTask(payload: TaskExecutePayload): Promise<TaskExecutionContext | null>;
  denyTaskCodexStart?(input: {
    payload: TaskExecutePayload;
    errorCode: string;
  }): Promise<TaskTerminalOutcome>;
  completeTask(input: {
    payload: TaskExecutePayload;
    result: ExecutionResult;
    threadId?: string;
    promptSha256: string;
    recovered: boolean;
  }): Promise<TaskTerminalOutcome>;
  failTaskAttempt(input: {
    payload: TaskExecutePayload;
    result: ExecutionResult;
  }): Promise<TaskAttemptFailureOutcome>;
}

export interface TaskExecuteDependencies {
  repository: TaskExecutionRepository;
  execution: Pick<ExecutionRuntime, "run">;
  publisher: Pick<
    QueuePublisher,
    "enqueueTaskExecute" | "enqueueTurnSynthesize"
  >;
  approvalPublisher?: Pick<QueuePublisher, "enqueueApprovalRequest">;
  promptBundle: PromptBundle;
  maximumRuntimeMs?: number;
  onPresenceEnd?(chainId: string): void;
}

function safeRuntimeMessage(code: CodexRuntimeErrorCode): string {
  switch (code) {
    case "CODEX_CANCELED":
      return "The task was canceled because a newer turn superseded it.";
    case "CODEX_TIMEOUT":
      return "The task exceeded its bounded runtime.";
    case "CODEX_AUTH_FAILED":
      return "The private agent sign-in needs operator attention.";
    case "CODEX_MODEL_UNSUPPORTED":
    case "CODEX_EFFORT_UNSUPPORTED":
      return "The configured reasoning profile is not supported by this deployment.";
    case "CODEX_OUTPUT_TOO_LARGE":
    case "CODEX_STRUCTURED_OUTPUT_INVALID":
      return "The task did not return a valid bounded result.";
    case "CODEX_SESSION_MISSING":
      return "The saved task context could not be resumed.";
    case "CODEX_INVOCATION_FAILED":
      return "The bounded task runtime failed before producing a result.";
  }
}

function runtimeFailure(taskId: string, error: unknown): ExecutionResult {
  if (error instanceof CodexStartDeniedError) {
    return executionResultSchema.parse({
      taskId,
      status: "failed",
      userSafeSummary:
        "This task was denied because its queued authorization is no longer valid.",
      artifacts: [],
      proposedActions: [],
      memoryCandidates: [],
      error: {
        code: error.code,
        retryable: false,
        safeMessage: error.message,
      },
    });
  }
  const runtimeError =
    error instanceof CodexRuntimeError
      ? error
      : new CodexRuntimeError(
          "CODEX_INVOCATION_FAILED",
          "The bounded task invocation failed.",
          true,
          { cause: error },
        );
  return executionResultSchema.parse({
    taskId,
    status: runtimeError.code === "CODEX_CANCELED" ? "canceled" : "failed",
    userSafeSummary: safeRuntimeMessage(runtimeError.code),
    artifacts: [],
    proposedActions: [],
    memoryCandidates: [],
    error: {
      code: runtimeError.code,
      retryable: runtimeError.retryable,
      safeMessage: safeRuntimeMessage(runtimeError.code),
    },
  });
}

function executionPolicySections(
  context: TaskExecutionContext,
  prompts: PromptBundle,
): PromptSection[] {
  return [
    {
      name: "Execution system policy",
      trust: "trusted-policy",
      content: prompts.prompts["execution.system.md"].content,
    },
    {
      name: "Approval policy",
      trust: "trusted-policy",
      content: prompts.prompts["approval-policy.md"].content,
    },
    {
      name: "Relevant task context",
      trust: "untrusted-context",
      content: JSON.stringify(context.relevantContext, null, 2),
    },
  ];
}

async function publishOutcome(
  payload: TaskExecutePayload,
  outcome: TaskTerminalOutcome,
  publisher: TaskExecuteDependencies["publisher"],
): Promise<void> {
  if (!outcome.accepted) {
    return;
  }
  await Promise.all(
    outcome.readyTasks.map(async ({ taskId }) => {
      await publisher.enqueueTaskExecute({
        taskId,
        chainId: payload.chainId,
        expectedChainVersion: payload.expectedChainVersion,
        expectedState: "queued",
      });
    }),
  );
  if (outcome.shouldSynthesize) {
    await publisher.enqueueTurnSynthesize({
      chainId: payload.chainId,
      expectedChainVersion: payload.expectedChainVersion,
      expectedState: "executing",
    });
  }
}

export function createTaskExecuteHandler(dependencies: TaskExecuteDependencies) {
  return async (
    payload: TaskExecutePayload,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<void> => {
    // Claim and version-check the durable task before Codex starts; completion
    // is committed through the same authoritative expected-chain contract.
    let context: TaskExecutionContext | null;
    try {
      context = await dependencies.repository.claimTask(payload);
    } catch (error) {
      if (
        error instanceof CodexStartDeniedError &&
        dependencies.repository.denyTaskCodexStart !== undefined
      ) {
        const outcome = await dependencies.repository.denyTaskCodexStart({
          payload,
          errorCode: error.code,
        });
        await publishOutcome(payload, outcome, dependencies.publisher);
        dependencies.onPresenceEnd?.(payload.chainId);
        return;
      }
      throw error;
    }
    if (context === null) {
      return;
    }
    const task = executionTaskSchema.parse(context.task);

    let run: Awaited<ReturnType<TaskExecuteDependencies["execution"]["run"]>>;
    try {
      run = await dependencies.execution.run({
        chainId: context.chainId,
        ownerId: context.ownerId,
        task,
        authorizedPermissionProfiles: context.authorizedPermissionProfiles,
        modelProfile: asCodexModelProfile(context.modelSelection),
        resolvedWorkspacePath: context.resolvedWorkspacePath,
        policySections: executionPolicySections(
          context,
          dependencies.promptBundle,
        ),
        ...(context.recoverySummary === undefined
          ? {}
          : { recoverySummary: context.recoverySummary }),
        signal,
        ...(dependencies.maximumRuntimeMs === undefined
          ? {}
          : { maximumRuntimeMs: dependencies.maximumRuntimeMs }),
      });
    } catch (error) {
      dependencies.onPresenceEnd?.(context.chainId);
      const failure = runtimeFailure(task.id, error);
      const outcome = await dependencies.repository.failTaskAttempt({
        payload,
        result: failure,
      });
      await publishOutcome(payload, outcome, dependencies.publisher);
      if (outcome.retry) {
        throw error;
      }
      return;
    }

    signal.throwIfAborted();
    const outcome = await dependencies.repository.completeTask({
      payload,
      result: executionResultSchema.parse(run.result),
      ...(run.threadId === undefined ? {} : { threadId: run.threadId }),
      promptSha256: run.promptSha256,
      recovered: run.recovered,
    });
    if (
      outcome.accepted &&
      run.result.status === "needs_approval" &&
      dependencies.approvalPublisher !== undefined
    ) {
      await dependencies.approvalPublisher.enqueueApprovalRequest({
        executionTaskId: payload.taskId,
      });
    }
    await publishOutcome(payload, outcome, dependencies.publisher);
  };
}
