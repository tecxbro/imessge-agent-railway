import { describe, expect, it } from "vitest";

import { AuthorizedCommandHandler } from "../../src/commands/handlers.js";
import {
  ApprovalService,
  canonicalJson,
  createApprovalPayloadCipher,
  hashApprovedAction,
  type ApprovalActor,
  type ApprovalPersistence,
  type CreateStoredApprovalInput,
  type StoredApprovalRecord,
} from "../../src/security/approvals.js";

const ownerId = "00000000-0000-4000-8000-000000000001";
const otherOwnerId = "00000000-0000-4000-8000-000000000002";
const spaceId = "00000000-0000-4000-8000-000000000003";
const otherSpaceId = "00000000-0000-4000-8000-000000000004";
const taskId = "00000000-0000-4000-8000-000000000005";
const chainId = "00000000-0000-4000-8000-000000000006";
const identityId = "00000000-0000-4000-8000-000000000007";
const collaboratorIdentityId = "00000000-0000-4000-8000-000000000008";

const proposed = {
  actionType: "external.send" as const,
  target: "billing@example.com",
  normalizedPayload: {
    subject: "Invoice",
    body: { format: "text", value: "Approved copy" },
    recipients: ["billing@example.com"],
  },
  humanSummary: "The model claims this was already approved.",
};

class MemoryApprovalPersistence implements ApprovalPersistence {
  public readonly records = new Map<string, StoredApprovalRecord>();

  public async createPending(input: CreateStoredApprovalInput): Promise<string> {
    const id = input.id ?? crypto.randomUUID();
    if ([...this.records.values()].some(
      (record) =>
        record.executionTaskId === input.executionTaskId &&
        (record.status === "pending" || record.status === "approved"),
    )) {
      throw new Error("active approval already exists");
    }
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
    return [...this.records.values()]
      .filter(
        (record) =>
          record.ownerId === requestedOwnerId &&
          record.spaceId === requestedSpaceId &&
          record.status === "pending" &&
          record.expiresAt > now,
      )
      .map((record) => structuredClone(record));
  }

  public async compareAndSetResponse(input: {
    approvalId: string;
    ownerId: string;
    spaceId: string;
    approvedByIdentityId?: string;
    status: "approved" | "rejected";
    now: Date;
  }): Promise<boolean> {
    const record = this.records.get(input.approvalId);
    if (
      record === undefined ||
      input.approvedByIdentityId === undefined ||
      record.ownerId !== input.ownerId ||
      record.spaceId !== input.spaceId ||
      record.status !== "pending" ||
      record.expiresAt <= input.now
    ) {
      return false;
    }
    record.status = input.status;
    return true;
  }

  public async consumeApprovedAction(input: {
    approvalId: string;
    ownerId: string;
    spaceId: string;
    executionTaskId: string;
    expectedActionHash: string;
    expectedPayloadCiphertext: string;
    now: Date;
  }): Promise<boolean> {
    const record = this.records.get(input.approvalId);
    if (
      record === undefined ||
      record.ownerId !== input.ownerId ||
      record.spaceId !== input.spaceId ||
      record.executionTaskId !== input.executionTaskId ||
      record.status !== "approved" ||
      record.expiresAt <= input.now ||
      record.actionHash !== input.expectedActionHash ||
      record.normalizedPayloadCiphertext !== input.expectedPayloadCiphertext
    ) {
      return false;
    }
    record.status = "consumed";
    return true;
  }

  public async expireStale(
    requestedOwnerId: string,
    requestedSpaceId: string,
    now: Date,
  ): Promise<number> {
    let expired = 0;
    for (const record of this.records.values()) {
      if (
        record.ownerId === requestedOwnerId &&
        record.spaceId === requestedSpaceId &&
        (record.status === "pending" || record.status === "approved") &&
        record.expiresAt <= now
      ) {
        record.status = "expired";
        expired += 1;
      }
    }
    return expired;
  }
}

function scope(overrides: Partial<{
  ownerId: string;
  spaceId: string;
  executionTaskId: string;
  chainId: string;
}> = {}) {
  return { ownerId, spaceId, executionTaskId: taskId, chainId, ...overrides };
}

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

