import { describe, expect, it, vi } from "vitest";

import type {
  InteractionRuntimeRequest,
  InteractionRuntimeResult,
} from "../../src/agent/interaction-runtime.js";
import type { InteractionDecision } from "../../src/agent/schemas.js";
import { DEFAULT_MODEL_SELECTION } from "../../src/agent/model-selection.js";
import type { CommandHandlersDependencies } from "../../src/commands/handlers.js";
import { loadPromptBundle } from "../../src/config/prompt-bundle.js";
import {
  createTurnPlanHandler,
  type TurnPlanContext,
  type TurnPlanRepository,
} from "../../src/queue/handlers/turn-plan.js";
import type { QueuePublisher } from "../../src/queue/publisher.js";

const chainId = "00000000-0000-4000-8000-000000000001";
const payload = {
  chainId,
  expectedChainVersion: 3,
  expectedState: "queued" as const,
};

function planContext(currentUserMessage: string): TurnPlanContext {
  return {
    deploymentId: "00000000-0000-4000-8000-000000000010",
    ownerId: "00000000-0000-4000-8000-000000000011",
    spaceId: "00000000-0000-4000-8000-000000000012",
    chainId,
    chainVersion: 3,
    currentUserMessage,
    combinedTurnText: currentUserMessage,
    conversationHistory: [],
    activeAgents: [],
    capabilities: [
      {
        workspaceBinding: "primary-repo",
        permissionProfiles: ["read"],
      },
      {
        workspaceBinding: "research",
        permissionProfiles: ["network-read"],
      },
    ],
    priorStatusMessages: [],
    modelSelection: DEFAULT_MODEL_SELECTION,
    interactionWorkingDirectory: "/tmp",
  };
}

function commandHandlers(): CommandHandlersDependencies {
  return {
    getStatus: vi.fn(async () => ({
      messaging: "ready",
      signIn: "ready",
      work: "ready",
      memory: "disabled",
      activeTaskCount: 0,
      modelSelection: DEFAULT_MODEL_SELECTION,
    } as const)),
    getModelSelection: vi.fn(async () => DEFAULT_MODEL_SELECTION),
    cancelActive: vi.fn(async () => ({ canceledCount: 0 })),
    resetInteractionThread: vi.fn(async () => undefined),
    listAgents: vi.fn(async () => []),
  };
}

function interactionResult(decision: InteractionDecision): InteractionRuntimeResult {
  return {
    decision,
    threadId: "interaction-thread",
    promptSha256: "a".repeat(64),
    usage: null,
    recovered: false,
  };
}

function fakes(context: TurnPlanContext, decision: InteractionDecision) {
  const repository: TurnPlanRepository = {
    loadPlanContext: vi.fn(async () => context),
    commitFinal: vi.fn(async () => ({ outboundBatchId: "batch-direct" })),
    commitDelegation: vi.fn(async () => ({
      rootTasks: [
        { taskId: "00000000-0000-4000-8000-000000000021" },
        { taskId: "00000000-0000-4000-8000-000000000022" },
      ],
    })),
    commitSilent: vi.fn(async () => undefined),
  };
  const interaction = {
    run: vi.fn(
      async (_request: InteractionRuntimeRequest) => interactionResult(decision),
    ),
  };
  const publisher: Pick<
    QueuePublisher,
    "enqueueTaskExecute" | "enqueueOutboundSend"
  > = {
    enqueueTaskExecute: vi.fn(async () => undefined),
    enqueueOutboundSend: vi.fn(async () => undefined),
  };
  const recallMemory = vi.fn(async () => ({
    available: true,
    ownerProfile: [],
    recalledMemories: [],
  }));
  return { repository, interaction, publisher, recallMemory };
}

