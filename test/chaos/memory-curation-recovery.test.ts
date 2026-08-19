import { describe, expect, it, vi } from "vitest";

import type { MemoryCandidate } from "../../src/agent/schemas.js";
import type {
  MemoryCurationClaim,
  MemoryCurationRepository,
} from "../../src/db/repositories/memory-curation.js";
import {
  curateMemories,
  memoryCandidateHash,
} from "../../src/memory/curator.js";
import {
  MemoryReceiptError,
  type MemoryReceipt,
  type MemoryReceiptStore,
  type PendingMemoryReceipt,
} from "../../src/memory/receipts.js";
import type {
  CreatedMemory,
  CreateMemoryInput,
  MemorySearchHit,
  SupermemoryPort,
} from "../../src/memory/supermemory-client.js";
import {
  createMemoryCurateHandler,
  MemoryCurationRetryError,
} from "../../src/queue/handlers/memory-curate.js";
import { PgBossMemoryQueuePublisher } from "../../src/queue/extensions/memory-queues.js";
import { QUEUE_NAMES } from "../../src/queue/names.js";

const deploymentId = "5c100000-0000-4000-8000-000000000001";
const ownerId = "5c100000-0000-4000-8000-000000000002";
const spaceId = "5c100000-0000-4000-8000-000000000003";
const chainId = "5c100000-0000-4000-8000-000000000004";
const context = {
  deploymentId,
  ownerId,
  spaceId,
  chainId,
  turnSucceeded: true,
};
const job = {
  chainId,
  expectedChainVersion: 1,
  expectedState: "complete" as const,
};
const candidate: MemoryCandidate = {
  kind: "preference",
  scope: "owner",
  content: "The owner prefers recovery tests with exact evidence.",
  confidence: 0.99,
  source: "authorized_user",
  projectId: null,
  replacesMemoryId: null,
};

class RecoverableProvider implements SupermemoryPort {
  public createCalls = 0;
  public searchCalls = 0;
  private readonly stored: Array<CreatedMemory & { input: CreateMemoryInput }> = [];

  public async getOwnerProfile() {
    return { static: [], dynamic: [] };
  }

  public async searchMemories(): Promise<MemorySearchHit[]> {
    this.searchCalls += 1;
    return this.stored.map((memory) => ({
      id: memory.id,
      text: memory.text,
      similarity: 1,
      metadata: memory.input.metadata,
      updatedAt: memory.createdAt,
    }));
  }

  public async createMemories(input: {
    memories: CreateMemoryInput[];
  }): Promise<CreatedMemory[]> {
    this.createCalls += 1;
    return input.memories.map((memory) => {
      const created = {
        id: `external-${this.stored.length + 1}`,
        text: memory.content,
        isStatic: memory.isStatic,
        createdAt: "2026-08-18T00:00:00Z",
        input: memory,
      };
      this.stored.push(created);
      return created;
    });
  }

  public async updateMemory(): Promise<CreatedMemory> {
    throw new Error("update is not used by this fixture");
  }

  public async forgetMemory(input: { memoryId: string }) {
    return { id: input.memoryId, forgotten: true as const };
  }

  public async listMemories() {
    return [];
  }

  public async deleteContainer(input: { containerTag: string }) {
    return {
      containerTag: input.containerTag,
      deletedDocumentsCount: 0,
      deletedMemoriesCount: 0,
    };
  }
}

class RecoverableReceipts implements MemoryReceiptStore {
  public receipt: MemoryReceipt | undefined;
  public failFirstSuccessCheckpoint = true;

  public async findSucceededByContentHash(
    requestedOwnerId: string,
    contentHash: string,
  ) {
    return this.receipt?.ownerId === requestedOwnerId &&
      this.receipt.contentHash === contentHash &&
      this.receipt.status === "succeeded"
      ? this.receipt
      : undefined;
  }

  public async createPending(input: PendingMemoryReceipt) {
    this.receipt ??= { id: "receipt-1", ...input, status: "pending" };
    return this.receipt;
  }

