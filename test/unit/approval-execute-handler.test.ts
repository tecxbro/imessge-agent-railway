import { describe, expect, it, vi } from "vitest";

import {
  ActionExecutorError,
  type ActionExecutorInput,
  type ActionExecutor,
} from "../../src/actions/action-executor.js";
import { ActionExecutorRegistry } from "../../src/actions/action-executor-registry.js";
import type {
  ActionExecutionFailureOutcome,
  RecordActionExecutionFailureInput,
  StoredActionExecution,
} from "../../src/db/repositories/action-executions.js";
import {
  createApprovalExecuteHandler,
  type ApprovalActionExecutionRepository,
} from "../../src/queue/handlers/approval-execute.js";
import {
  canonicalJson,
  createApprovalPayloadCipher,
  hashApprovedAction,
  type ApprovalChainProgression,
} from "../../src/security/approvals.js";

const ownerId = "52000000-0000-4000-8000-000000000001";
const spaceId = "52000000-0000-4000-8000-000000000002";
const chainId = "52000000-0000-4000-8000-000000000003";
const taskId = "52000000-0000-4000-8000-000000000004";
const approvalId = "52000000-0000-4000-8000-000000000005";
const actionExecutionId = "52000000-0000-4000-8000-000000000006";
const cipher = createApprovalPayloadCipher("54".repeat(32));
const action = {
  actionType: "external.send" as const,
  target: "release@example.com",
  normalizedPayload: {
    recipient: "release@example.com",
    body: "exact stored body",
  },
};

function stored(overrides: Partial<StoredActionExecution> = {}): StoredActionExecution {
  return {
    actionExecutionId,
    approvalId,
    executionTaskId: taskId,
    ownerId,
    spaceId,
    chainId,
    actionType: action.actionType,
    actionHash: hashApprovedAction(
      { ownerId, spaceId, executionTaskId: taskId },
      action,
    ),
    normalizedPayloadCiphertext: cipher.encrypt(
      canonicalJson({
        actionType: action.actionType,
        target: action.target,
        payload: action.normalizedPayload,
      }),
    ),
    ...overrides,
  };
}

const progression: ApprovalChainProgression = {
  chainId,
  expectedChainVersion: 2,
  newlyRunnableTasks: [],
  shouldSynthesize: true,
};

class MemoryActionExecutionRepository
  implements ApprovalActionExecutionRepository
{
  public state: "pending" | "running" | "succeeded" | "failed" = "pending";
  public readonly failures: RecordActionExecutionFailureInput[] = [];
  public completeCount = 0;

  public constructor(public readonly value: StoredActionExecution) {}

  public async claimActionExecution(): Promise<StoredActionExecution | null> {
    if (this.state !== "pending") {
      return null;
    }
    this.state = "running";
    return structuredClone(this.value);
  }

  public async completeActionExecution(): Promise<ApprovalChainProgression | null> {
    if (this.state !== "running") {
      return null;
    }
    this.state = "succeeded";
    this.completeCount += 1;
    return progression;
  }

  public async loadCompletedProgression(): Promise<ApprovalChainProgression | null> {
    return this.state === "succeeded" || this.state === "failed"
      ? progression
      : null;
  }

  public async recordActionExecutionFailure(
    input: RecordActionExecutionFailureInput,
  ): Promise<ActionExecutionFailureOutcome> {
    this.failures.push(input);
    if (this.state !== "running") {
      return { retry: false, progression: null };
    }
    if (input.retryable) {
      this.state = "pending";
      return { retry: true, progression: null };
    }
    this.state = "failed";
    return { retry: false, progression };
  }
}

function publisher() {
  return {
    enqueueNewlyRunnableTask: vi.fn(async () => undefined),
    enqueueApprovalSynthesis: vi.fn(async () => undefined),
  };
}

describe("approval action execution worker", () => {
  it("dispatches only the exact stored payload and ignores duplicate delivery", async () => {
    const execute = vi.fn(
      async (_input: ActionExecutorInput, _signal: AbortSignal) => ({
        safeSummary: "The prepared message was sent.",
        providerReference: "provider-message-1",
        safeMetadata: { delivered: true },
      }),
    );
    const executor: ActionExecutor = {
      actionType: "external.send",
      execute,
    };
    const repository = new MemoryActionExecutionRepository(stored());
    const progressionPublisher = publisher();
    progressionPublisher.enqueueApprovalSynthesis.mockRejectedValueOnce(
      new Error("queue temporarily unavailable"),
    );
    const handler = createApprovalExecuteHandler({
      repository,
      executors: new ActionExecutorRegistry([executor]),
      cipher,
      publisher: progressionPublisher,
    });

    await expect(handler({ actionExecutionId })).rejects.toThrow(
      /queue temporarily unavailable/,
    );
    await expect(handler({ actionExecutionId })).resolves.toBeUndefined();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      {
        actionExecutionId,
        actionType: "external.send",
        target: "release@example.com",
        normalizedPayload: {
          recipient: "release@example.com",
          body: "exact stored body",
        },
      },
      expect.any(AbortSignal),
    );
    expect(execute.mock.calls[0]?.[0]).not.toHaveProperty("humanSummary");
    expect(repository.completeCount).toBe(1);
    expect(progressionPublisher.enqueueApprovalSynthesis).toHaveBeenCalledTimes(
      2,
    );
  });

  it("fails exact hash binding closed before calling a provider", async () => {
    const execute = vi.fn(async () => ({
      safeSummary: "must not happen",
      providerReference: null,
      safeMetadata: {},
    }));
    const repository = new MemoryActionExecutionRepository(
      stored({ actionHash: "f".repeat(64) }),
    );
    const handler = createApprovalExecuteHandler({
      repository,
      executors: new ActionExecutorRegistry([
        { actionType: "external.send", execute },
      ]),
      cipher,
      publisher: publisher(),
    });

    await handler({ actionExecutionId });

    expect(execute).not.toHaveBeenCalled();
    expect(repository.state).toBe("failed");
    expect(repository.failures[0]).toMatchObject({
      actionExecutionId,
      errorCode: "APPROVED_ACTION_INVALID",
      retryable: false,
    });
  });

  it("retries the provider with the same actionExecutionId", async () => {
    const observedIds: string[] = [];
    let attempt = 0;
    const executor: ActionExecutor = {
      actionType: "external.send",
      async execute(input) {
        observedIds.push(input.actionExecutionId);
        attempt += 1;
        if (attempt === 1) {
          throw new ActionExecutorError(
            "PROVIDER_TEMPORARY_FAILURE",
            "provider unavailable",
            true,
            "The action provider is temporarily unavailable.",
          );
        }
        return {
          safeSummary: "The prepared message was sent.",
          providerReference: "provider-message-2",
          safeMetadata: {},
        };
      },
    };
    const repository = new MemoryActionExecutionRepository(stored());
    const handler = createApprovalExecuteHandler({
      repository,
      executors: new ActionExecutorRegistry([executor]),
      cipher,
      publisher: publisher(),
    });

    await expect(handler({ actionExecutionId })).rejects.toThrow(
      /provider unavailable/,
    );
    await expect(handler({ actionExecutionId })).resolves.toBeUndefined();

    expect(observedIds).toEqual([actionExecutionId, actionExecutionId]);
    expect(repository.state).toBe("succeeded");
    expect(repository.completeCount).toBe(1);
  });
});
