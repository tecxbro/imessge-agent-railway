import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";

import {
  memoryCandidateSchema,
  type MemoryCandidate,
} from "../../agent/schemas.js";
import {
  memoryCandidateHash,
  type CurationContext,
} from "../../memory/curator.js";
import {
  memoryCuratePayloadSchema,
  type MemoryCuratePayload,
} from "../../queue/payloads.js";
import type { Database, DatabaseTransaction } from "../client.js";
import {
  chainMemoryCandidates,
  memoryCurationRuns,
  type MemoryCandidateSourceStage,
} from "../schema-fragments/memory-curation.js";
import {
  carriedMessages,
  chains,
  channelIdentities,
  executionTasks,
  messages,
  owners,
  spaces,
} from "../schema.js";

const recordCandidatesSchema = z
  .object({
    chainId: z.uuid(),
    ownerId: z.uuid(),
    spaceId: z.uuid(),
    sourceStage: z.enum(["direct", "task", "synthesis"]),
    sourceTaskId: z.uuid().nullable(),
    candidates: z.array(memoryCandidateSchema).max(20),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.sourceStage === "task" && input.sourceTaskId === null) {
      context.addIssue({
        code: "custom",
        path: ["sourceTaskId"],
        message: "task candidates require the persisted execution task ID",
      });
    }
    if (input.sourceStage !== "task" && input.sourceTaskId !== null) {
      context.addIssue({
        code: "custom",
        path: ["sourceTaskId"],
        message: "only task candidates may reference an execution task",
      });
    }
  });

const failureCodeSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Z0-9_]+$/u);

export interface RecordMemoryCandidatesInput {
  chainId: string;
  ownerId: string;
  spaceId: string;
  sourceStage: MemoryCandidateSourceStage;
  sourceTaskId: string | null;
  candidates: readonly MemoryCandidate[];
}

export interface StoredMemoryCandidate {
  sourceStage: MemoryCandidateSourceStage;
  sourceTaskId: string | null;
  contentHash: string;
  candidate: MemoryCandidate;
}

export type MemoryCurationClaim =
  | {
      status: "claimed";
      chainId: string;
      candidates: readonly StoredMemoryCandidate[];
      context?: CurationContext;
    }
  | {
      status: "deferred" | "not_ready" | "terminal" | "rejected";
      chainId: string;
      code: string;
    };

export interface MemoryCurationReconciliationWork {
  completedWithoutRuns: readonly MemoryCuratePayload[];
  pendingRuns: readonly MemoryCuratePayload[];
  retryableFailedRuns: readonly MemoryCuratePayload[];
  deferredRuns: readonly MemoryCuratePayload[];
  staleRunningRuns: readonly MemoryCuratePayload[];
}

export interface MemoryCurationRepositoryOptions {
  encrypt(plaintext: string): Promise<string> | string;
  decrypt(ciphertext: string): Promise<string> | string;
}

export class MemoryCurationRepositoryError extends Error {
  public constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MemoryCurationRepositoryError";
  }
}

function payload(chainId: string, version: number): MemoryCuratePayload {
  return {
    chainId,
    expectedChainVersion: version,
    expectedState: "complete",
  };
}

export class MemoryCurationRepository {
  public constructor(
    private readonly database: Database,
    private readonly options: MemoryCurationRepositoryOptions,
  ) {}

  public async recordCandidates(
    input: RecordMemoryCandidatesInput,
  ): Promise<{ insertedCandidateCount: number }> {
    return this.database.transaction(async (transaction) =>
      this.recordCandidatesInTransaction(transaction, input),
    );
  }