  public async markSucceeded(receiptId: string, externalMemoryId: string) {
    if (this.failFirstSuccessCheckpoint) {
      this.failFirstSuccessCheckpoint = false;
      throw new MemoryReceiptError("fixture checkpoint interruption");
    }
    if (this.receipt?.id === receiptId) {
      this.receipt.status = "succeeded";
      this.receipt.externalMemoryId = externalMemoryId;
    }
  }

  public async markFailed(receiptId: string) {
    if (this.receipt?.id === receiptId) {
      this.receipt.status = "failed";
    }
  }

  public async findDeletedMemoryIds() {
    return new Set<string>();
  }

  public async hasSucceededDeletion() {
    return false;
  }

  public async isContainerDeleted() {
    return false;
  }
}

describe("memory curation interruption recovery", () => {
  it("reconciles a durable candidate after queue publication fails", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("simulated queue publication failure"))
      .mockResolvedValueOnce("memory-job-id");
    const publisher = new PgBossMemoryQueuePublisher({
      send,
      findJobs: vi.fn(async () => []),
    } as never);
    const findReconciliationWork = vi.fn(async () => ({
      completedWithoutRuns: [],
      pendingRuns: [job],
      retryableFailedRuns: [],
      deferredRuns: [],
      staleRunningRuns: [],
    }));

    await expect(
      publisher.reconcile({ findReconciliationWork } as never, {
        providerEnabled: true,
      }),
    ).rejects.toThrow("simulated queue publication failure");
    await expect(
      publisher.reconcile({ findReconciliationWork } as never, {
        providerEnabled: true,
      }),
    ).resolves.toMatchObject({ enqueued: 1 });

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(
      QUEUE_NAMES.memoryCurate,
      job,
      expect.objectContaining({
        singletonKey: `chain:${chainId}:memory-curate`,
      }),
    );
  });

  it("recovers after provider success but before receipt checkpoint without a second external write", async () => {
    const provider = new RecoverableProvider();
    const receipts = new RecoverableReceipts();
    let state:
      | "pending"
      | "running"
      | "failed_retryable"
      | "succeeded" = "pending";
    let attempts = 0;
    const repository = {
      claimRun: vi.fn(async (): Promise<MemoryCurationClaim> => {
        if (state === "succeeded") {
          return {
            status: "terminal",
            chainId,
            code: "MEMORY_CURATION_ALREADY_SUCCEEDED",
          };
        }
        state = "running";
        attempts += 1;
        return {
          status: "claimed",
          chainId,
          context,
          candidates: [
            {
              sourceStage: "direct",
              sourceTaskId: null,
              contentHash: memoryCandidateHash(candidate, { spaceId }),
              candidate,
            },
          ],
        };
      }),
      markSucceeded: vi.fn(async () => {
        state = "succeeded";
      }),
      markFailed: vi.fn(async (input: { retryable: boolean }) => {
        state = input.retryable ? "failed_retryable" : "succeeded";
      }),
    } satisfies Pick<
      MemoryCurationRepository,
      "claimRun" | "markSucceeded" | "markFailed"
    >;
    const handler = createMemoryCurateHandler({
      repository,
      receipts,
      provider,
    });

    await expect(handler(job)).rejects.toBeInstanceOf(
      MemoryCurationRetryError,
    );
    expect(state).toBe("failed_retryable");
    expect(provider.createCalls).toBe(1);

    await expect(handler(job)).resolves.toBeUndefined();
    expect(state).toBe("succeeded");
    expect(attempts).toBe(2);
    expect(provider.createCalls).toBe(1);
    expect(receipts.receipt).toMatchObject({
      status: "succeeded",
      externalMemoryId: "external-1",
    });

    const searchesBeforeReceiptDedup = provider.searchCalls;
    await expect(
      curateMemories({ provider, receipts, context, candidates: [candidate] }),
    ).resolves.toMatchObject([
      {
        status: "deduplicated",
        externalMemoryId: "external-1",
      },
    ]);
    expect(provider.searchCalls).toBe(searchesBeforeReceiptDedup);
    expect(provider.createCalls).toBe(1);
  });
});
