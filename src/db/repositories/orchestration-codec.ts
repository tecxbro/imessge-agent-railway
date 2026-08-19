import {
  executionResultSchema,
  interactionDecisionSchema,
  type ExecutionResult,
} from "../../agent/schemas.js";

export type ParsedInteractionDecision = ReturnType<
  typeof interactionDecisionSchema.parse
>;

export function taskStateForResult(result: ExecutionResult) {
  return result.status;
}

export function decisionForStorage(decision: ParsedInteractionDecision) {
  return {
    mode: decision.mode,
    hasUserMessage: decision.userMessage !== null,
    hasStatusMessage: decision.statusMessage !== null,
    waitForTasks: decision.waitForTasks,
    memoryCandidateCount: decision.memoryCandidates.length,
    tasks: decision.tasks.map((task) => ({
      id: task.id,
      agentName: task.agentName,
      workspaceBinding: task.workspaceBinding ?? task.agentName,
      permissionProfile: task.permissionProfile,
      dependsOn: task.dependsOn,
    })),
  };
}

export function safeDependencyFailure(taskId: string): ExecutionResult {
  return executionResultSchema.parse({
    taskId,
    status: "failed",
    userSafeSummary:
      "This task could not run because a required earlier task did not complete successfully.",
    artifacts: [],
    proposedActions: [],
    memoryCandidates: [],
    error: {
      code: "DEPENDENCY_NOT_SUCCEEDED",
      retryable: false,
      safeMessage:
        "Resolve or retry the failed prerequisite before retrying this task.",
    },
  });
}

export function safeAttemptsExhausted(taskId: string): ExecutionResult {
  return executionResultSchema.parse({
    taskId,
    status: "failed",
    userSafeSummary:
      "This task stopped after its bounded retry attempts were exhausted.",
    artifacts: [],
    proposedActions: [],
    memoryCandidates: [],
    error: {
      code: "TASK_ATTEMPTS_EXHAUSTED",
      retryable: false,
      safeMessage:
        "Narrow the task or resolve the runtime failure before retrying it in a new turn.",
    },
  });
}

export class OrchestrationCodec {
  public constructor(
    private readonly encrypt: (
      plaintext: string,
    ) => Promise<string> | string,
  ) {}

  public parseDecision(decision: unknown): ParsedInteractionDecision {
    return interactionDecisionSchema.parse(decision);
  }

  public decisionForStorage(decision: ParsedInteractionDecision) {
    return decisionForStorage(decision);
  }

  public safeDependencyFailure(taskId: string): ExecutionResult {
    return safeDependencyFailure(taskId);
  }

  public safeAttemptsExhausted(taskId: string): ExecutionResult {
    return safeAttemptsExhausted(taskId);
  }

  public async resultForStorage(
    result: ExecutionResult,
  ): Promise<Record<string, unknown>> {
    return {
      ciphertext: await this.encrypt(JSON.stringify(result)),
    };
  }
}
