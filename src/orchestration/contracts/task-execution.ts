import type { ModelSelection } from "../../agent/model-selection.js";
import type { ExecutionResult, ExecutionTask } from "../../agent/schemas.js";
import type { PermissionProfileName } from "../../security/permissions.js";
import type { QueuedAuthorizationReference } from "../../security/queued-authorization.js";
import type { TaskExecutePayload } from "../../queue/payloads.js";

export interface TaskExecutionContext {
  chainId: string;
  ownerId: string;
  authorizationReference?: QueuedAuthorizationReference;
  task: ExecutionTask;
  modelSelection: ModelSelection;
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
  needsApprovalTaskIds?: readonly string[];
}

export interface TaskAttemptFailureOutcome extends TaskTerminalOutcome {
  retry: boolean;
}

export interface CompleteTaskInput {
  payload: TaskExecutePayload;
  result: ExecutionResult;
  threadId?: string;
  promptSha256: string;
  recovered: boolean;
}

export interface FailTaskAttemptInput {
  payload: TaskExecutePayload;
  result: ExecutionResult;
}

export interface TaskExecutionRepositoryContract {
  claimTask(payload: TaskExecutePayload): Promise<TaskExecutionContext | null>;
  denyTaskCodexStart(input: {
    payload: TaskExecutePayload;
    errorCode: string;
  }): Promise<TaskTerminalOutcome>;
  completeTask(input: CompleteTaskInput): Promise<TaskTerminalOutcome>;
  failTaskAttempt(
    input: FailTaskAttemptInput,
  ): Promise<TaskAttemptFailureOutcome>;
}