  /**
   * Integration commit hooks call this overload with their existing transaction
   * so candidate ciphertext and its source decision/result commit atomically.
   */
  public async recordCandidatesInTransaction(
    transaction: DatabaseTransaction,
    input: RecordMemoryCandidatesInput,
  ): Promise<{ insertedCandidateCount: number }> {
    const parsed = recordCandidatesSchema.parse(input);
    const [scope] = await transaction
      .select({
        chainSpaceId: chains.spaceId,
        chainState: chains.state,
        canceledAt: chains.canceledAt,
        spaceDeploymentId: spaces.deploymentId,
        ownerDeploymentId: owners.deploymentId,
      })
      .from(chains)
      .innerJoin(spaces, eq(spaces.id, chains.spaceId))
      .innerJoin(owners, eq(owners.id, parsed.ownerId))
      .where(eq(chains.id, parsed.chainId))
      .limit(1);
    if (
      scope === undefined ||
      scope.chainSpaceId !== parsed.spaceId ||
      scope.ownerDeploymentId !== scope.spaceDeploymentId
    ) {
      throw new MemoryCurationRepositoryError(
        "MEMORY_CANDIDATE_SCOPE_INVALID",
        false,
        "Memory candidate scope does not match the authoritative chain, owner, and space. Repair the commit hook inputs before retrying.",
      );
    }
    const authoritativeOwnerIds = await this.ownerIdsForChain(
      transaction,
      parsed.chainId,
    );
    if (
      authoritativeOwnerIds.size !== 1 ||
      !authoritativeOwnerIds.has(parsed.ownerId)
    ) {
      throw new MemoryCurationRepositoryError(
        "MEMORY_CANDIDATE_OWNER_INVALID",
        false,
        "Memory candidate owner does not match the authoritative authorized sender for the chain.",
      );
    }
    if (scope.canceledAt !== null || scope.chainState === "canceled") {
      throw new MemoryCurationRepositoryError(
        "MEMORY_CHAIN_SUPERSEDED",
        false,
        "Memory candidates cannot be attached to a superseded chain.",
      );
    }
    if (scope.chainState === "failed") {
      throw new MemoryCurationRepositoryError(
        "MEMORY_CHAIN_FAILED",
        false,
        "Memory candidates cannot be attached to a failed chain.",
      );
    }

    if (parsed.sourceTaskId !== null) {
      const [task] = await transaction
        .select({ id: executionTasks.id })
        .from(executionTasks)
        .where(
          and(
            eq(executionTasks.id, parsed.sourceTaskId),
            eq(executionTasks.chainId, parsed.chainId),
          ),
        )
        .limit(1);
      if (task === undefined) {
        throw new MemoryCurationRepositoryError(
          "MEMORY_CANDIDATE_TASK_INVALID",
          false,
          "Task memory candidates must reference an execution task from the same chain.",
        );
      }
    }

    await transaction
      .insert(memoryCurationRuns)
      .values({ chainId: parsed.chainId, state: "pending" })
      .onConflictDoNothing({ target: memoryCurationRuns.chainId });

    const encryptedByHash = new Map<
      string,
      {
        encryptedCandidate: string;
        candidate: MemoryCandidate;
      }
    >();
    for (const candidate of parsed.candidates) {
      const contentHash = memoryCandidateHash(candidate, {
        spaceId: parsed.spaceId,
      });
      if (encryptedByHash.has(contentHash)) {
        continue;
      }
      const serialized = JSON.stringify(candidate);
      const encryptedCandidate = await this.options.encrypt(serialized);
      if (
        encryptedCandidate.length === 0 ||
        encryptedCandidate === serialized ||
        encryptedCandidate.includes(candidate.content)
      ) {
        throw new MemoryCurationRepositoryError(
          "MEMORY_CANDIDATE_ENCRYPTION_INVALID",
          false,
          "The memory candidate encryption boundary returned plaintext. Configure the application data cipher before retrying.",
        );
      }
      encryptedByHash.set(contentHash, { encryptedCandidate, candidate });
    }

    if (encryptedByHash.size === 0) {
      return { insertedCandidateCount: 0 };
    }
    const inserted = await transaction
      .insert(chainMemoryCandidates)
      .values(
        [...encryptedByHash].map(
          ([contentHash, { encryptedCandidate }]) => ({
            chainId: parsed.chainId,
            ownerId: parsed.ownerId,
            spaceId: parsed.spaceId,
            sourceStage: parsed.sourceStage,
            sourceTaskId: parsed.sourceTaskId,
            encryptedCandidate,
            contentHash,
          }),
        ),
      )
      .onConflictDoNothing({
        target: [chainMemoryCandidates.chainId, chainMemoryCandidates.contentHash],
      })
      .returning({ contentHash: chainMemoryCandidates.contentHash });
    return { insertedCandidateCount: inserted.length };
  }

