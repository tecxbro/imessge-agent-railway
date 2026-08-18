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
import type { QueuePublisher } from "../publisher.js";
import type { TaskExecutePayload } from "../payloads.js";

export interface TaskExecutionContext {
  ownerId: string;
  task: ExecutionTask;
  modelSelection: ModelSelection;
  /** Re-resolved from the current code-owned workspace capability at claim time. */
  maximumPermissionProfile: PermissionProfileName;
  workspaceRoot: string;
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
  promptBundle: PromptBundle;
  maximumRuntimeMs?: number;
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
    const context = await dependencies.repository.claimTask(payload);
    if (context === null) {
      return;
    }
    const task = executionTaskSchema.parse(context.task);

    let run: Awaited<ReturnType<TaskExecuteDependencies["execution"]["run"]>>;
    try {
      run = await dependencies.execution.run({
        ownerId: context.ownerId,
        task,
        maximumPermissionProfile: context.maximumPermissionProfile,
        modelProfile: asCodexModelProfile(context.modelSelection),
        workspaceRoot: context.workspaceRoot,
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
    await publishOutcome(payload, outcome, dependencies.publisher);
  };
}
