import { randomUUID } from "node:crypto";

import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { ExecutionCapabilitySource } from "../../orchestration/contracts/capabilities.js";
import type { PermissionProfileName } from "../../security/permissions.js";
import type {
  QueuedAuthorizationReference,
  QueuedAuthorizationReferenceStore,
} from "../../security/queued-authorization.js";
import type { TaskTerminalOutcome } from "../../orchestration/contracts/task-execution.js";
import type {
  PlanFinalCommitInput,
  TurnPlanContext,
} from "../../orchestration/contracts/turn-plan.js";
import type { SynthesisFinalCommitInput } from "../../orchestration/contracts/turn-synthesis.js";
import type { MemoryCurationRepository } from "./memory-curation.js";
import type { Database, DatabaseTransaction } from "../client.js";
import {
  carriedMessages,
  chains,
  channelIdentities,
  executionTasks,
  messages,
  outboundBatches,
  outboundParts,
  spaces,
} from "../schema.js";
import { OrchestrationCodec } from "./orchestration-codec.js";
import { stableClientGuid } from "./outbound.js";

export const dependencyIdsSchema = z.array(z.uuid()).max(5);

export const terminalTaskStates = [
  "succeeded",
  "failed",
  "canceled",
  "needs_approval",
] as const;

export interface LoadedMessage {
  id: string;
  contentCiphertext: string | null;
  receivedAt: Date | null;
  ownerId: string | null;
  carried: boolean;
}

export interface OrchestrationRepositoryOptions {
  workspaceRoot: string;
  interactionWorkingDirectory: string;
  decrypt(ciphertext: string): Promise<string> | string;
  encrypt(plaintext: string): Promise<string> | string;
  capabilities: ExecutionCapabilitySource;
  authorizationReferences?: QueuedAuthorizationReferenceStore;
  authorizeCapability?(input: {
    identity: {
      deploymentId: string;
      ownerId: string;
      spaceId: string;
    };
    authorizationReference: QueuedAuthorizationReference;
    workspaceBinding: string;
    permissionProfile: PermissionProfileName;
  }): Promise<{
    resolvedWorkspacePath: string;
    allowedPermissionProfiles: readonly PermissionProfileName[];
  }>;
  memoryCuration?: Pick<
    MemoryCurationRepository,
    "recordCandidatesInTransaction"
  >;
  priorStatusMessages?(
    spaceId: string,
  ): Promise<TurnPlanContext["priorStatusMessages"]>;
  maximumTaskAttempts?: number;
}

export async function loadChainMessages(
  database: Database | DatabaseTransaction,
  chainId: string,
): Promise<LoadedMessage[]> {
  const direct = await database
    .select({
      id: messages.id,
      contentCiphertext: messages.contentCiphertext,
      receivedAt: messages.receivedAt,
      ownerId: channelIdentities.ownerId,
    })
    .from(messages)
    .leftJoin(
      channelIdentities,
      eq(channelIdentities.id, messages.senderIdentityId),
    )
    .where(eq(messages.drainedChainId, chainId));
  const carried = await database
    .select({
      id: messages.id,
      contentCiphertext: messages.contentCiphertext,
      receivedAt: messages.receivedAt,
      ownerId: channelIdentities.ownerId,
    })
    .from(carriedMessages)
    .innerJoin(messages, eq(messages.id, carriedMessages.sourceMessageId))
    .leftJoin(
      channelIdentities,
      eq(channelIdentities.id, messages.senderIdentityId),
    )
    .where(eq(carriedMessages.consumedByChainId, chainId));
  const byId = new Map<string, LoadedMessage>();
  for (const message of direct) {
    byId.set(message.id, { ...message, carried: false });
  }
  for (const message of carried) {
    if (!byId.has(message.id)) {
      byId.set(message.id, { ...message, carried: true });
    }
  }
  return [...byId.values()].sort((left, right) => {
    const time =
      (left.receivedAt?.getTime() ?? 0) -
      (right.receivedAt?.getTime() ?? 0);
    return time === 0 ? left.id.localeCompare(right.id) : time;
  });
}

export async function ownerIdForChain(
  transaction: DatabaseTransaction,
  chainId: string,
): Promise<string> {
  const rows = await loadChainMessages(transaction, chainId);
  const owners = new Set(
    rows
      .map((row) => row.ownerId)
      .filter((ownerId): ownerId is string => ownerId !== null),
  );
  const ownerId = [...owners][0];
  if (owners.size !== 1 || ownerId === undefined) {
    throw new Error(
      "Execution tasks require exactly one authorized owner for the chain.",
    );
  }
  return ownerId;
}

