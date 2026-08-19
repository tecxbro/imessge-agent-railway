import { describe, expect, it, vi } from "vitest";

import type { MemoryCandidate } from "../../src/agent/schemas.js";
import type {
  MemoryCurationClaim,
  MemoryCurationRepository,
} from "../../src/db/repositories/memory-curation.js";
import { curateMemories } from "../../src/memory/curator.js";
import type {
  MemoryReceipt,
  MemoryReceiptStore,
  PendingMemoryReceipt,
} from "../../src/memory/receipts.js";
import {
  MemoryProviderError,
  type CreateMemoryInput,
  type SupermemoryPort,
} from "../../src/memory/supermemory-client.js";
import {
  createMemoryCurateHandler,
  MemoryCurationRetryError,
} from "../../src/queue/handlers/memory-curate.js";
import { PgBossMemoryQueuePublisher } from "../../src/queue/extensions/memory-queues.js";
import { QUEUE_NAMES } from "../../src/queue/names.js";

const chainId = "50000000-0000-4000-8000-000000000001";
const deploymentId = "50000000-0000-4000-8000-000000000002";
const ownerId = "50000000-0000-4000-8000-000000000003";
const spaceId = "50000000-0000-4000-8000-000000000004";
const job = {
  chainId,
  expectedChainVersion: 7,
  expectedState: "complete" as const,
};

function candidate(content: string): MemoryCandidate {
  return {
    kind: "preference",
    scope: "owner",
    content,
    confidence: 0.99,
    source: "authorized_user",
    projectId: null,
    replacesMemoryId: null,
  };
}

function claimed(candidates: readonly MemoryCandidate[]): MemoryCurationClaim {
  return {
    status: "claimed",
    chainId,
    context: {
      deploymentId,
      ownerId,
      spaceId,
      chainId,
      turnSucceeded: true,
    },
    candidates: candidates.map((value, index) => ({
      sourceStage: "direct" as const,
      sourceTaskId: null,
      contentHash: `${index}`.padStart(64, "a"),
      candidate: value,
    })),
  };
}

function repository(claim: MemoryCurationClaim) {
  return {
    claimRun: vi.fn(async () => claim),
    markSucceeded: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined),
  } satisfies Pick<
    MemoryCurationRepository,
    "claimRun" | "markSucceeded" | "markFailed"
  >;
}

function receipts(): MemoryReceiptStore {
  const stored: MemoryReceipt[] = [];
  return {
    async findSucceededByContentHash(owner, hash) {
      return stored.find(
        (receipt) =>
          receipt.ownerId === owner &&
          receipt.contentHash === hash &&
          receipt.status === "succeeded",
      );
    },
    async createPending(input: PendingMemoryReceipt) {
      const receipt: MemoryReceipt = {
        id: `receipt-${stored.length + 1}`,
        ...input,
        status: "pending",
      };
      stored.push(receipt);
      return receipt;
    },
    async markSucceeded(receiptId, externalMemoryId) {
      const receipt = stored.find((value) => value.id === receiptId);
      if (receipt !== undefined) {
        receipt.status = "succeeded";
        receipt.externalMemoryId = externalMemoryId;
      }
    },
    async markFailed(receiptId) {
      const receipt = stored.find((value) => value.id === receiptId);
      if (receipt !== undefined) {
        receipt.status = "failed";
      }
    },
    async findDeletedMemoryIds() {
      return new Set();
    },
    async hasSucceededDeletion() {
      return false;
    },
    async isContainerDeleted() {
      return false;
    },
  };
}

function provider(
  searchMemories: SupermemoryPort["searchMemories"],
): SupermemoryPort {
  return {
    getOwnerProfile: vi.fn(async () => ({ static: [], dynamic: [] })),
    searchMemories,
    createMemories: vi.fn(async (input: { memories: CreateMemoryInput[] }) =>
      input.memories.map((value, index) => ({
        id: `memory-${index + 1}`,
        text: value.content,
        isStatic: value.isStatic,
        createdAt: "2026-08-18T00:00:00Z",
      })),
    ),
    updateMemory: vi.fn(async ({ memoryId, content }) => ({
      id: memoryId,
      text: content,
      isStatic: true,
      createdAt: "2026-08-18T00:00:00Z",
    })),
    forgetMemory: vi.fn(async ({ memoryId }) => ({
      id: memoryId,
      forgotten: true as const,
    })),
    listMemories: vi.fn(async () => []),
    deleteContainer: vi.fn(async ({ containerTag }) => ({
      containerTag,
      deletedDocumentsCount: 0,
      deletedMemoriesCount: 0,
    })),
  };
}