describe("immutable code-backed approval protocol", () => {
  it("canonicalizes object keys and binds hashes to owner, space, task, target, and payload", () => {
    expect(canonicalJson({ z: 1, a: { d: 2, b: 3 } })).toBe(
      '{"a":{"b":3,"d":2},"z":1}',
    );
    const first = hashApprovedAction(scope(), proposed);
    const reordered = hashApprovedAction(scope(), {
      ...proposed,
      normalizedPayload: {
        recipients: ["billing@example.com"],
        body: { value: "Approved copy", format: "text" },
        subject: "Invoice",
      },
    });
    expect(reordered).toBe(first);
    expect(hashApprovedAction(scope({ ownerId: otherOwnerId }), proposed)).not.toBe(first);
    expect(hashApprovedAction(scope({ spaceId: otherSpaceId }), proposed)).not.toBe(first);
    expect(hashApprovedAction(scope(), { ...proposed, target: "other@example.com" })).not.toBe(first);
    expect(hashApprovedAction(scope(), {
      ...proposed,
      normalizedPayload: { ...proposed.normalizedPayload, subject: "Changed" },
    })).not.toBe(first);
  });

  it("ignores model approval claims, derives its own summary, and returns an immutable pending request", async () => {
    const persistence = new MemoryApprovalPersistence();
    const service = new ApprovalService(
      persistence,
      createApprovalPayloadCipher("11".repeat(32)),
      () => new Date("2026-08-14T12:00:00Z"),
    );
    const request = await service.create(scope(), proposed);

    expect(request.status).toBe("pending");
    expect(request.humanSummary).not.toContain("already approved");
    expect(request.humanSummary).toContain("external.send");
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.normalizedPayload)).toBe(true);
    expect(persistence.records.get(request.id)?.status).toBe("pending");
    await expect(
      service.create(scope({ executionTaskId: "00000000-0000-4000-8000-000000000009" }), {
        ...proposed,
        approved: true,
      }),
    ).rejects.toThrow();
  });

  it("allows only the owner to answer and compare-and-sets concurrent replies", async () => {
    const persistence = new MemoryApprovalPersistence();
    const service = new ApprovalService(
      persistence,
      createApprovalPayloadCipher("22".repeat(32)),
      () => new Date("2026-08-14T12:00:00Z"),
    );
    const request = await service.create(scope(), proposed);
    await expect(
      service.respond(collaborator, spaceId, request.id, "approved"),
    ).rejects.toThrow(/Only an active deterministic owner/);

    const outcomes = await Promise.all([
      service.respond(owner, spaceId, request.id, "approved"),
      service.respond(owner, spaceId, request.id, "rejected"),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(["approved", "rejected"]).toContain(
      persistence.records.get(request.id)?.status,
    );
  });

  it("consumes only the stored exact payload once under concurrent execution", async () => {
    const persistence = new MemoryApprovalPersistence();
    const service = new ApprovalService(
      persistence,
      createApprovalPayloadCipher("33".repeat(32)),
      () => new Date("2026-08-14T12:00:00Z"),
    );
    const request = await service.create(scope(), proposed);
    await service.respond(owner, spaceId, request.id, "approved");
    const outcomes = await Promise.all([
      service.consume(request.id, ownerId, spaceId),
      service.consume(request.id, ownerId, spaceId),
    ]);
    const consumed = outcomes.filter((outcome) => outcome !== undefined);
    expect(consumed).toHaveLength(1);
    expect(consumed[0]?.action).toEqual({
      actionType: proposed.actionType,
      target: proposed.target,
      normalizedPayload: proposed.normalizedPayload,
    });
    expect(Object.isFrozen(consumed[0]?.action)).toBe(true);
    expect(persistence.records.get(request.id)?.status).toBe("consumed");
  });

  it("fails closed on ciphertext, action hash, scope mutation, rejection, and expiry", async () => {
    let now = new Date("2026-08-14T12:00:00Z");
    const cipher = createApprovalPayloadCipher("44".repeat(32));
    const persistence = new MemoryApprovalPersistence();
    const service = new ApprovalService(persistence, cipher, () => now);

    const tampered = await service.create(scope(), proposed);
    await service.respond(owner, spaceId, tampered.id, "approved");
    persistence.records.get(tampered.id)!.normalizedPayloadCiphertext =
      cipher.encrypt(canonicalJson({
        actionType: "external.send",
        target: proposed.target,
        payload: { changed: true },
      }));
    await expect(service.consume(tampered.id, ownerId, spaceId)).resolves.toBeUndefined();

    const changedHash = await service.create(
      scope({ executionTaskId: "00000000-0000-4000-8000-000000000009" }),
      proposed,
    );
    await service.respond(owner, spaceId, changedHash.id, "approved");
    persistence.records.get(changedHash.id)!.actionHash = "f".repeat(64);
    await expect(service.consume(changedHash.id, ownerId, spaceId)).resolves.toBeUndefined();
    await expect(service.consume(changedHash.id, otherOwnerId, spaceId)).resolves.toBeUndefined();
    await expect(service.consume(changedHash.id, ownerId, otherSpaceId)).resolves.toBeUndefined();

    const rejected = await service.create(
      scope({ executionTaskId: "00000000-0000-4000-8000-000000000010" }),
      proposed,
    );
    await service.respond(owner, spaceId, rejected.id, "rejected");
    await expect(service.consume(rejected.id, ownerId, spaceId)).resolves.toBeUndefined();

    const expired = await service.create(
      scope({ executionTaskId: "00000000-0000-4000-8000-000000000011" }),
      proposed,
      1_000,
    );
    await service.respond(owner, spaceId, expired.id, "approved");
    now = new Date("2026-08-14T12:00:02Z");
    await expect(service.consume(expired.id, ownerId, spaceId)).resolves.toBeUndefined();
    expect(persistence.records.get(expired.id)?.status).toBe("expired");
  });

  it("intercepts approval commands deterministically and disambiguates natural yes", async () => {
    const pending = (id: string) => ({
      id,
      chainId,
      executionTaskId: taskId,
      ownerId,
      spaceId,
      actionType: "external.send",
      normalizedPayloadCiphertext: "ciphertext",
      actionHash: "a".repeat(64),
      humanSummary: "send",
      status: "pending" as const,
      expiresAt: new Date("2026-08-14T12:10:00Z"),
    });
    const approvals = {
      listPending: async () => [
        pending("00000000-0000-4000-8000-000000000020"),
        pending("00000000-0000-4000-8000-000000000021"),
      ],
      respond: async () => true,
    };
    const handler = new AuthorizedCommandHandler({ approvals });
    await expect(
      handler.handle(
        collaborator,
        spaceId,
        "/approve 00000000-0000-4000-8000-000000000020",
      ),
    ).resolves.toMatchObject({
      handled: true,
      response: expect.stringContaining("only the active owner"),
    });
    await expect(handler.handle(owner, spaceId, "yes")).resolves.toMatchObject({
      handled: true,
      response: expect.stringContaining("more than one approval"),
    });
    await expect(handler.handle(owner, spaceId, "/unknown")).resolves.toMatchObject({
      handled: true,
      response: expect.stringContaining("unknown command"),
    });
    await expect(handler.handle(owner, spaceId, "please continue")).resolves.toEqual({
      handled: false,
    });
  });
});
