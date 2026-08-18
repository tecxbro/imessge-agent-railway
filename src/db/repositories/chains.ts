import { randomUUID } from "node:crypto";

import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lte,
  max,
  sql,
} from "drizzle-orm";

import type { Database, DatabaseTransaction } from "../client.js";
import {
  carriedMessages,
  approvals,
  chains,
  executionTasks,
  deployments,
  messages,
  outboundBatches,
  spaces,
} from "../schema.js";
import {
  modelSelectionSchema,
  type ModelSelectionState,
} from "../../agent/model-selection.js";

const ACTIVE_CHAIN_STATES = [
  "queued",
  "planning",
  "executing",
  "awaiting_approval",
  "synthesizing",
  "sending",
] as const;

export interface FlushedChain {
  chainId: string;
  version: number;
  messageIds: string[];
  canceledChainIds: string[];
}

export interface SupersedeResult {
  canceledChainIds: string[];
  carriedMessageIds: string[];
}

export interface QueuedChain {
  chainId: string;
  version: number;
}

export class ChainRepository {
  public constructor(private readonly database: Database) {}

  public async flushInboundMessages(
    spaceId: string,
    startedAt = new Date(),
  ): Promise<FlushedChain | null> {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${spaceId}, 0))`,
      );

      const undrained = await transaction
        .select({ id: messages.id, receivedAt: messages.receivedAt })
        .from(messages)
        .where(
          and(
            eq(messages.spaceId, spaceId),
            eq(messages.direction, "inbound"),
            isNull(messages.drainedChainId),
          ),
        )
        .orderBy(asc(messages.receivedAt), asc(messages.id));

      const newestUndrained = undrained.at(-1);
      let canceledChainIds: string[] = [];
      if (newestUndrained !== undefined) {
        if (newestUndrained.receivedAt === null) {
          throw new Error(
            "Cannot flush an inbound message without received_at. Repair the invalid row before retrying.",
          );
        }
        // This repeats the ingest-time guard under the same per-space lock so a
        // crash or concurrent flush cannot leave two live chains.
        const superseded = await this.supersedeWithinTransaction(
          transaction,
          spaceId,
          newestUndrained.id,
          newestUndrained.receivedAt,
        );
        canceledChainIds = superseded.canceledChainIds;
      }

      const pendingCarry = await transaction
        .select({
          id: carriedMessages.id,
          messageId: carriedMessages.sourceMessageId,
        })
        .from(carriedMessages)
        .where(
          and(
            eq(carriedMessages.spaceId, spaceId),
            isNull(carriedMessages.consumedByChainId),
          ),
        )
        .orderBy(asc(carriedMessages.createdAt), asc(carriedMessages.position));

      if (pendingCarry.length === 0 && undrained.length === 0) {
        return null;
      }

      const [versionRow] = await transaction
        .select({ latest: max(chains.version) })
        .from(chains)
        .where(eq(chains.spaceId, spaceId));
      const version = (versionRow?.latest ?? 0) + 1;
      const chainId = randomUUID();

      const [selectionRow] = await transaction
        .select({
          modelId: deployments.effectiveModelId,
          reasoningEffort: deployments.effectiveReasoningEffort,
          source: deployments.modelSelectionState,
        })
        .from(spaces)
        .innerJoin(deployments, eq(deployments.id, spaces.deploymentId))
        .where(eq(spaces.id, spaceId))
        .limit(1);
      if (
        selectionRow === undefined ||
        selectionRow.modelId === null ||
        selectionRow.reasoningEffort === null ||
        (selectionRow.source !== "preferred" &&
          selectionRow.source !== "fallback")
      ) {
        throw new Error(
          "Cannot create a message chain until an effective Codex model is available. Refresh account model settings and retry.",
        );
      }
      const selection = modelSelectionSchema.parse({
        modelId: selectionRow.modelId,
        reasoningEffort: selectionRow.reasoningEffort,
      });

      await transaction.insert(chains).values({
        id: chainId,
        spaceId,
        version,
        state: "queued",
        chainStartedAt: startedAt,
        modelProfile: "main",
        modelId: selection.modelId,
        reasoningEffort: selection.reasoningEffort,
        modelSelectionSource: selectionRow.source as Extract<
          ModelSelectionState,
          "preferred" | "fallback"
        >,
      });

      const undrainedIds = undrained.map((row) => row.id);
      if (undrainedIds.length > 0) {
        await transaction
          .update(messages)
          .set({ drainedChainId: chainId, updatedAt: startedAt })
          .where(inArray(messages.id, undrainedIds));
      }

      const carriedIds = pendingCarry.map((row) => row.id);
      if (carriedIds.length > 0) {
        await transaction
          .update(carriedMessages)
          .set({ consumedByChainId: chainId, updatedAt: startedAt })
          .where(inArray(carriedMessages.id, carriedIds));
      }

      return {
        chainId,
        version,
        messageIds: [
          ...pendingCarry.map((row) => row.messageId),
          ...undrainedIds,
        ],
        canceledChainIds,
      };
    });
  }

  public async supersedeActiveChain(
    spaceId: string,
    newerMessageId: string,
  ): Promise<SupersedeResult> {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${spaceId}, 0))`,
      );

      const [newerMessage] = await transaction
        .select({
          receivedAt: messages.receivedAt,
          drainedChainId: messages.drainedChainId,
        })
        .from(messages)
        .where(
          and(eq(messages.id, newerMessageId), eq(messages.spaceId, spaceId)),
        )
        .limit(1);

      if (newerMessage?.receivedAt === null || newerMessage?.receivedAt === undefined) {
        throw new Error(
          "Cannot supersede a chain without a persisted inbound message timestamp. Re-ingest the provider event before retrying.",
        );
      }
      if (newerMessage.drainedChainId !== null) {
        return { canceledChainIds: [], carriedMessageIds: [] };
      }

      return this.supersedeWithinTransaction(
        transaction,
        spaceId,
        newerMessageId,
        newerMessage.receivedAt,
      );
    });
  }

  private async supersedeWithinTransaction(
    transaction: DatabaseTransaction,
    spaceId: string,
    newerMessageId: string,
    newerMessageReceivedAt: Date,
  ): Promise<SupersedeResult> {
    const active = await transaction
      .select({ id: chains.id })
      .from(chains)
      .where(
        and(
          eq(chains.spaceId, spaceId),
          inArray(chains.state, ACTIVE_CHAIN_STATES),
          lte(chains.chainStartedAt, newerMessageReceivedAt),
        ),
      )
      .orderBy(desc(chains.version));

    const canceledChainIds = active.map((chain) => chain.id);
    if (canceledChainIds.length === 0) {
      return { canceledChainIds: [], carriedMessageIds: [] };
    }

    const drained = await transaction
      .select({ id: messages.id, chainId: messages.drainedChainId })
      .from(messages)
      .where(inArray(messages.drainedChainId, canceledChainIds))
      .orderBy(asc(messages.receivedAt), asc(messages.id));

    await transaction
      .update(carriedMessages)
      .set({ consumedByChainId: null, updatedAt: newerMessageReceivedAt })
      .where(inArray(carriedMessages.consumedByChainId, canceledChainIds));

    for (const chainId of canceledChainIds) {
      const chainMessages = drained.filter((row) => row.chainId === chainId);
      if (chainMessages.length > 0) {
        await transaction
          .insert(carriedMessages)
          .values(
            chainMessages.map((message, position) => ({
              id: randomUUID(),
              spaceId,
              sourceChainId: chainId,
              sourceMessageId: message.id,
              position,
            })),
          )
          .onConflictDoNothing();
      }
    }

    await transaction
      .update(executionTasks)
      .set({
        state: "canceled",
        completedAt: newerMessageReceivedAt,
        updatedAt: newerMessageReceivedAt,
      })
      .where(
        and(
          inArray(executionTasks.chainId, canceledChainIds),
          inArray(executionTasks.state, ["queued", "running", "needs_approval"]),
        ),
      );

    await transaction
      .update(approvals)
      .set({ status: "expired", updatedAt: newerMessageReceivedAt })
      .where(
        and(
          inArray(approvals.chainId, canceledChainIds),
          inArray(approvals.status, ["pending", "approved"]),
          isNull(approvals.consumedAt),
        ),
      );

    await transaction
      .update(outboundBatches)
      .set({ state: "canceled", updatedAt: newerMessageReceivedAt })
      .where(
        and(
          inArray(outboundBatches.chainId, canceledChainIds),
          inArray(outboundBatches.state, ["queued", "sending"]),
        ),
      );

    await transaction
      .update(chains)
      .set({
        state: "canceled",
        canceledAt: newerMessageReceivedAt,
        canceledByMessageId: newerMessageId,
        completedAt: newerMessageReceivedAt,
        updatedAt: newerMessageReceivedAt,
      })
      .where(inArray(chains.id, canceledChainIds));

    return {
      canceledChainIds,
      carriedMessageIds: drained.map((row) => row.id),
    };
  }

  public async isCurrentChain(
    chainId: string,
    expectedVersion: number,
  ): Promise<boolean> {
    const [row] = await this.database
      .select({ id: chains.id })
      .from(chains)
      .where(
        and(
          eq(chains.id, chainId),
          eq(chains.version, expectedVersion),
          inArray(chains.state, ACTIVE_CHAIN_STATES),
          isNull(chains.canceledAt),
          sql`${chains.version} = (select max(current_chain.version) from ${chains} current_chain where current_chain.space_id = ${chains.spaceId})`,
        ),
      )
      .limit(1);

    return row !== undefined;
  }

  public async findQueuedChains(limit = 100): Promise<QueuedChain[]> {
    return this.database
      .select({ chainId: chains.id, version: chains.version })
      .from(chains)
      .where(and(eq(chains.state, "queued"), isNull(chains.canceledAt)))
      .orderBy(asc(chains.createdAt))
      .limit(limit);
  }
}