describe("memory curation worker", () => {
  it("returns failure code, retryability, and failed status per candidate", async () => {
    await expect(
      curateMemories({
        provider: provider(async () => {
          throw new MemoryProviderError(
            "MEMORY_PROVIDER_RATE_LIMITED",
            true,
            "fixture rate limit",
          );
        }),
        receipts: receipts(),
        context: {
          deploymentId,
          ownerId,
          spaceId,
          chainId,
          turnSucceeded: true,
        },
        candidates: [candidate("The owner prefers compact diffs.")],
      }),
    ).resolves.toMatchObject([
      {
        status: "failed",
        failureCode: "MEMORY_PROVIDER_RATE_LIMITED",
        retryable: true,
      },
    ]);
  });

  it("accepts only the ID, version, and completed-state queue payload", async () => {
    const store = repository(claimed([]));
    const handler = createMemoryCurateHandler({
      repository: store,
      receipts: receipts(),
    });

    await expect(
      handler({ ...job, candidateContent: "plaintext must not be queued" } as never),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(store.claimRun).not.toHaveBeenCalled();
  });

  it("defers a completed chain when Supermemory is disabled without retrying", async () => {
    const store = repository({
      status: "deferred",
      chainId,
      code: "MEMORY_PROVIDER_DISABLED",
    });
    const handler = createMemoryCurateHandler({
      repository: store,
      receipts: receipts(),
      provider: null,
    });

    await expect(handler(job)).resolves.toBeUndefined();
    expect(store.claimRun).toHaveBeenCalledWith(job, false);
    expect(store.markFailed).not.toHaveBeenCalled();
    expect(store.markSucceeded).not.toHaveBeenCalled();
  });

  it("retries only when at least one candidate returns a retryable failure", async () => {
    const store = repository(
      claimed([
        candidate("The owner prefers compact diffs."),
        candidate("The owner prefers explicit test evidence."),
      ]),
    );
    let calls = 0;
    const memoryProvider = provider(async () => {
      calls += 1;
      throw calls === 1
        ? new MemoryProviderError(
            "MEMORY_PROVIDER_AUTH_FAILED",
            false,
            "fixture terminal failure",
          )
        : new MemoryProviderError(
            "MEMORY_PROVIDER_TIMEOUT",
            true,
            "fixture retryable failure",
          );
    });
    const handler = createMemoryCurateHandler({
      repository: store,
      receipts: receipts(),
      provider: memoryProvider,
    });

    await expect(handler(job)).rejects.toBeInstanceOf(
      MemoryCurationRetryError,
    );
    expect(calls).toBe(2);
    expect(store.markFailed).toHaveBeenCalledWith({
      chainId,
      failureCode: "MEMORY_PROVIDER_TIMEOUT",
      retryable: true,
    });
  });

  it("records terminal candidate failures without asking the queue to retry", async () => {
    const store = repository(
      claimed([candidate("The owner prefers compact diffs.")]),
    );
    const handler = createMemoryCurateHandler({
      repository: store,
      receipts: receipts(),
      provider: provider(async () => {
        throw new MemoryProviderError(
          "MEMORY_PROVIDER_AUTH_FAILED",
          false,
          "fixture terminal failure",
        );
      }),
    });

    await expect(handler(job)).resolves.toBeUndefined();
    expect(store.markFailed).toHaveBeenCalledWith({
      chainId,
      failureCode: "MEMORY_PROVIDER_AUTH_FAILED",
      retryable: false,
    });
  });

  it.each(["MEMORY_CHAIN_FAILED", "MEMORY_CHAIN_SUPERSEDED"])(
    "never calls the provider for a rejected chain: %s",
    async (code) => {
      const store = repository({ status: "rejected", chainId, code });
      const search = vi.fn<SupermemoryPort["searchMemories"]>(async () => []);
      const handler = createMemoryCurateHandler({
        repository: store,
        receipts: receipts(),
        provider: provider(search),
      });

      await expect(handler(job)).resolves.toBeUndefined();
      expect(search).not.toHaveBeenCalled();
      expect(store.markFailed).not.toHaveBeenCalled();
    },
  );
});

describe("memory curation queue reconciliation", () => {
  it("finds all recovery classes and enqueues only chains without active jobs", async () => {
    const completedId = "50000000-0000-4000-8000-000000000011";
    const retryableId = "50000000-0000-4000-8000-000000000012";
    const deferredId = "50000000-0000-4000-8000-000000000013";
    const staleId = "50000000-0000-4000-8000-000000000014";
    const payload = (id: string) => ({
      chainId: id,
      expectedChainVersion: 3,
      expectedState: "complete" as const,
    });
    const send = vi.fn(async () => "new-job-id");
    const findJobs = vi.fn(async () => [
      {
        state: "active",
        data: job,
      },
    ]);
    const publisher = new PgBossMemoryQueuePublisher({
      send,
      findJobs,
    } as never);
    const findReconciliationWork = vi.fn(async () => ({
      completedWithoutRuns: [payload(completedId)],
      pendingRuns: [job],
      retryableFailedRuns: [payload(retryableId)],
      deferredRuns: [payload(deferredId)],
      staleRunningRuns: [payload(staleId)],
    }));

    await expect(
      publisher.reconcile(
        { findReconciliationWork } as never,
        {
          providerEnabled: true,
          now: new Date("2026-08-18T00:30:00Z"),
          runningStaleAfterMs: 10 * 60 * 1_000,
        },
      ),
    ).resolves.toEqual({
      discovered: {
        completedWithoutRuns: 1,
        pendingRuns: 1,
        retryableFailedRuns: 1,
        deferredRuns: 1,
        staleRunningRuns: 1,
      },
      pendingRunsWithoutJobs: 0,
      enqueued: 4,
    });
    expect(findReconciliationWork).toHaveBeenCalledWith({
      providerEnabled: true,
      runningBefore: new Date("2026-08-18T00:20:00Z"),
    });
    expect(send).toHaveBeenCalledTimes(4);
    expect(send).toHaveBeenCalledWith(
      QUEUE_NAMES.memoryCurate,
      payload(completedId),
      expect.objectContaining({
        singletonKey: `chain:${completedId}:memory-curate`,
        retryLimit: 5,
      }),
    );
    expect(JSON.stringify(send.mock.calls)).not.toContain("candidate");
    expect(JSON.stringify(send.mock.calls)).not.toContain("content");
  });
});
