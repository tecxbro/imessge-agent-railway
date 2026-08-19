import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";

import type {
  MemoryReceipt,
  MemoryReceiptStore,
  PendingMemoryReceipt,
} from "../../memory/receipts.js";
import { MemoryReceiptError } from "../../memory/receipts.js";
import type { Database } from "../client.js";
import { memorySyncEvents } from "../schema.js";

function receipt(row: typeof memorySyncEvents.$inferSelect): MemoryReceipt {
  return {
    id: row.id,
    ownerId: row.ownerId,
    spaceId: row.spaceId,
    chainId: row.chainId,
    operation: row.operation,
    contentHash: row.contentHash,
    status: row.status,
    safeSummary: row.safeSummary,
    ...(row.externalMemoryId === null
      ? {}
      : { externalMemoryId: row.externalMemoryId }),
  };
}

async function receiptQuery<Result>(
  operation: string,
  query: () => Promise<Result>,
): Promise<Result> {
  try {
    return await query();
  } catch (error) {
    if (error instanceof MemoryReceiptError) {
      throw error;
    }
    throw new MemoryReceiptError(
      `PostgreSQL could not ${operation} a memory receipt; restore database writes before retrying.`,
      { cause: error },
    );
  }
}

export class PostgresMemoryReceiptStore implements MemoryReceiptStore {
  public constructor(private readonly database: Database) {}

  public async findSucceededByContentHash(
    ownerId: string,
    contentHash: string,
  ): Promise<MemoryReceipt | undefined> {
    return receiptQuery("read", async () => {
      const [row] = await this.database
        .select()
        .from(memorySyncEvents)
        .where(
          and(
            eq(memorySyncEvents.ownerId, ownerId),
            eq(memorySyncEvents.contentHash, contentHash),
            eq(memorySyncEvents.status, "succeeded"),
          ),
        )
        .limit(1);
      return row === undefined ? undefined : receipt(row);
    });
  }

  public async createPending(
    input: PendingMemoryReceipt,
  ): Promise<MemoryReceipt> {
    return receiptQuery("create", async () => {
      const [created] = await this.database
        .insert(memorySyncEvents)
        .values({ id: randomUUID(), ...input, status: "pending" })
        .onConflictDoNothing()
        .returning();
      if (created !== undefined) {
        return receipt(created);
      }
      const [existing] = await this.database
        .select()
        .from(memorySyncEvents)
        .where(
          and(
            eq(memorySyncEvents.ownerId, input.ownerId),
            eq(memorySyncEvents.contentHash, input.contentHash),
          ),
        )
        .limit(1);
      if (existing === undefined) {
        throw new Error("The memory receipt conflicted without a persisted row.");
      }
      return receipt(existing);
    });
  }

  public async markSucceeded(
    receiptId: string,
    externalMemoryId: string,
  ): Promise<void> {
    await receiptQuery("complete", async () => {
      const updated = await this.database
        .update(memorySyncEvents)
        .set({ status: "succeeded", externalMemoryId })
        .where(eq(memorySyncEvents.id, receiptId))
        .returning({ id: memorySyncEvents.id });
      if (updated.length !== 1) {
        throw new Error("The memory receipt no longer exists.");
      }
    });
  }

  public async markFailed(
    receiptId: string,
    failureCode: string,
  ): Promise<void> {
    await receiptQuery("fail", async () => {
      const updated = await this.database
        .update(memorySyncEvents)
        .set({
          status: "failed",
          safeSummary: `failed:${failureCode}`.slice(0, 256),
        })
        .where(eq(memorySyncEvents.id, receiptId))
        .returning({ id: memorySyncEvents.id });
      if (updated.length !== 1) {
        throw new Error("The memory receipt no longer exists.");
      }
    });
  }

  public async findDeletedMemoryIds(
    ownerId: string,
    externalMemoryIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    if (externalMemoryIds.length === 0) {
      return new Set();
    }
    return receiptQuery("read deletion", async () => {
      const rows = await this.database
        .select({ externalMemoryId: memorySyncEvents.externalMemoryId })
        .from(memorySyncEvents)
        .where(
          and(
            eq(memorySyncEvents.ownerId, ownerId),
            eq(memorySyncEvents.operation, "delete"),
            eq(memorySyncEvents.status, "succeeded"),
            inArray(memorySyncEvents.externalMemoryId, [...externalMemoryIds]),
          ),
        );
      return new Set(
        rows.flatMap(({ externalMemoryId }) =>
          externalMemoryId === null ? [] : [externalMemoryId],
        ),
      );
    });
  }

  public async hasSucceededDeletion(ownerId: string): Promise<boolean> {
    return receiptQuery("read deletion", async () => {
      const [row] = await this.database
        .select({ id: memorySyncEvents.id })
        .from(memorySyncEvents)
        .where(
          and(
            eq(memorySyncEvents.ownerId, ownerId),
            eq(memorySyncEvents.operation, "delete"),
            eq(memorySyncEvents.status, "succeeded"),
          ),
        )
        .limit(1);
      return row !== undefined;
    });
  }

  public async isContainerDeleted(
    ownerId: string,
    containerTag: string,
  ): Promise<boolean> {
    return receiptQuery("read container deletion", async () => {
      const [row] = await this.database
        .select({ id: memorySyncEvents.id })
        .from(memorySyncEvents)
        .where(
          and(
            eq(memorySyncEvents.ownerId, ownerId),
            eq(memorySyncEvents.operation, "delete"),
            eq(memorySyncEvents.status, "succeeded"),
            eq(memorySyncEvents.externalMemoryId, containerTag),
          ),
        )
        .limit(1);
      return row !== undefined;
    });
  }
}