export async function releaseDependents(
  transaction: DatabaseTransaction,
  chainId: string,
  codec: OrchestrationCodec,
): Promise<TaskTerminalOutcome> {
  const rows = await transaction
    .select({
      id: executionTasks.id,
      logicalId: executionTasks.name,
      state: executionTasks.state,
      dependencies: executionTasks.dependsOnJson,
    })
    .from(executionTasks)
    .where(eq(executionTasks.chainId, chainId))
    .orderBy(asc(executionTasks.createdAt), asc(executionTasks.id));
  const states = new Map(rows.map((task) => [task.id, task.state]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of rows) {
      if (states.get(task.id) !== "queued") {
        continue;
      }
      const dependencies = dependencyIdsSchema.parse(task.dependencies);
      if (
        dependencies.some((dependency) => {
          const state = states.get(dependency);
          return (
            state === "failed" ||
            state === "canceled" ||
            state === "needs_approval"
          );
        })
      ) {
        const result = codec.safeDependencyFailure(task.logicalId);
        await transaction
          .update(executionTasks)
          .set({
            state: "failed",
            resultJson: await codec.resultForStorage(result),
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(executionTasks.id, task.id));
        states.set(task.id, "failed");
        changed = true;
      }
    }
  }

  const readyTasks = rows
    .filter((task) => {
      if (states.get(task.id) !== "queued") {
        return false;
      }
      return dependencyIdsSchema
        .parse(task.dependencies)
        .every((dependency) => states.get(dependency) === "succeeded");
    })
    .map((task) => ({ taskId: task.id }));
  const shouldSynthesize = [...states.values()].every((state) =>
    terminalTaskStates.includes(
      state as (typeof terminalTaskStates)[number],
    ),
  );
  return { accepted: true, readyTasks, shouldSynthesize };
}

export async function commitFinalResponse(
  database: Database,
  input: PlanFinalCommitInput | SynthesisFinalCommitInput,
  options: OrchestrationRepositoryOptions,
  codec: OrchestrationCodec,
): Promise<{ outboundBatchId: string }> {
  const decision = codec.parseDecision(input.decision);
  if (input.encryptedParts.length === 0) {
    throw new Error("A final response must contain at least one encrypted bubble.");
  }

  return database.transaction((transaction) =>
    commitFinalResponseTransaction(transaction, input, decision, options, codec),
  );
}

async function commitFinalResponseTransaction(
  transaction: DatabaseTransaction,
  input: PlanFinalCommitInput | SynthesisFinalCommitInput,
  decision: ReturnType<OrchestrationCodec["parseDecision"]>,
  options: OrchestrationRepositoryOptions,
  codec: OrchestrationCodec,
): Promise<{ outboundBatchId: string }> {
  await transaction.execute(
    sql`select id from ${chains} where ${chains.id} = ${input.payload.chainId} for update`,
  );
  const [existing] = await transaction
    .select({ id: outboundBatches.id })
    .from(outboundBatches)
    .where(eq(outboundBatches.chainId, input.payload.chainId))
    .limit(1);
  if (existing !== undefined) {
    return { outboundBatchId: existing.id };
  }

  const [chain] = await transaction
    .select({
      id: chains.id,
      state: chains.state,
      version: chains.version,
      canceledAt: chains.canceledAt,
      spaceId: chains.spaceId,
      deploymentId: spaces.deploymentId,
    })
    .from(chains)
    .innerJoin(spaces, eq(spaces.id, chains.spaceId))
    .where(eq(chains.id, input.payload.chainId))
    .limit(1);
  if (
    chain === undefined ||
    chain.version !== input.payload.expectedChainVersion ||
    chain.state !== input.payload.expectedState ||
    chain.canceledAt !== null
  ) {
    throw new Error(
      "Final response commit rejected because the chain is stale, canceled, or in the wrong state.",
    );
  }

  const batchId = randomUUID();
  await transaction.insert(outboundBatches).values({
    id: batchId,
    chainId: chain.id,
    spaceId: chain.spaceId,
    state: "queued",
    startIndex: 0,
    partCount: input.encryptedParts.length,
  });
  await transaction.insert(outboundParts).values(
    input.encryptedParts.map((contentCiphertext, position) => ({
      id: randomUUID(),
      batchId,
      position,
      clientGuid: stableClientGuid(chain.deploymentId, batchId, position),
      contentCiphertext,
      state: "pending" as const,
    })),
  );
  if (options.memoryCuration !== undefined) {
    await options.memoryCuration.recordCandidatesInTransaction(transaction, {
      chainId: chain.id,
      ownerId: await ownerIdForChain(transaction, chain.id),
      spaceId: chain.spaceId,
      sourceStage:
        input.payload.expectedState === "queued" ? "direct" : "synthesis",
      sourceTaskId: null,
      candidates: decision.memoryCandidates,
    });
  }
  await transaction
    .update(chains)
    .set({
      state: "sending",
      decisionJson: codec.decisionForStorage(decision),
      promptVersion: input.promptVersion,
      terminalErrorCode: null,
      updatedAt: new Date(),
    })
    .where(eq(chains.id, chain.id));
  return { outboundBatchId: batchId };
}
