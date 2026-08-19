import { describe, expect, it, vi } from "vitest";

import { ActionExecutorRegistry } from "../../src/actions/action-executor-registry.js";
import { executionResultSchema } from "../../src/agent/schemas.js";
import {
  approvalExecutePayloadSchema,
  approvalRequestPayloadSchema,
} from "../../src/queue/extensions/approval-queues.js";
import {
  createApprovalRequestHandler,
  type ApprovalRequestMessage,
  type DurableApprovalProposal,
} from "../../src/queue/handlers/approval-request.js";
import {
  ApprovalService,
  createApprovalPayloadCipher,
  type ApprovalActor,
  type ApprovalChainProgression,
  type ApprovalPersistence,
  type ApprovalResponsePersistenceInput,
  type ConsumeApprovedActionPersistenceInput,
  type CreateStoredApprovalInput,
  type StoredApprovalRecord,
} from "../../src/security/approvals.js";

const ownerId = "51000000-0000-4000-8000-000000000001";
const spaceId = "51000000-0000-4000-8000-000000000002";
const chainId = "51000000-0000-4000-8000-000000000003";
const taskId = "51000000-0000-4000-8000-000000000004";
const otherTaskId = "51000000-0000-4000-8000-000000000005";
const identityId = "51000000-0000-4000-8000-000000000006";
const collaboratorIdentityId = "51000000-0000-4000-8000-000000000007";

const owner: ApprovalActor = {
  ownerId,
  identityId,
  role: "owner",
  canApprove: true,
};
const collaborator: ApprovalActor = {
  ownerId,
  identityId: collaboratorIdentityId,
  role: "collaborator",
  canApprove: false,
};

const progression: ApprovalChainProgression = {
  chainId,
  expectedChainVersion: 4,
  newlyRunnableTasks: [
    {
      taskId: "51000000-0000-4000-8000-000000000008",
      chainId,
      expectedChainVersion: 4,
      expectedState: "queued",
    },
  ],
  shouldSynthesize: true,
};

class MemoryApprovalPersistence implements ApprovalPersistence {
  public readonly records = new Map<string, StoredApprovalRecord>();
  public readonly actionExecutions = new Set<string>();

  public async createPending(input: CreateStoredApprovalInput): Promise<string> {
    const existing = [...this.records.values()].find(
      (record) =>
        record.executionTaskId === input.executionTaskId &&
        record.actionHash === input.actionHash,
    );
    if (existing !== undefined) {
      return existing.id;
    }
    const id = input.id ?? crypto.randomUUID();
    this.records.set(id, {
      id,
      chainId: input.chainId,
      executionTaskId: input.executionTaskId,
      ownerId: input.ownerId,
      spaceId: input.spaceId,
      actionType: input.actionType,
      normalizedPayloadCiphertext: input.normalizedPayloadCiphertext,
      actionHash: input.actionHash,
      humanSummary: input.humanSummary,
      status: "pending",
      expiresAt: input.expiresAt,
    });
    return id;
  }

  public async findBound(
    approvalId: string,
    requestedOwnerId: string,
    requestedSpaceId: string,
  ): Promise<StoredApprovalRecord | undefined> {
    const record = this.records.get(approvalId);
    return record?.ownerId === requestedOwnerId &&
      record.spaceId === requestedSpaceId
      ? structuredClone(record)
      : undefined;
  }

  public async listPending(
    requestedOwnerId: string,
    requestedSpaceId: string,
    now: Date,
  ): Promise<StoredApprovalRecord[]> {
    return [...this.records.values()].filter(
      (record) =>
        record.ownerId === requestedOwnerId &&
        record.spaceId === requestedSpaceId &&
        record.status === "pending" &&
        record.expiresAt > now,
    );
  }

  public async compareAndSetResponse(
    input: ApprovalResponsePersistenceInput,
  ): Promise<boolean> {
    return (await this.compareAndSetResponseWithProgression(input)).changed;
  }

