import type { InteractionRuntime } from "../../agent/interaction-runtime.js";
import type { PromptSection } from "../../agent/prompt-builder.js";
import {
  executionResultSchema,
  interactionDecisionSchema,
  type ArtifactRef,
  type ExecutionResult,
  type InteractionDecision,
} from "../../agent/schemas.js";
import type { ModelProfileName, ModelProfiles } from "../../config/model-profiles.js";
import type { PromptBundle } from "../../config/prompt-bundle.js";
import { splitMessageBubbles } from "../../messaging/bubble-splitter.js";
import { assertUserFacingMessageSafe } from "../../messaging/user-visible-policy.js";
import type { QueuePublisher } from "../publisher.js";
import type { TurnSynthesizePayload } from "../payloads.js";

export interface UserSafeProposedAction {
  actionType: string;
  target: string;
  humanSummary: string;
}

export interface UserSafeSynthesisResult {
  resultId: string;
  status: ExecutionResult["status"];
  userSafeSummary: string;
  artifacts: readonly ArtifactRef[];
  proposedActions: readonly UserSafeProposedAction[];
  error: null | {
    code: string;
    retryable: boolean;
    safeMessage: string;
  };
}

/**
 * Re-validates the database boundary and deliberately drops task/agent names,
 * raw events, logs, memory suggestions, and normalized action payloads before
 * execution output is shown to the interaction thread.
 */
export function buildUserSafeSynthesisInput(
  input: readonly unknown[],
): UserSafeSynthesisResult[] {
  return input.map((value, index) => {
    const result = executionResultSchema.parse(value);
    return {
      resultId: `result-${index + 1}`,
      status: result.status,
      userSafeSummary: result.userSafeSummary,
      artifacts: result.artifacts,
      proposedActions: result.proposedActions.map((action) => ({
        actionType: action.actionType,
        target: action.target,
        humanSummary: action.humanSummary,
      })),
      error:
        result.error == null
          ? null
          : {
              code: result.error.code,
              retryable: result.error.retryable,
              safeMessage: result.error.safeMessage,
            },
    };
  });
}

export interface TurnSynthesisContext {
  deploymentId: string;
  ownerId: string;
  spaceId: string;
  chainId: string;
  chainVersion: number;
  userRequest: string;
  conversationHistory: readonly string[];
  priorStatusMessage?: string;
  terminalResults: readonly unknown[];
  selectedModelProfile: ModelProfileName;
  interactionWorkingDirectory: string;
  recoverySummary?: string;
}

export interface TurnSynthesisRepository {
  loadSynthesisContext(
    payload: TurnSynthesizePayload,
  ): Promise<TurnSynthesisContext | null>;
  commitFinal(input: {
    payload: TurnSynthesizePayload;
    decision: InteractionDecision;
    terminalResults: readonly ExecutionResult[];
    promptVersion: string;
    promptSha256: string;
    encryptedParts: readonly string[];
  }): Promise<{ outboundBatchId: string }>;
}

export interface TurnSynthesizeDependencies {
  repository: TurnSynthesisRepository;
  interaction: Pick<InteractionRuntime, "run">;
  publisher: Pick<QueuePublisher, "enqueueOutboundSend">;
  modelProfiles: ModelProfiles;
  promptBundle: PromptBundle;
  encrypt(plaintext: string): Promise<string> | string;
  maximumBubbleCharacters?: number;
}

function synthesisSections(
  context: TurnSynthesisContext,
  safeResults: readonly UserSafeSynthesisResult[],
  prompts: PromptBundle,
): PromptSection[] {
  return [
    {
      name: "Interaction system policy",
      trust: "trusted-policy",
      content: prompts.prompts["interaction.system.md"].content,
    },
    {
      name: "Voice policy",
      trust: "trusted-policy",
      content: prompts.prompts["voice-policy.md"].content,
    },
    {
      name: "Approval policy",
      trust: "trusted-policy",
      content: prompts.prompts["approval-policy.md"].content,
    },
    {
      name: "Synthesis boundary",
      trust: "trusted-policy",
      content:
        "Return one final direct or confirmation response. Do not delegate again. Preserve successful findings, disclose material failures, and never expose internal names, event streams, queues, models, or unrestricted logs.",
    },
    {
      name: "Current user request",
      trust: "untrusted-context",
      content: context.userRequest,
    },
    {
      name: "Conversation history",
      trust: "untrusted-context",
      content: JSON.stringify(context.conversationHistory, null, 2),
    },
    {
      name: "Prior status message",
      trust: "untrusted-context",
      content: context.priorStatusMessage ?? "none",
    },
    {
      name: "Structured execution results",
      trust: "untrusted-context",
      content: JSON.stringify(safeResults, null, 2),
    },
  ];
}

