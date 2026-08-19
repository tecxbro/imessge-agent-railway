import type { ModelSelection } from "../../agent/model-selection.js";
import type {
  ExecutionTask,
  InteractionDecision,
} from "../../agent/schemas.js";
import type { StatusHistoryEntry } from "../../messaging/status-policy.js";
import type { TurnPlanPayload } from "../../queue/payloads.js";
import type { ExecutionCapability } from "./capabilities.js";
import type { QueuedAuthorizationReference } from "../../security/queued-authorization.js";

export interface ActiveAgentContext {
  name: string;
  status: "active" | "idle" | "reset" | "disabled";
  summary?: string;
}

export interface TurnPlanContext {
  deploymentId: string;
  ownerId: string;
  spaceId: string;
  chainId: string;
  chainVersion: number;
  authorizationReference?: QueuedAuthorizationReference;
  currentUserMessage: string;
  combinedTurnText: string;
  conversationHistory: readonly string[];
  activeAgents: readonly ActiveAgentContext[];
  capabilities: readonly ExecutionCapability[];
  priorStatusMessages: readonly StatusHistoryEntry[];
  modelSelection: ModelSelection;
  interactionWorkingDirectory: string;
  recoverySummary?: string;
}

export interface PersistedExecutionTaskInput {
  task: ExecutionTask;
  instructionsCiphertext: string;
}

export interface QueuedExecutionTask {
  taskId: string;
}

export interface TurnPlanCommitBase {
  payload: TurnPlanPayload;
  decision: InteractionDecision;
  promptVersion: string;
  promptSha256?: string;
}

export type PlanFinalCommitInput = TurnPlanCommitBase & {
  encryptedParts: readonly string[];
};

export interface TurnPlanRepositoryContract {
  loadPlanContext(payload: TurnPlanPayload): Promise<TurnPlanContext | null>;
  commitFinal(
    input: PlanFinalCommitInput,
  ): Promise<{ outboundBatchId: string }>;
  commitDelegation(
    input: TurnPlanCommitBase & {
      tasks: readonly PersistedExecutionTaskInput[];
      rootLogicalTaskIds: readonly string[];
    },
  ): Promise<{ rootTasks: readonly QueuedExecutionTask[] }>;
  commitSilent(input: TurnPlanCommitBase): Promise<void>;
}