describe("Step 5 turn-plan handler", () => {
  it("commits a direct answer after exactly one interaction call and creates no task", async () => {
    const decision: InteractionDecision = {
      mode: "direct",
      userMessage: "Hey! What’s up?",
      statusMessage: null,
      tasks: [],
      waitForTasks: false,
      memoryCandidates: [],
    };
    const context = planContext("hello");
    const fake = fakes(context, decision);
    const handler = createTurnPlanHandler({
      ...fake,
      commandHandlers: commandHandlers(),
      promptBundle: await loadPromptBundle(),
      encrypt: (plaintext) => `encrypted:${plaintext}`,
    });

    await handler(payload);

    expect(fake.interaction.run).toHaveBeenCalledTimes(1);
    expect(fake.interaction.run).toHaveBeenCalledWith(
      expect.objectContaining({
        modelProfile: { model: "gpt-5.6-luna", effort: "high" },
      }),
    );
    expect(fake.repository.commitFinal).toHaveBeenCalledWith(
      expect.objectContaining({
        payload,
        decision,
        encryptedParts: ["encrypted:Hey! What’s up?"],
      }),
    );
    expect(fake.repository.commitDelegation).not.toHaveBeenCalled();
    expect(fake.publisher.enqueueTaskExecute).not.toHaveBeenCalled();
    expect(fake.publisher.enqueueOutboundSend).toHaveBeenCalledWith({
      outboundBatchId: "batch-direct",
      expectedState: "queued",
    });
  });

  it("commits a bounded DAG and enqueues both independent roots together", async () => {
    const decision: InteractionDecision = {
      mode: "delegate",
      userMessage: null,
      statusMessage: "I’m checking the local behavior and provider contract now.",
      tasks: [
        {
          id: "inspect",
          agentName: "runtime-debugger",
          purpose: "Inspect local behavior.",
          instructions: "Return local evidence.",
          workspaceBinding: "primary-repo",
          permissionProfile: "read",
          dependsOn: [],
        },
        {
          id: "research",
          agentName: "provider-researcher",
          purpose: "Check provider guidance.",
          instructions: "Return official contract evidence.",
          workspaceBinding: "research",
          permissionProfile: "network-read",
          dependsOn: [],
        },
        {
          id: "compare",
          agentName: "runtime-debugger",
          purpose: "Compare the findings.",
          instructions: "Report the material mismatch.",
          workspaceBinding: "primary-repo",
          permissionProfile: "read",
          dependsOn: ["inspect", "research"],
        },
      ],
      waitForTasks: true,
      memoryCandidates: [],
    };
    const context = planContext("check the implementation and current guidance");
    const fake = fakes(context, decision);
    const sendStatus = vi.fn(async () => undefined);
    const handler = createTurnPlanHandler({
      ...fake,
      commandHandlers: commandHandlers(),
      promptBundle: await loadPromptBundle(),
      encrypt: (plaintext) => `encrypted:${plaintext}`,
      sendStatus,
    });

    await handler(payload);

    expect(fake.repository.commitDelegation).toHaveBeenCalledWith(
      expect.objectContaining({
        rootLogicalTaskIds: ["inspect", "research"],
      }),
    );
    expect(fake.publisher.enqueueTaskExecute).toHaveBeenCalledTimes(2);
    expect(fake.publisher.enqueueTaskExecute).toHaveBeenCalledWith({
      taskId: "00000000-0000-4000-8000-000000000021",
      chainId,
      expectedChainVersion: 3,
      expectedState: "queued",
    });
    expect(fake.publisher.enqueueTaskExecute).toHaveBeenCalledWith({
      taskId: "00000000-0000-4000-8000-000000000022",
      chainId,
      expectedChainVersion: 3,
      expectedState: "queued",
    });
    expect(fake.publisher.enqueueOutboundSend).not.toHaveBeenCalled();
    expect(sendStatus).toHaveBeenCalledTimes(1);
  });

  it("handles slash commands without memory recall or any interaction-model call", async () => {
    const unusedDecision: InteractionDecision = {
      mode: "direct",
      userMessage: "must not be used",
      statusMessage: null,
      tasks: [],
      waitForTasks: false,
      memoryCandidates: [],
    };
    const fake = fakes(planContext("/help"), unusedDecision);
    const handler = createTurnPlanHandler({
      ...fake,
      commandHandlers: commandHandlers(),
      promptBundle: await loadPromptBundle(),
      encrypt: (plaintext) => `encrypted:${plaintext}`,
    });

    await handler(payload);

    expect(fake.recallMemory).not.toHaveBeenCalled();
    expect(fake.interaction.run).not.toHaveBeenCalled();
    expect(fake.repository.commitFinal).toHaveBeenCalledTimes(1);
    expect(fake.publisher.enqueueOutboundSend).toHaveBeenCalledTimes(1);
  });
});
