import { createHash } from "node:crypto";

import type { InteractionRuntime } from "../../agent/interaction-runtime.js";
import {
  asCodexModelProfile,
  type ModelSelection,
} from "../../agent/model-selection.js";
import type { PromptSection } from "../../agent/prompt-builder.js";
import {
  interactionDecisionSchema,
  type ExecutionTask,
  type InteractionDecision,
} from "../../agent/schemas.js";
import { executionTaskLevels } from "../../agent/task-graph.js";
import {
  handleSlashCommand,
  type CommandHandlersDependencies,
} from "../../commands/handlers.js";
import { parseSlashCommand } from "../../commands/parse.js";
import type { PromptBundle } from "../../config/prompt-bundle.js";
import { splitMessageBubbles } from "../../messaging/bubble-splitter.js";
import { assertUserFacingMessageSafe } from "../../messaging/user-visible-policy.js";
import {
  decideStatusMessage,
  type StatusHistoryEntry,
} from "../../messaging/status-policy.js";
import type { PermissionProfileName } from "../../security/permissions.js";
import type { QueuePublisher } from "../publisher.js";
import type { TurnPlanPayload } from "../payloads.js";

export interface ActiveAgentContext {
  name: string;
  status: "active" | "idle" | "reset" | "disabled";
  summary?: string;
}

export interface ExecutionCapability {
  workspaceBinding: string;
  permissionProfiles: readonly PermissionProfileName[];
}

export interface TurnMemoryContext {
  available: boolean;
  ownerProfile: readonly string[];
  recalledMemories: readonly string[];
}

export interface TurnPlanContext {
  deploymentId: string;
  ownerId: string;
  spaceId: string;
  chainId: string;
  chainVersion: number;
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

export interface TurnPlanRepository {
  loadPlanContext(payload: TurnPlanPayload): Promise<TurnPlanContext | null>;
  commitFinal(
    input: TurnPlanCommitBase & { encryptedParts: readonly string[] },
  ): Promise<{ outboundBatchId: string }>;
  commitDelegation(
    input: TurnPlanCommitBase & {
      tasks: readonly PersistedExecutionTaskInput[];
      rootLogicalTaskIds: readonly string[];
    },
  ): Promise<{ rootTasks: readonly QueuedExecutionTask[] }>;
  commitSilent(input: TurnPlanCommitBase): Promise<void>;
}

export interface TurnPlanDependencies {
  repository: TurnPlanRepository;
  interaction: Pick<InteractionRuntime, "run">;
  publisher: Pick<
    QueuePublisher,
    "enqueueTaskExecute" | "enqueueOutboundSend"
  >;
  commandHandlers: CommandHandlersDependencies;
  promptBundle: PromptBundle;
  encrypt(plaintext: string): Promise<string> | string;
  recallMemory(
    context: TurnPlanContext,
    signal: AbortSignal,
  ): Promise<TurnMemoryContext>;
  sendStatus?(input: {
    chainId: string;
    spaceId: string;
    message: string;
    clientGuid: string;
    signal: AbortSignal;
  }): Promise<void>;
  onStatusFailure?(error: unknown, chainId: string): void;
  maximumBubbleCharacters?: number;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function interactionSections(
  context: TurnPlanContext,
  memory: TurnMemoryContext,
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
      name: "Authenticated identity",
      trust: "trusted-policy",
      content: json({
        deploymentId: context.deploymentId,
        ownerId: context.ownerId,
        spaceId: context.spaceId,
      }),
    },
    {
      name: "Execution capabilities",
      trust: "trusted-policy",
      content: json(context.capabilities),
    },
    {
      name: "Owner profile",
      trust: "untrusted-context",
      content: json(memory.ownerProfile),
    },
    {
      name: "Recalled memory",
      trust: "untrusted-context",
      content: json(memory.recalledMemories),
    },
    {
      name: "Conversation history",
      trust: "untrusted-context",
      content: json(context.conversationHistory),
    },
    {
      name: "Active named contexts",
      trust: "untrusted-context",
      content: json(context.activeAgents),
    },
    {
      name: "New user message",
      trust: "untrusted-context",
      content: context.combinedTurnText,
    },
  ];
}

export function assertExecutionTasksAuthorized(
  tasks: readonly ExecutionTask[],
  capabilities: readonly ExecutionCapability[],
): void {
  for (const task of tasks) {
    const binding = task.workspaceBinding ?? task.agentName;
    const capability = capabilities.find(
      (candidate) => candidate.workspaceBinding === binding,
    );
    if (capability === undefined) {
      throw new Error(
        `Execution task ${task.id} requested an unavailable workspace binding. Configure the binding before retrying.`,
      );
    }
    if (!capability.permissionProfiles.includes(task.permissionProfile)) {
      throw new Error(
        `Execution task ${task.id} requested a permission profile that policy does not allow. Narrow the task before retrying.`,
      );
    }
  }
}

