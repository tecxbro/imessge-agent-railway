import { describe, expect, it, vi } from "vitest";

import type {
  InteractionRuntimeRequest,
  InteractionRuntimeResult,
} from "../../src/agent/interaction-runtime.js";
import type {
  ExecutionResult,
  InteractionDecision,
} from "../../src/agent/schemas.js";
import { DEFAULT_MODEL_SELECTION } from "../../src/agent/model-selection.js";
import { loadPromptBundle } from "../../src/config/prompt-bundle.js";
import {
  createTurnSynthesizeHandler,
  type TurnSynthesisContext,
  type TurnSynthesisRepository,
} from "../../src/queue/handlers/turn-synthesize.js";
import type { QueuePublisher } from "../../src/queue/publisher.js";

const payload = {
  chainId: "00000000-0000-4000-8000-000000000001",
  expectedChainVersion: 2,
  expectedState: "executing" as const,
};

const successfulResult: ExecutionResult = {
  taskId: "internal-inspection-task",
  status: "succeeded",
  userSafeSummary: "The persisted cursor protects the completed send part.",
  artifacts: [
    {
      type: "file",
      path: "reports/restart.md",
      description: "Restart evidence",
    },
  ],
  proposedActions: [],
  memoryCandidates: [],
  error: null,
};

const failedResult: ExecutionResult = {
  taskId: "internal-live-provider-task",
  status: "failed",
  userSafeSummary: "The live provider path could not be checked.",
  artifacts: [],
  proposedActions: [],
  memoryCandidates: [],
  error: {
    code: "PROVIDER_AUTH_MISSING",
    retryable: false,
    safeMessage: "Enroll the development account before retrying.",
  },
};

function synthesisContext(): TurnSynthesisContext {
  return {
    deploymentId: "00000000-0000-4000-8000-000000000010",
    ownerId: "00000000-0000-4000-8000-000000000011",
    spaceId: "00000000-0000-4000-8000-000000000012",
    chainId: payload.chainId,
    chainVersion: payload.expectedChainVersion,
    userRequest: "Verify restart behavior and the live provider path.",
    conversationHistory: [],
    priorStatusMessage: "I’m checking both paths now.",
    terminalResults: [successfulResult, failedResult],
    modelSelection: DEFAULT_MODEL_SELECTION,
    interactionWorkingDirectory: "/tmp",
  };
}

function runtimeResult(decision: InteractionDecision): InteractionRuntimeResult {
  return {
    decision,
    threadId: "interaction-thread",
    promptSha256: "a".repeat(64),
    usage: null,
    recovered: false,
  };
}

describe("Step 5 final synthesis handler", () => {
  it("keeps successful evidence, discloses partial failure, and hides internal task names", async () => {
    const context = synthesisContext();
    const repository: TurnSynthesisRepository = {
      loadSynthesisContext: vi.fn(async () => context),
      commitFinal: vi.fn(async () => ({ outboundBatchId: "batch-final" })),
    };
    const interaction = {
      run: vi.fn(async (request: InteractionRuntimeRequest) => {
        const structuredResults = request.sections.find(
          (section) => section.name === "Structured execution results",
        );
        expect(structuredResults?.content).toContain(
          "persisted cursor protects",
        );
        expect(structuredResults?.content).toContain("PROVIDER_AUTH_MISSING");
        expect(structuredResults?.content).not.toContain(
          "internal-live-provider-task",
        );
        return runtimeResult({
          mode: "direct",
          userMessage: "The persisted cursor is correct.",
          statusMessage: null,
          tasks: [],
          waitForTasks: false,
          memoryCandidates: [],
        });
      }),
    };
    const publisher: Pick<QueuePublisher, "enqueueOutboundSend"> = {
      enqueueOutboundSend: vi.fn(async () => undefined),
    };
    const handler = createTurnSynthesizeHandler({
      repository,
      interaction,
      publisher,
      promptBundle: await loadPromptBundle(),
      encrypt: (plaintext) => `encrypted:${plaintext}`,
    });

    await handler(payload);

    expect(interaction.run).toHaveBeenCalledTimes(1);
    expect(interaction.run).toHaveBeenCalledWith(
      expect.objectContaining({
        modelProfile: { model: "gpt-5.6-luna", effort: "high" },
      }),
    );
    expect(repository.commitFinal).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: expect.objectContaining({
          mode: "direct",
          userMessage: expect.stringMatching(
            /^part of that didn’t finish\./,
          ),
        }),
        encryptedParts: [
          expect.stringMatching(
            /^encrypted:part of that didn’t finish\./,
          ),
        ],
      }),
    );
    expect(publisher.enqueueOutboundSend).toHaveBeenCalledWith({
      outboundBatchId: "batch-final",
      expectedState: "queued",
    });
  });

  it("rejects a second delegation loop instead of starting unbounded work", async () => {
    const repository: TurnSynthesisRepository = {
      loadSynthesisContext: vi.fn(async () => synthesisContext()),
      commitFinal: vi.fn(async () => ({ outboundBatchId: "must-not-send" })),
    };
    const interaction = {
      run: vi.fn(async () =>
        runtimeResult({
          mode: "delegate",
          userMessage: null,
          statusMessage: null,
          tasks: [
            {
              id: "try-again",
              agentName: "runtime-debugger",
              purpose: "Start another execution loop.",
              instructions: "Do more work.",
              workspaceBinding: "primary-repo",
              permissionProfile: "read",
              dependsOn: [],
            },
          ],
          waitForTasks: true,
          memoryCandidates: [],
        }),
      ),
    };
    const publisher: Pick<QueuePublisher, "enqueueOutboundSend"> = {
      enqueueOutboundSend: vi.fn(async () => undefined),
    };
    const handler = createTurnSynthesizeHandler({
      repository,
      interaction,
      publisher,
      promptBundle: await loadPromptBundle(),
      encrypt: (plaintext) => plaintext,
    });

    await expect(handler(payload)).rejects.toThrow(/delegation.*loop/i);
    expect(repository.commitFinal).not.toHaveBeenCalled();
    expect(publisher.enqueueOutboundSend).not.toHaveBeenCalled();
  });
});