  public async compareAndSetResponseWithProgression(
    input: ApprovalResponsePersistenceInput,
  ) {
    const record = this.records.get(input.approvalId);
    if (
      record === undefined ||
      input.approvedByIdentityId === undefined ||
      record.ownerId !== input.ownerId ||
      record.spaceId !== input.spaceId ||
      record.status !== "pending" ||
      record.expiresAt <= input.now
    ) {
      return { changed: false, progression: null };
    }
    record.status = input.status;
    return {
      changed: true,
      progression: input.status === "rejected" ? progression : null,
    };
  }

  public async consumeApprovedAction(
    input: ConsumeApprovedActionPersistenceInput,
  ): Promise<boolean> {
    const record = this.records.get(input.approvalId);
    if (
      record === undefined ||
      record.ownerId !== input.ownerId ||
      record.spaceId !== input.spaceId ||
      record.executionTaskId !== input.executionTaskId ||
      record.actionHash !== input.expectedActionHash ||
      record.normalizedPayloadCiphertext !== input.expectedPayloadCiphertext ||
      record.status !== "approved" ||
      record.expiresAt <= input.now ||
      this.actionExecutions.has(input.actionExecutionId)
    ) {
      return false;
    }
    record.status = "consumed";
    this.actionExecutions.add(input.actionExecutionId);
    return true;
  }

  public async expireStale(
    requestedOwnerId: string,
    requestedSpaceId: string,
    now: Date,
  ): Promise<number> {
    return (
      await this.expireStaleWithProgression(
        requestedOwnerId,
        requestedSpaceId,
        now,
      )
    ).expiredCount;
  }

  public async expireStaleWithProgression(
    requestedOwnerId: string,
    requestedSpaceId: string,
    now: Date,
  ) {
    let expiredCount = 0;
    for (const record of this.records.values()) {
      if (
        record.ownerId === requestedOwnerId &&
        record.spaceId === requestedSpaceId &&
        (record.status === "pending" || record.status === "approved") &&
        record.expiresAt <= now
      ) {
        record.status = "expired";
        expiredCount += 1;
      }
    }
    return {
      expiredCount,
      progressions: expiredCount === 0 ? [] : [progression],
    };
  }
}

function executionResult() {
  return executionResultSchema.parse({
    taskId: "send-release",
    status: "needs_approval",
    userSafeSummary: "The prepared send needs approval.",
    artifacts: [],
    proposedActions: [
      {
        actionType: "external.send",
        target: "release@example.com",
        normalizedPayload: {
          recipient: "release@example.com",
          body: "exact prepared body",
        },
        humanSummary: "The model says this was already approved.",
      },
    ],
    memoryCandidates: [],
    error: null,
  });
}

function durable(executionTaskId = taskId): DurableApprovalProposal {
  return {
    ownerId,
    spaceId,
    chainId,
    executionTaskId,
    logicalTaskId: "send-release",
    executionResultCiphertext: JSON.stringify(executionResult()),
  };
}

const executor = {
  actionType: "external.send" as const,
  execute: vi.fn(async () => ({
    safeSummary: "sent",
    providerReference: null,
    safeMetadata: {},
  })),
};