async function encryptedBubbles(
  message: string,
  dependencies: TurnPlanDependencies,
): Promise<string[]> {
  const bubbles = splitMessageBubbles(
    message,
    dependencies.maximumBubbleCharacters === undefined
      ? {}
      : { maxCharacters: dependencies.maximumBubbleCharacters },
  );
  if (bubbles.length === 0) {
    throw new Error(
      "The interaction response contained no sendable text. Retry the turn with a non-empty structured response.",
    );
  }
  return await Promise.all(
    bubbles.map(async (bubble) => await dependencies.encrypt(bubble)),
  );
}

function stableStatusGuid(deploymentId: string, chainId: string): string {
  return createHash("sha256")
    .update(`${deploymentId}:${chainId}:status:0`)
    .digest("hex");
}

export function createTurnPlanHandler(dependencies: TurnPlanDependencies) {
  return async (
    payload: TurnPlanPayload,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<void> => {
    // Queue payloads carry only identity/version hints. Reload every prompt,
    // routing, authorization, and capability input from authoritative storage.
    const context = await dependencies.repository.loadPlanContext(payload);
    if (context === null) {
      return;
    }

    const parsedCommand = parseSlashCommand(context.currentUserMessage);
    if (parsedCommand !== null) {
      const command = await handleSlashCommand(
        parsedCommand,
        {
          deploymentId: context.deploymentId,
          ownerId: context.ownerId,
          spaceId: context.spaceId,
          currentChainId: context.chainId,
        },
        dependencies.commandHandlers,
      );
      const decision = interactionDecisionSchema.parse({
        mode: "direct",
        userMessage: command.message,
        statusMessage: null,
        tasks: [],
        waitForTasks: false,
        memoryCandidates: [],
      });
      signal.throwIfAborted();
      const committed = await dependencies.repository.commitFinal({
        payload,
        decision,
        promptVersion: dependencies.promptBundle.version,
        encryptedParts: await encryptedBubbles(command.message, dependencies),
      });
      await dependencies.publisher.enqueueOutboundSend({
        outboundBatchId: committed.outboundBatchId,
        expectedState: "queued",
      });
      return;
    }

    const memory = await dependencies.recallMemory(context, signal);
    const run = await dependencies.interaction.run({
      ownerId: context.ownerId,
      spaceId: context.spaceId,
      modelProfile: asCodexModelProfile(context.modelSelection),
      workingDirectory: context.interactionWorkingDirectory,
      sections: interactionSections(
        context,
        memory,
        dependencies.promptBundle,
      ),
      ...(context.recoverySummary === undefined
        ? {}
        : { recoverySummary: context.recoverySummary }),
      signal,
    });
    signal.throwIfAborted();
    const decision = interactionDecisionSchema.parse(run.decision);
    const base: TurnPlanCommitBase = {
      payload,
      decision,
      promptVersion: dependencies.promptBundle.version,
      promptSha256: run.promptSha256,
    };

    if (decision.mode === "direct" || decision.mode === "confirm") {
      const message = decision.userMessage;
      if (message === null) {
        throw new Error("A user-facing interaction decision had no message.");
      }
      assertUserFacingMessageSafe(
        message,
        context.activeAgents.map((agent) => agent.name),
      );
      const committed = await dependencies.repository.commitFinal({
        ...base,
        encryptedParts: await encryptedBubbles(message, dependencies),
      });
      await dependencies.publisher.enqueueOutboundSend({
        outboundBatchId: committed.outboundBatchId,
        expectedState: "queued",
      });
      return;
    }

    if (decision.mode === "silent") {
      await dependencies.repository.commitSilent(base);
      return;
    }

    const levels = executionTaskLevels(decision.tasks);
    assertExecutionTasksAuthorized(decision.tasks, context.capabilities);
    const persistedTasks = await Promise.all(
      decision.tasks.map(async (task) => ({
        task,
        instructionsCiphertext: await dependencies.encrypt(task.instructions),
      })),
    );
    const committed = await dependencies.repository.commitDelegation({
      ...base,
      tasks: persistedTasks,
      rootLogicalTaskIds: (levels[0] ?? []).map((task) => task.id),
    });

    const status = decideStatusMessage({
      chainId: context.chainId,
      now: new Date(),
      estimatedDurationMs: 3_000,
      contactsExternalDependency: decision.tasks.some(
        (task) => task.permissionProfile === "network-read",
      ),
      ...(decision.statusMessage === null
        ? {}
        : { proposedMessage: decision.statusMessage }),
      priorMessages: context.priorStatusMessages,
    });
    if (
      status.send &&
      status.message !== undefined &&
      dependencies.sendStatus !== undefined
    ) {
      try {
        signal.throwIfAborted();
        await dependencies.sendStatus({
          chainId: context.chainId,
          spaceId: context.spaceId,
          message: status.message,
          clientGuid: stableStatusGuid(context.deploymentId, context.chainId),
          signal,
        });
      } catch (error) {
        dependencies.onStatusFailure?.(error, context.chainId);
      }
    }

    await Promise.all(
      committed.rootTasks.map(async ({ taskId }) => {
        await dependencies.publisher.enqueueTaskExecute({
          taskId,
          chainId: context.chainId,
          expectedChainVersion: context.chainVersion,
          expectedState: "queued",
        });
      }),
    );
  };
}