  public async claimRun(
    unparsedPayload: MemoryCuratePayload,
    providerEnabled: boolean,
  ): Promise<MemoryCurationClaim> {
    const job = memoryCuratePayloadSchema.parse(unparsedPayload);
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select id from ${chains} where ${chains.id} = ${job.chainId} for update`,
      );
      const [chain] = await transaction
        .select({
          chainId: chains.id,
          version: chains.version,
          state: chains.state,
          canceledAt: chains.canceledAt,
          spaceId: spaces.id,
          deploymentId: spaces.deploymentId,
        })
        .from(chains)
        .innerJoin(spaces, eq(spaces.id, chains.spaceId))
        .where(eq(chains.id, job.chainId))
        .limit(1);
      if (chain === undefined) {
        return {
          status: "rejected" as const,
          chainId: job.chainId,
          code: "MEMORY_CHAIN_NOT_FOUND",
        };
      }

      if (chain.state === "complete" && chain.canceledAt === null) {
        await transaction
          .insert(memoryCurationRuns)
          .values({ chainId: job.chainId, state: "pending" })
          .onConflictDoNothing({ target: memoryCurationRuns.chainId });
      }
      const [run] = await transaction
        .select({ state: memoryCurationRuns.state })
        .from(memoryCurationRuns)
        .where(eq(memoryCurationRuns.chainId, job.chainId))
        .limit(1);

      if (chain.version !== job.expectedChainVersion) {
        await this.rejectRun(
          transaction,
          job.chainId,
          "MEMORY_CHAIN_SUPERSEDED",
        );
        return {
          status: "rejected" as const,
          chainId: job.chainId,
          code: "MEMORY_CHAIN_SUPERSEDED",
        };
      }
      if (chain.canceledAt !== null || chain.state === "canceled") {
        await this.rejectRun(
          transaction,
          job.chainId,
          "MEMORY_CHAIN_SUPERSEDED",
        );
        return {
          status: "rejected" as const,
          chainId: job.chainId,
          code: "MEMORY_CHAIN_SUPERSEDED",
        };
      }
      if (chain.state === "failed") {
        await this.rejectRun(transaction, job.chainId, "MEMORY_CHAIN_FAILED");
        return {
          status: "rejected" as const,
          chainId: job.chainId,
          code: "MEMORY_CHAIN_FAILED",
        };
      }
      if (chain.state !== job.expectedState) {
        return {
          status: "not_ready" as const,
          chainId: job.chainId,
          code: "MEMORY_CHAIN_NOT_COMPLETE",
        };
      }
      if (run?.state === "succeeded" || run?.state === "failed_terminal") {
        return {
          status: "terminal" as const,
          chainId: job.chainId,
          code:
            run.state === "succeeded"
              ? "MEMORY_CURATION_ALREADY_SUCCEEDED"
              : "MEMORY_CURATION_ALREADY_TERMINAL",
        };
      }
      if (!providerEnabled) {
        await transaction
          .update(memoryCurationRuns)
          .set({
            state: "deferred_provider_disabled",
            lastFailureCode: "MEMORY_PROVIDER_DISABLED",
            updatedAt: new Date(),
          })
          .where(eq(memoryCurationRuns.chainId, job.chainId));
        return {
          status: "deferred" as const,
          chainId: job.chainId,
          code: "MEMORY_PROVIDER_DISABLED",
        };
      }

      const rows = await transaction
        .select({
          ownerId: chainMemoryCandidates.ownerId,
          spaceId: chainMemoryCandidates.spaceId,
          sourceStage: chainMemoryCandidates.sourceStage,
          sourceTaskId: chainMemoryCandidates.sourceTaskId,
          encryptedCandidate: chainMemoryCandidates.encryptedCandidate,
          contentHash: chainMemoryCandidates.contentHash,
        })
        .from(chainMemoryCandidates)
        .where(eq(chainMemoryCandidates.chainId, job.chainId))
        .orderBy(
          asc(chainMemoryCandidates.sourceStage),
          asc(chainMemoryCandidates.sourceTaskId),
          asc(chainMemoryCandidates.contentHash),
        );

      const validated = await this.validateStoredCandidates(
        transaction,
        chain,
        rows,
      );
      if (validated === null) {
        await this.rejectRun(
          transaction,
          job.chainId,
          "MEMORY_CANDIDATE_INVALID",
        );
        return {
          status: "rejected" as const,
          chainId: job.chainId,
          code: "MEMORY_CANDIDATE_INVALID",
        };
      }

      await transaction
        .update(memoryCurationRuns)
        .set({
          state: "running",
          attemptCount: sql`${memoryCurationRuns.attemptCount} + 1`,
          lastFailureCode: null,
          updatedAt: new Date(),
        })
        .where(eq(memoryCurationRuns.chainId, job.chainId));
      return {
        status: "claimed" as const,
        chainId: job.chainId,
        candidates: validated.candidates,
        ...(validated.context === undefined
          ? {}
          : { context: validated.context }),
      };
    });
  }

  public async markSucceeded(chainId: string): Promise<void> {
    const updated = await this.database
      .update(memoryCurationRuns)
      .set({
        state: "succeeded",
        lastFailureCode: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(memoryCurationRuns.chainId, z.uuid().parse(chainId)),
          eq(memoryCurationRuns.state, "running"),
        ),
      )
      .returning({ chainId: memoryCurationRuns.chainId });
    if (updated.length !== 1) {
      throw new MemoryCurationRepositoryError(
        "MEMORY_CURATION_RUN_NOT_CLAIMED",
        true,
        "The memory curation run was not in running state while completing. Reconcile the chain before retrying.",
      );
    }
  }

  public async markFailed(input: {
    chainId: string;
    failureCode: string;
    retryable: boolean;
  }): Promise<void> {
    const chainId = z.uuid().parse(input.chainId);
    const failureCode = failureCodeSchema.parse(input.failureCode);
    const updated = await this.database
      .update(memoryCurationRuns)
      .set({
        state: input.retryable ? "failed_retryable" : "failed_terminal",
        lastFailureCode: failureCode,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(memoryCurationRuns.chainId, chainId),
          eq(memoryCurationRuns.state, "running"),
        ),
      )
      .returning({ chainId: memoryCurationRuns.chainId });
    if (updated.length !== 1) {
      throw new MemoryCurationRepositoryError(
        "MEMORY_CURATION_RUN_NOT_CLAIMED",
        true,
        "The memory curation run was not in running state while failing. Reconcile the chain before retrying.",
      );
    }
  }

  public async findReconciliationWork(input: {
    providerEnabled: boolean;
    runningBefore?: Date;
    limit?: number;
  }): Promise<MemoryCurationReconciliationWork> {
    const limit = z.number().int().min(1).max(500).parse(input.limit ?? 100);
    const completedWithoutRuns = await this.database
      .select({ chainId: chains.id, version: chains.version })
      .from(chains)
      .leftJoin(
        memoryCurationRuns,
        eq(memoryCurationRuns.chainId, chains.id),
      )
      .where(
        and(
          eq(chains.state, "complete"),
          isNull(chains.canceledAt),
          isNull(memoryCurationRuns.chainId),
        ),
      )
      .orderBy(asc(chains.updatedAt))
      .limit(limit);

    const loadRuns = async (
      state:
        | "pending"
        | "failed_retryable"
        | "deferred_provider_disabled"
        | "running",
      updatedBefore?: Date,
    ) =>
      this.database
        .select({ chainId: chains.id, version: chains.version })
        .from(memoryCurationRuns)
        .innerJoin(chains, eq(chains.id, memoryCurationRuns.chainId))
        .where(
          and(
            eq(memoryCurationRuns.state, state),
            eq(chains.state, "complete"),
            isNull(chains.canceledAt),
            ...(updatedBefore === undefined
              ? []
              : [lte(memoryCurationRuns.updatedAt, updatedBefore)]),
          ),
        )
        .orderBy(asc(memoryCurationRuns.updatedAt))
        .limit(limit);

    const [pending, retryable, deferred, staleRunning] = await Promise.all([
      loadRuns("pending"),
      loadRuns("failed_retryable"),
      input.providerEnabled
        ? loadRuns("deferred_provider_disabled")
        : Promise.resolve([]),
      input.runningBefore === undefined
        ? Promise.resolve([])
        : loadRuns("running", input.runningBefore),
    ]);
    return {
      completedWithoutRuns: completedWithoutRuns.map((row) =>
        payload(row.chainId, row.version),
      ),
      pendingRuns: pending.map((row) => payload(row.chainId, row.version)),
      retryableFailedRuns: retryable.map((row) =>
        payload(row.chainId, row.version),
      ),
      deferredRuns: deferred.map((row) => payload(row.chainId, row.version)),
      staleRunningRuns: staleRunning.map((row) =>
        payload(row.chainId, row.version),
      ),
    };
  }

  private async validateStoredCandidates(
    transaction: DatabaseTransaction,
    chain: { chainId: string; spaceId: string; deploymentId: string },
    rows: readonly {
      ownerId: string;
      spaceId: string;
      sourceStage: MemoryCandidateSourceStage;
      sourceTaskId: string | null;
      encryptedCandidate: string;
      contentHash: string;
    }[],
  ): Promise<
    | {
        candidates: readonly StoredMemoryCandidate[];
        context?: CurationContext;
      }
    | null
  > {
    if (rows.length === 0) {
      return { candidates: [] };
    }
    const ownerIds = new Set(rows.map((row) => row.ownerId));
    if (
      ownerIds.size !== 1 ||
      rows.some((row) => row.spaceId !== chain.spaceId)
    ) {
      return null;
    }
    const ownerId = [...ownerIds][0];
    if (ownerId === undefined) {
      return null;
    }
    const [owner] = await transaction
      .select({ deploymentId: owners.deploymentId })
      .from(owners)
      .where(eq(owners.id, ownerId))
      .limit(1);
    if (owner?.deploymentId !== chain.deploymentId) {
      return null;
    }
    const authoritativeOwnerIds = await this.ownerIdsForChain(
      transaction,
      chain.chainId,
    );
    if (
      authoritativeOwnerIds.size !== 1 ||
      !authoritativeOwnerIds.has(ownerId)
    ) {
      return null;
    }

    const taskIds = rows.flatMap((row) =>
      row.sourceTaskId === null ? [] : [row.sourceTaskId],
    );
    if (taskIds.length > 0) {
      const tasks = await transaction
        .select({ id: executionTasks.id, chainId: executionTasks.chainId })
        .from(executionTasks)
        .where(inArray(executionTasks.id, taskIds));
      const validTasks = new Set(
        tasks
          .filter((task) => task.chainId === chain.chainId)
          .map((task) => task.id),
      );
      if (taskIds.some((taskId) => !validTasks.has(taskId))) {
        return null;
      }
    }

    const candidates: StoredMemoryCandidate[] = [];
    for (const row of rows) {
      if (
        (row.sourceStage === "task") !== (row.sourceTaskId !== null)
      ) {
        return null;
      }
      try {
        const plaintext = await this.options.decrypt(row.encryptedCandidate);
        const candidate = memoryCandidateSchema.parse(JSON.parse(plaintext));
        if (
          memoryCandidateHash(candidate, { spaceId: chain.spaceId }) !==
          row.contentHash
        ) {
          return null;
        }
        candidates.push({
          sourceStage: row.sourceStage,
          sourceTaskId: row.sourceTaskId,
          contentHash: row.contentHash,
          candidate,
        });
      } catch {
        return null;
      }
    }
    return {
      candidates,
      context: {
        deploymentId: chain.deploymentId,
        ownerId,
        spaceId: chain.spaceId,
        chainId: chain.chainId,
        turnSucceeded: true,
      },
    };
  }

  private async rejectRun(
    transaction: DatabaseTransaction,
    chainId: string,
    code: string,
  ): Promise<void> {
    await transaction
      .update(memoryCurationRuns)
      .set({
        state: "failed_terminal",
        lastFailureCode: failureCodeSchema.parse(code),
        updatedAt: new Date(),
      })
      .where(eq(memoryCurationRuns.chainId, chainId));
  }

  private async ownerIdsForChain(
    transaction: DatabaseTransaction,
    chainId: string,
  ): Promise<ReadonlySet<string>> {
    const direct = await transaction
      .select({ ownerId: channelIdentities.ownerId })
      .from(messages)
      .leftJoin(
        channelIdentities,
        eq(channelIdentities.id, messages.senderIdentityId),
      )
      .where(eq(messages.drainedChainId, chainId));
    const carried = await transaction
      .select({ ownerId: channelIdentities.ownerId })
      .from(carriedMessages)
      .innerJoin(messages, eq(messages.id, carriedMessages.sourceMessageId))
      .leftJoin(
        channelIdentities,
        eq(channelIdentities.id, messages.senderIdentityId),
      )
      .where(eq(carriedMessages.consumedByChainId, chainId));
    return new Set(
      [...direct, ...carried].flatMap(({ ownerId }) =>
        ownerId === null ? [] : [ownerId],
      ),
    );
  }
}