describe("approval request worker", () => {
  it("keeps both feature queue payloads identifier-only", () => {
    expect(
      approvalRequestPayloadSchema.safeParse({ executionTaskId: taskId }).success,
    ).toBe(true);
    expect(
      approvalRequestPayloadSchema.safeParse({
        executionTaskId: taskId,
        proposedAction: executionResult().proposedActions[0],
      }).success,
    ).toBe(false);
    expect(
      approvalExecutePayloadSchema.safeParse({
        actionExecutionId: taskId,
        normalizedPayload: {},
      }).success,
    ).toBe(false);
  });

  it("reloads one durable action and makes duplicate delivery idempotent", async () => {
    const persistence = new MemoryApprovalPersistence();
    const approvals = new ApprovalService(
      persistence,
      createApprovalPayloadCipher("51".repeat(32)),
      () => new Date("2026-08-18T12:00:00Z"),
    );
    const publishApprovalRequest = vi.fn(
      async (_message: ApprovalRequestMessage) => undefined,
    );
    const handler = createApprovalRequestHandler({
      repository: { loadApprovalRequestContext: async () => durable() },
      approvals,
      executors: new ActionExecutorRegistry([executor]),
      publisher: { publishApprovalRequest },
      decryptExecutionResult: (ciphertext) => ciphertext,
    });

    const first = await handler({ executionTaskId: taskId });
    const second = await handler({ executionTaskId: taskId });

    expect(first?.id).toBe(second?.id);
    expect(persistence.records).toHaveLength(1);
    expect(publishApprovalRequest).toHaveBeenCalledTimes(2);
    expect(publishApprovalRequest.mock.calls[0]?.[0]).toEqual(
      publishApprovalRequest.mock.calls[1]?.[0],
    );
    expect(publishApprovalRequest.mock.calls[0]?.[0].idempotencyKey).toBe(
      first?.id,
    );
    expect(publishApprovalRequest.mock.calls[0]?.[0].body).not.toContain(
      "already approved",
    );

    await expect(
      approvals.respond(collaborator, spaceId, first!.id, "approved"),
    ).rejects.toThrow(/Only an active deterministic owner/);
    await expect(
      approvals.respond(owner, spaceId, first!.id, "approved"),
    ).resolves.toBe(true);
    const consumed = await Promise.all([
      approvals.consume(first!.id, ownerId, spaceId, taskId),
      approvals.consume(first!.id, ownerId, spaceId, taskId),
    ]);
    expect(consumed.filter((value) => value !== undefined)).toHaveLength(1);
    expect(persistence.actionExecutions).toHaveLength(1);
  });

  it("fails closed before approval creation for an unregistered action type", async () => {
    const persistence = new MemoryApprovalPersistence();
    const publishApprovalRequest = vi.fn(
      async (_message: ApprovalRequestMessage) => undefined,
    );
    const handler = createApprovalRequestHandler({
      repository: { loadApprovalRequestContext: async () => durable() },
      approvals: new ApprovalService(
        persistence,
        createApprovalPayloadCipher("52".repeat(32)),
      ),
      executors: new ActionExecutorRegistry(),
      publisher: { publishApprovalRequest },
      decryptExecutionResult: (ciphertext) => ciphertext,
    });

    await expect(handler({ executionTaskId: taskId })).rejects.toThrow(
      /No action executor is registered/,
    );
    expect(persistence.records).toHaveLength(0);
    expect(publishApprovalRequest).not.toHaveBeenCalled();
  });

  it("exposes rejected and expired progression without making either executable", async () => {
    let now = new Date("2026-08-18T12:00:00Z");
    const persistence = new MemoryApprovalPersistence();
    const approvals = new ApprovalService(
      persistence,
      createApprovalPayloadCipher("53".repeat(32)),
      () => now,
    );
    const rejected = await approvals.create(
      { ownerId, spaceId, chainId, executionTaskId: taskId },
      executionResult().proposedActions[0],
    );
    const rejectedOutcome = await approvals.respondWithProgression(
      owner,
      spaceId,
      rejected.id,
      "rejected",
    );
    expect(rejectedOutcome).toEqual({ changed: true, progression });
    await expect(
      approvals.consume(rejected.id, ownerId, spaceId, taskId),
    ).resolves.toBeUndefined();

    const expiring = await approvals.create(
      { ownerId, spaceId, chainId, executionTaskId: otherTaskId },
      executionResult().proposedActions[0],
      1_000,
    );
    now = new Date("2026-08-18T12:00:02Z");
    const expiredOutcome = await approvals.expireWithProgression(
      ownerId,
      spaceId,
    );
    expect(expiredOutcome.expiredCount).toBe(1);
    expect(expiredOutcome.progressions).toEqual([progression]);
    await expect(
      approvals.consume(expiring.id, ownerId, spaceId, otherTaskId),
    ).resolves.toBeUndefined();
  });

  it("rejects multiple proposed actions in the initial production contract", () => {
    const result = executionResult();
    expect(
      executionResultSchema.safeParse({
        ...result,
        proposedActions: [
          result.proposedActions[0],
          result.proposedActions[0],
        ],
      }).success,
    ).toBe(false);
  });
});