function withTruthfulPartialFailure(
  decision: InteractionDecision,
  safeResults: readonly UserSafeSynthesisResult[],
): InteractionDecision {
  if (decision.userMessage === null) {
    return decision;
  }
  const hasPartialFailure = safeResults.some(
    (result) => result.status === "failed" || result.status === "canceled",
  );
  if (!hasPartialFailure) {
    return decision;
  }
  const alreadyDisclosed =
    /\b(?:fail(?:ed|ure)?|cancel(?:ed|led)?|partial(?:ly)?|incomplete|couldn['’]?t|unable)\b/iu.test(
      decision.userMessage,
    );
  if (alreadyDisclosed) {
    return decision;
  }
  return interactionDecisionSchema.parse({
    ...decision,
    userMessage: `Some requested work couldn’t be completed. ${decision.userMessage}`,
  });
}

export function createTurnSynthesizeHandler(
  dependencies: TurnSynthesizeDependencies,
) {
  return async (
    payload: TurnSynthesizePayload,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<void> => {
    // Synthesis consumes terminal durable results and materializes every bubble
    // before publishing delivery, preventing a retry from regenerating text.
    const context = await dependencies.repository.loadSynthesisContext(payload);
    if (context === null) {
      return;
    }
    const terminalResults = context.terminalResults.map((result) =>
      executionResultSchema.parse(result),
    );
    const safeResults = buildUserSafeSynthesisInput(terminalResults);
    const run = await dependencies.interaction.run({
      ownerId: context.ownerId,
      spaceId: context.spaceId,
      modelProfile: dependencies.modelProfiles[context.selectedModelProfile],
      workingDirectory: context.interactionWorkingDirectory,
      sections: synthesisSections(
        context,
        safeResults,
        dependencies.promptBundle,
      ),
      ...(context.recoverySummary === undefined
        ? {}
        : { recoverySummary: context.recoverySummary }),
      signal,
    });
    signal.throwIfAborted();
    let decision = interactionDecisionSchema.parse(run.decision);
    if (decision.mode !== "direct" && decision.mode !== "confirm") {
      throw new Error(
        "Synthesis attempted another delegation or silent loop. Return one final direct or confirmation response.",
      );
    }
    if (
      terminalResults.some((result) => result.status === "needs_approval") &&
      decision.mode !== "confirm"
    ) {
      throw new Error(
        "Synthesis must request confirmation for a stored consequential action before any execution can continue.",
      );
    }
    decision = withTruthfulPartialFailure(decision, safeResults);
    const message = decision.userMessage;
    if (message === null) {
      throw new Error("Synthesis returned no final user-facing message.");
    }
    assertUserFacingMessageSafe(message);
    const bubbles = splitMessageBubbles(
      message,
      dependencies.maximumBubbleCharacters === undefined
        ? {}
        : { maxCharacters: dependencies.maximumBubbleCharacters },
    );
    if (bubbles.length === 0) {
      throw new Error("Synthesis returned no sendable message bubbles.");
    }
    const encryptedParts = await Promise.all(
      bubbles.map(async (bubble) => await dependencies.encrypt(bubble)),
    );
    const committed = await dependencies.repository.commitFinal({
      payload,
      decision,
      terminalResults,
      promptVersion: dependencies.promptBundle.version,
      promptSha256: run.promptSha256,
      encryptedParts,
    });
    await dependencies.publisher.enqueueOutboundSend({
      outboundBatchId: committed.outboundBatchId,
      expectedState: "queued",
    });
  };
}
