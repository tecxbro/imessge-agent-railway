import { createHash, randomUUID } from "node:crypto";

import { and, eq, isNull, sql } from "drizzle-orm";

import type { Database } from "../client.js";
import {
  chains,
  outboundBatches,
  outboundParts,
  spaces,
} from "../schema.js";

export function stableClientGuid(
  deploymentId: string,
  batchId: string,
  position: number,
): string {
  return createHash("sha256")
    .update(`${deploymentId}:${batchId}:${position}`)
    .digest("hex");
}

export interface MaterializeOutboundInput {
  deploymentId: string;
  chainId: string;
  spaceId: string;
  encryptedParts: readonly string[];
}

export interface OutboundPartToSend {
  batchId: string;
  spaceId: string;
  position: number;
  clientGuid: string;
  contentCiphertext: string;
}

export interface OutboundCheckpoint {
  batchComplete: boolean;
  nextIndex: number;
}

export class OutboundRepository {
  public constructor(private readonly database: Database) {}

  public async findChainIdForBatch(
    batchId: string,
  ): Promise<string | undefined> {
    const [batch] = await this.database
      .select({ chainId: outboundBatches.chainId })
      .from(outboundBatches)
      .where(eq(outboundBatches.id, batchId))
      .limit(1);
    return batch?.chainId;
  }

