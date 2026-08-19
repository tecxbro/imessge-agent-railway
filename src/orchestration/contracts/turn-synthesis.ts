import type { ModelSelection } from "../../agent/model-selection.js";
import type {
  ExecutionResult,
  InteractionDecision,
} from "../../agent/schemas.js";
import type { TurnSynthesizePayload } from "../../queue/payloads.js";
import type { QueuedAuthorizationReference } from "../../security/queued-authorization.js";

export interface TurnSynthesisContext {
  deploymentId: string;
  ownerId: string;
  spaceId: string;
  chainId: string;
  chainVersion: number;
  authorizationReference?: QueuedAuthorizationReference;
  userRequest: string;
  conversationHistory: readonly string[];
  priorStatusMessage?: string;
  terminalResults: readonly unknown[];
  modelSelection: ModelSelection;
  interactionWorkingDirectory: string;
  recoverySummary?: string;
}

export interface SynthesisFinalCommitInput {
  payload: TurnSynthesizePayload;
  decision: InteractionDecision | unknown;
  terminalResults: readonly ExecutionResult[];
  promptVersion: string;
  promptSha256: string;
  encryptedParts: readonly string[];
}

export interface TurnSynthesisRepositoryContract {
  loadSynthesisContext(
    payload: TurnSynthesizePayload,
  ): Promise<TurnSynthesisContext | null>;
  commitFinal(
    input: SynthesisFinalCommitInput,
  ): Promise<{ outboundBatchId: string }>;
}