  public async materializeBatch(input: MaterializeOutboundInput): Promise<string> {
    // Per-space advisory locks and chain row locks keep materialization and the
    // send cursor monotonic across concurrent workers and process restarts.
    if (input.encryptedParts.length === 0) {
      throw new Error(
        "Cannot materialize an empty outbound batch. Synthesis must produce at least one encrypted bubble.",
      );
    }

    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${input.spaceId}, 0))`,
      );
      await transaction.execute(
        sql`select id from ${chains} where ${chains.id} = ${input.chainId} for update`,
      );
      const [chain] = await transaction
        .select({ id: chains.id })
        .from(chains)
        .where(
          and(
            eq(chains.id, input.chainId),
            eq(chains.spaceId, input.spaceId),
            eq(chains.state, "synthesizing"),
            isNull(chains.canceledAt),
          ),
        )
        .limit(1);

      if (chain === undefined) {
        throw new Error(
          "Outbound materialization rejected because the chain is stale, canceled, or not synthesizing. Reload current chain state before retrying.",
        );
      }

      const batchId = randomUUID();
      await transaction.insert(outboundBatches).values({
        id: batchId,
        chainId: input.chainId,
        spaceId: input.spaceId,
        state: "queued",
        startIndex: 0,
        partCount: input.encryptedParts.length,
      });
      await transaction.insert(outboundParts).values(
        input.encryptedParts.map((contentCiphertext, position) => ({
          id: randomUUID(),
          batchId,
          position,
          clientGuid: stableClientGuid(input.deploymentId, batchId, position),
          contentCiphertext,
          state: "pending" as const,
        })),
      );
      await transaction
        .update(chains)
        .set({ state: "sending", updatedAt: new Date() })
        .where(eq(chains.id, input.chainId));

      return batchId;
    });
  }

  public async claimNextPart(batchId: string): Promise<OutboundPartToSend | null> {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(sql`
        select pg_advisory_xact_lock(hashtextextended(locked_batch.space_id::text, 0))
        from ${outboundBatches} locked_batch
        where locked_batch.id = ${batchId}
      `);
      await transaction.execute(
        sql`select id from ${outboundBatches} where ${outboundBatches.id} = ${batchId} for update`,
      );
      const [batch] = await transaction
        .select({
          id: outboundBatches.id,
          chainId: outboundBatches.chainId,
          spaceId: outboundBatches.spaceId,
          state: outboundBatches.state,
          startIndex: outboundBatches.startIndex,
          partCount: outboundBatches.partCount,
          chainState: chains.state,
          canceledAt: chains.canceledAt,
          deploymentId: spaces.deploymentId,
        })
        .from(outboundBatches)
        .innerJoin(chains, eq(chains.id, outboundBatches.chainId))
        .innerJoin(spaces, eq(spaces.id, outboundBatches.spaceId))
        .where(eq(outboundBatches.id, batchId))
        .limit(1);

      if (batch === undefined) {
        throw new Error(
          "Outbound batch was not found. Reconcile queue jobs with materialized database batches before retrying.",
        );
      }
      if (batch.state === "sent") {
        return null;
      }
      if (
        batch.state === "canceled" ||
        batch.chainState === "canceled" ||
        batch.canceledAt !== null
      ) {
        throw new Error(
          "Outbound send rejected because its chain or batch was canceled. Discard the stale queue job.",
        );
      }
      if (batch.state !== "queued" && batch.state !== "sending") {
        throw new Error(
          `Outbound batch is ${batch.state}; only queued or sending batches can resume. Inspect the failure event before retrying.`,
        );
      }
      if (batch.chainState !== "sending") {
        throw new Error(
          `Outbound chain is ${batch.chainState}; expected sending. Reconcile chain and batch state before retrying.`,
        );
      }

      if (batch.startIndex === batch.partCount) {
        const completedAt = new Date();
        await transaction
          .update(outboundBatches)
          .set({ state: "sent", completedAt, updatedAt: completedAt })
          .where(eq(outboundBatches.id, batch.id));
        await transaction
          .update(chains)
          .set({ state: "complete", completedAt, updatedAt: completedAt })
          .where(eq(chains.id, batch.chainId));
        return null;
      }

      const [part] = await transaction
        .select({
          position: outboundParts.position,
          clientGuid: outboundParts.clientGuid,
          contentCiphertext: outboundParts.contentCiphertext,
          state: outboundParts.state,
        })
        .from(outboundParts)
        .where(
          and(
            eq(outboundParts.batchId, batch.id),
            eq(outboundParts.position, batch.startIndex),
          ),
        )
        .limit(1);

      if (part === undefined || part.state === "sent") {
        throw new Error(
          "Outbound cursor does not point to a pending materialized part. Stop delivery and repair the batch invariant.",
        );
      }

      if (batch.state === "queued") {
        await transaction
          .update(outboundBatches)
          .set({ state: "sending", updatedAt: new Date() })
          .where(eq(outboundBatches.id, batch.id));
      }

      return {
        batchId: batch.id,
        spaceId: batch.spaceId,
        position: part.position,
        clientGuid: part.clientGuid,
        contentCiphertext: part.contentCiphertext,
      };
    });
  }

  public async checkpointSentPart(
    batchId: string,
    position: number,
    externalMessageId: string | null,
    sentAt = new Date(),
  ): Promise<OutboundCheckpoint> {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(sql`
        select pg_advisory_xact_lock(hashtextextended(locked_batch.space_id::text, 0))
        from ${outboundBatches} locked_batch
        where locked_batch.id = ${batchId}
      `);
      await transaction.execute(
        sql`select id from ${outboundBatches} where ${outboundBatches.id} = ${batchId} for update`,
      );
      const [batch] = await transaction
        .select()
        .from(outboundBatches)
        .where(eq(outboundBatches.id, batchId))
        .limit(1);

      if (batch === undefined) {
        throw new Error(
          "Cannot checkpoint a missing outbound batch. Reconcile the job payload with database state.",
        );
      }
      if (batch.startIndex > position) {
        return {
          batchComplete: batch.startIndex === batch.partCount,
          nextIndex: batch.startIndex,
        };
      }
      if (batch.startIndex !== position || batch.state !== "sending") {
        throw new Error(
          "Outbound checkpoint rejected because the cursor did not move monotonically. Reload the current batch before retrying.",
        );
      }

      const nextIndex = position + 1;
      const batchComplete = nextIndex === batch.partCount;
      const updatedParts = await transaction
        .update(outboundParts)
        .set({
          state: "sent",
          externalMessageId,
          sentAt,
          updatedAt: sentAt,
        })
        .where(
          and(
            eq(outboundParts.batchId, batchId),
            eq(outboundParts.position, position),
            sql`${outboundParts.state} in ('pending', 'failed')`,
          ),
        )
        .returning({ id: outboundParts.id });
      if (updatedParts.length !== 1) {
        throw new Error(
          "Outbound part checkpoint did not update exactly one pending part. The transaction was rolled back; repair the batch invariant before retrying.",
        );
      }
      await transaction
        .update(outboundBatches)
        .set({
          startIndex: nextIndex,
          state: batchComplete ? "sent" : "sending",
          completedAt: batchComplete ? sentAt : null,
          updatedAt: sentAt,
        })
        .where(eq(outboundBatches.id, batchId));

      if (batchComplete) {
        await transaction
          .update(chains)
          .set({ state: "complete", completedAt: sentAt, updatedAt: sentAt })
          .where(
            and(
              eq(chains.id, batch.chainId),
              eq(chains.state, "sending"),
              isNull(chains.canceledAt),
            ),
          );
      }

      return { batchComplete, nextIndex };
    });
  }

  public async findResumableBatchIds(limit = 100): Promise<string[]> {
    const rows = await this.database
      .select({ id: outboundBatches.id })
      .from(outboundBatches)
      .innerJoin(chains, eq(chains.id, outboundBatches.chainId))
      .where(
        and(
          sql`${outboundBatches.state} in ('queued', 'sending')`,
          eq(chains.state, "sending"),
          isNull(chains.canceledAt),
        ),
      )
      .limit(limit);

    return rows.map((row) => row.id);
  }
}
