import { randomUUID } from "node:crypto";

import { and, asc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";

import { executionResultSchema, type ExecutionResult } from "../../agent/schemas.js";
import type {
  ApprovalChainProgression,
  ApprovalExpiryOutcome,
  ApprovalPersistence,
  ApprovalResponseOutcome,
  StoredApprovalRecord,
} from "../../security/approvals.js";
import { actionExecutions } from "../schema-fragments/approval-executions.js";
import type { Database, DatabaseTransaction } from "../client.js";
import {
  agentThreads,
  approvals,
  chains,
  channelIdentities,
  deployments,
  executionTasks,
  owners,
  spaces,
} from "../schema.js";

export interface CreateApprovalInput {
  id?: string;
  chainId: string;
  executionTaskId: string;
  ownerId: string;
  spaceId: string;
  actionType: string;
  normalizedPayloadCiphertext: string;
  actionHash: string;
  humanSummary: string;
  expiresAt: Date;
}

export interface ApprovalResponseInput {
  approvalId: string;
  ownerId: string;
  spaceId: string;
  approvedByIdentityId?: string;
  status: "approved" | "rejected";
  now?: Date;
}

export interface ConsumeApprovedActionInput {
  approvalId: string;
  ownerId: string;
  spaceId: string;
  executionTaskId: string;
  expectedActionHash: string;
  expectedPayloadCiphertext: string;
  actionExecutionId?: string;
  actionType?: string;
  now?: Date;
}

export interface ApprovalRepositoryOptions {
  encryptExecutionResult?(plaintext: string): Promise<string> | string;
}

export interface DurableApprovalRequestContext {
  ownerId: string;
  spaceId: string;
  chainId: string;
  executionTaskId: string;
  logicalTaskId: string;
  executionResultCiphertext: string;
}

export interface ApprovalExpiryScope {
  ownerId: string;
  spaceId: string;
}

export interface ApprovedActionRecovery {
  approvalId: string;
  ownerId: string;
  spaceId: string;
  executionTaskId: string;
}

const storedExecutionResultSchema = z
  .object({ ciphertext: z.string().min(1) })
  .strict();

const dependencyIdsSchema = z.array(z.uuid()).max(5);
const terminalTaskStates = ["succeeded", "failed", "canceled"] as const;

const approvalSelection = {
  id: approvals.id,
  chainId: approvals.chainId,
  executionTaskId: approvals.executionTaskId,
  ownerId: approvals.ownerId,
  spaceId: approvals.spaceId,
  actionType: approvals.actionType,
  normalizedPayloadCiphertext: approvals.normalizedPayloadCiphertext,
  actionHash: approvals.actionHash,
  humanSummary: approvals.humanSummary,
  status: approvals.status,
  expiresAt: approvals.expiresAt,
};

export class ApprovalRepository implements ApprovalPersistence {
  public constructor(
    private readonly database: Database,
    private readonly options: ApprovalRepositoryOptions = {},
  ) {}

  public async createPending(input: CreateApprovalInput): Promise<string> {
    const approvalId = input.id ?? randomUUID();
    let storedApprovalId = approvalId;
    await this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${input.spaceId}, 0))`,
      );
      const [chain] = await transaction
        .select({ id: chains.id })
        .from(chains)
        .innerJoin(spaces, eq(chains.spaceId, spaces.id))
        .innerJoin(owners, eq(owners.deploymentId, spaces.deploymentId))
        .innerJoin(deployments, eq(deployments.id, spaces.deploymentId))
        .where(
          and(
            eq(chains.id, input.chainId),
            eq(chains.spaceId, input.spaceId),
            eq(owners.id, input.ownerId),
            eq(owners.status, "active"),
            eq(deployments.status, "active"),
            inArray(chains.state, ["executing", "awaiting_approval"]),
            isNull(chains.canceledAt),
            sql`${chains.version} = (select max(current_chain.version) from ${chains} current_chain where current_chain.space_id = ${chains.spaceId})`,
          ),
        )
        .for("update")
        .limit(1);
      if (chain === undefined) {
        throw new Error(
          "Approval creation rejected because its owner, deployment, or current chain is inactive. Reload authoritative state before retrying.",
        );
      }
      const [task] = await transaction
        .select({ id: executionTasks.id })
        .from(executionTasks)
        .where(
          and(
            eq(executionTasks.id, input.executionTaskId),
            eq(executionTasks.chainId, input.chainId),
            eq(executionTasks.state, "needs_approval"),
          ),
        )
        .for("update")
        .limit(1);
      if (task === undefined) {
        throw new Error(
          "Approval creation rejected because its execution task is not awaiting approval on the same chain.",
        );
      }

      const [existing] = await transaction
        .select({
          id: approvals.id,
          chainId: approvals.chainId,
          ownerId: approvals.ownerId,
          spaceId: approvals.spaceId,
          actionType: approvals.actionType,
        })
        .from(approvals)
        .where(
          and(
            eq(approvals.executionTaskId, input.executionTaskId),
            eq(approvals.actionHash, input.actionHash),
          ),
        )
        .for("update")
        .limit(1);
      if (existing !== undefined) {
        if (
          existing.chainId !== input.chainId ||
          existing.ownerId !== input.ownerId ||
          existing.spaceId !== input.spaceId ||
          existing.actionType !== input.actionType
        ) {
          throw new Error(
            "Approval idempotency key resolved to a differently scoped action. Reject the request and inspect durable state.",
          );
        }
        storedApprovalId = existing.id;
        return;
      }

      const [otherActive] = await transaction
        .select({ id: approvals.id })
        .from(approvals)
        .where(
          and(
            eq(approvals.executionTaskId, input.executionTaskId),
            inArray(approvals.status, ["pending", "approved"]),
          ),
        )
        .limit(1);
      if (otherActive !== undefined) {
        throw new Error(
          "The execution task already has a differently hashed active approval. Reject the changed payload.",
        );
      }

      await transaction.insert(approvals).values({
        id: approvalId,
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
      const transitioned = await transaction
        .update(chains)
        .set({ state: "awaiting_approval", updatedAt: new Date() })
        .where(
          and(
            eq(chains.id, input.chainId),
            inArray(chains.state, ["executing", "awaiting_approval"]),
            isNull(chains.canceledAt),
          ),
        )
        .returning({ id: chains.id });
      if (transitioned.length !== 1) {
        throw new Error(
          "Approval creation lost a cancellation race. The transaction was rolled back without reviving the chain.",
        );
      }
    });
    return storedApprovalId;
  }

  public async findBound(
    approvalId: string,
    ownerId: string,
    spaceId: string,
  ): Promise<StoredApprovalRecord | undefined> {
    const [row] = await this.database
      .select(approvalSelection)
      .from(approvals)
      .where(
        and(
          eq(approvals.id, approvalId),
          eq(approvals.ownerId, ownerId),
          eq(approvals.spaceId, spaceId),
        ),
      )
      .limit(1);
    return row;
  }

  public async loadApprovalRequestContext(
    executionTaskId: string,
  ): Promise<DurableApprovalRequestContext | null> {
    const [row] = await this.database
      .select({
        ownerId: agentThreads.ownerId,
        spaceId: chains.spaceId,
        chainId: chains.id,
        chainVersion: chains.version,
        executionTaskId: executionTasks.id,
        logicalTaskId: executionTasks.name,
        taskState: executionTasks.state,
        chainState: chains.state,
        canceledAt: chains.canceledAt,
        resultJson: executionTasks.resultJson,
      })
      .from(executionTasks)
      .innerJoin(chains, eq(chains.id, executionTasks.chainId))
      .innerJoin(agentThreads, eq(agentThreads.id, executionTasks.agentThreadId))
      .where(eq(executionTasks.id, executionTaskId))
      .limit(1);
    if (
      row === undefined ||
      row.taskState !== "needs_approval" ||
      !["executing", "awaiting_approval"].includes(row.chainState) ||
      row.canceledAt !== null
    ) {
      return null;
    }
    const [current] = await this.database
      .select({ version: sql<number>`max(${chains.version})` })
      .from(chains)
      .where(eq(chains.spaceId, row.spaceId));
    if (current?.version !== row.chainVersion) {
      return null;
    }
    const stored = storedExecutionResultSchema.safeParse(row.resultJson);
    if (!stored.success) {
      throw new Error(
        "Approval request task has no exact encrypted execution result. Re-run the task before requesting approval.",
      );
    }
    return {
      ownerId: row.ownerId,
      spaceId: row.spaceId,
      chainId: row.chainId,
      executionTaskId: row.executionTaskId,
      logicalTaskId: row.logicalTaskId,
      executionResultCiphertext: stored.data.ciphertext,
    };
  }

  /** Re-publishes idempotent request jobs after a commit/publication crash. */
  public async findApprovalRequestTaskIds(limit = 100): Promise<string[]> {
    const rows = await this.database
      .select({ taskId: executionTasks.id })
      .from(executionTasks)
      .innerJoin(chains, eq(chains.id, executionTasks.chainId))
      .where(
        and(
          eq(executionTasks.state, "needs_approval"),
          inArray(chains.state, ["executing", "awaiting_approval"]),
          isNull(chains.canceledAt),
        ),
      )
      .orderBy(asc(executionTasks.updatedAt), asc(executionTasks.id))
      .limit(limit);
    return rows.map((row) => row.taskId);
  }

  /** Finds bounded owner/space scopes whose pending approvals need expiry. */
  public async findExpiredApprovalScopes(
    now = new Date(),
    limit = 100,
  ): Promise<ApprovalExpiryScope[]> {
    return await this.database
      .selectDistinct({ ownerId: approvals.ownerId, spaceId: approvals.spaceId })
      .from(approvals)
      .where(
        and(
          inArray(approvals.status, ["pending", "approved"]),
          lte(approvals.expiresAt, now),
          isNull(approvals.consumedAt),
        ),
      )
      .orderBy(asc(approvals.ownerId), asc(approvals.spaceId))
      .limit(limit);
  }

  /** Repairs a crash after owner approval but before atomic action creation. */
  public async findApprovedActionRecoveries(
    now = new Date(),
    limit = 100,
  ): Promise<ApprovedActionRecovery[]> {
    return await this.database
      .select({
        approvalId: approvals.id,
        ownerId: approvals.ownerId,
        spaceId: approvals.spaceId,
        executionTaskId: approvals.executionTaskId,
      })
      .from(approvals)
      .where(
        and(
          eq(approvals.status, "approved"),
          gt(approvals.expiresAt, now),
          isNull(approvals.consumedAt),
        ),
      )
      .orderBy(asc(approvals.updatedAt), asc(approvals.id))
      .limit(limit);
  }

  public async listPending(
    ownerId: string,
    spaceId: string,
    now: Date,
  ): Promise<StoredApprovalRecord[]> {
    return this.database
      .select(approvalSelection)
      .from(approvals)
      .where(
        and(
          eq(approvals.ownerId, ownerId),
          eq(approvals.spaceId, spaceId),
          eq(approvals.status, "pending"),
          gt(approvals.expiresAt, now),
        ),
      )
      .orderBy(asc(approvals.createdAt), asc(approvals.id))
      .limit(20);
  }

  public async compareAndSetResponse(input: ApprovalResponseInput): Promise<boolean> {
    return (await this.compareAndSetResponseWithProgression(input)).changed;
  }

  public async compareAndSetResponseWithProgression(
    input: ApprovalResponseInput,
  ): Promise<ApprovalResponseOutcome> {
    const now = input.now ?? new Date();
    if (input.approvedByIdentityId === undefined) {
      throw new Error(
        "Approval response requires the verified owner channel identity.",
      );
    }
    const approvedByIdentityId = input.approvedByIdentityId;
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${input.spaceId}, 0))`,
      );
      const [actor] = await transaction
        .select({ id: channelIdentities.id })
        .from(channelIdentities)
        .innerJoin(owners, eq(channelIdentities.ownerId, owners.id))
        .innerJoin(
          deployments,
          eq(channelIdentities.deploymentId, deployments.id),
        )
        .innerJoin(spaces, eq(spaces.deploymentId, deployments.id))
        .where(
          and(
            eq(channelIdentities.id, approvedByIdentityId),
            eq(channelIdentities.ownerId, input.ownerId),
            eq(channelIdentities.role, "owner"),
            isNull(channelIdentities.revokedAt),
            eq(owners.status, "active"),
            eq(deployments.status, "active"),
            eq(spaces.id, input.spaceId),
          ),
        )
        .limit(1);
      if (actor === undefined) {
        return { changed: false, progression: null };
      }

      const rows = await transaction
        .update(approvals)
        .set({
          status: input.status,
          approvedByIdentityId:
            input.status === "approved" ? input.approvedByIdentityId : null,
          updatedAt: now,
        })
        .where(
          and(
            eq(approvals.id, input.approvalId),
            eq(approvals.ownerId, input.ownerId),
            eq(approvals.spaceId, input.spaceId),
            eq(approvals.status, "pending"),
            gt(approvals.expiresAt, now),
            sql`exists (
              select 1 from chains live_chain
              where live_chain.id = ${approvals.chainId}
                and live_chain.state = 'awaiting_approval'
                and live_chain.canceled_at is null
                and live_chain.version = (
                  select max(current_chain.version) from chains current_chain
                  where current_chain.space_id = live_chain.space_id
                )
            )`,
          ),
        )
        .returning({
          id: approvals.id,
          chainId: approvals.chainId,
          executionTaskId: approvals.executionTaskId,
        });
      const changed = rows[0];
      if (changed === undefined) {
        return { changed: false, progression: null };
      }
      if (input.status === "rejected") {
        const taskResult = await this.encryptedTerminalTaskResult(
          transaction,
          changed.executionTaskId,
          "canceled",
          "The owner rejected the proposed action.",
          "APPROVAL_REJECTED",
        );
        const canceledTask = await transaction
          .update(executionTasks)
          .set({
            state: "canceled",
            ...(taskResult === undefined ? {} : { resultJson: taskResult }),
            completedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(executionTasks.id, changed.executionTaskId),
              eq(executionTasks.state, "needs_approval"),
            ),
          )
          .returning({ id: executionTasks.id });
        if (canceledTask.length !== 1) {
          throw new Error(
            "Approval rejection lost the execution-task transition. The transaction was rolled back.",
          );
        }
        await this.failBlockedDependents(transaction, changed.chainId, now);
        const progression = await this.progressionForChain(
          transaction,
          changed.chainId,
          now,
        );
        return {
          changed: true,
          progression:
            this.options.encryptExecutionResult === undefined
              ? null
              : progression,
        };
      }
      return { changed: true, progression: null };
    });
  }

  public async consumeApprovedAction(
    input: ConsumeApprovedActionInput,
  ): Promise<boolean> {
    const now = input.now ?? new Date();
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${input.spaceId}, 0))`,
      );
      const [approval] = await transaction
        .select({
          id: approvals.id,
          chainId: approvals.chainId,
          approvedByIdentityId: approvals.approvedByIdentityId,
        })
        .from(approvals)
        .where(
          and(
            eq(approvals.id, input.approvalId),
            eq(approvals.ownerId, input.ownerId),
            eq(approvals.spaceId, input.spaceId),
            eq(approvals.executionTaskId, input.executionTaskId),
            eq(approvals.actionHash, input.expectedActionHash),
            eq(
              approvals.normalizedPayloadCiphertext,
              input.expectedPayloadCiphertext,
            ),
            eq(approvals.status, "approved"),
            gt(approvals.expiresAt, now),
            isNull(approvals.consumedAt),
          ),
        )
        .for("update")
        .limit(1);
      if (approval?.approvedByIdentityId === null || approval === undefined) {
        return false;
      }

      const [live] = await transaction
        .select({ id: chains.id })
        .from(chains)
        .innerJoin(executionTasks, eq(executionTasks.chainId, chains.id))
        .innerJoin(
          channelIdentities,
          eq(channelIdentities.id, approval.approvedByIdentityId),
        )
        .innerJoin(owners, eq(owners.id, channelIdentities.ownerId))
        .innerJoin(deployments, eq(deployments.id, channelIdentities.deploymentId))
        .where(
          and(
            eq(chains.id, approval.chainId),
            eq(chains.spaceId, input.spaceId),
            eq(chains.state, "awaiting_approval"),
            isNull(chains.canceledAt),
            sql`${chains.version} = (select max(current_chain.version) from ${chains} current_chain where current_chain.space_id = ${chains.spaceId})`,
            eq(executionTasks.id, input.executionTaskId),
            eq(executionTasks.state, "needs_approval"),
            eq(channelIdentities.ownerId, input.ownerId),
            eq(channelIdentities.role, "owner"),
            isNull(channelIdentities.revokedAt),
            eq(owners.status, "active"),
            eq(deployments.status, "active"),
          ),
        )
        .for("update")
        .limit(1);
      if (live === undefined) {
        return false;
      }

      const consumed = await transaction
        .update(approvals)
        .set({ status: "consumed", consumedAt: now, updatedAt: now })
        .where(
          and(
            eq(approvals.id, input.approvalId),
            eq(approvals.status, "approved"),
            isNull(approvals.consumedAt),
          ),
        )
        .returning({ id: approvals.id });
      if (consumed.length !== 1) {
        return false;
      }
      const taskStarted = await transaction
        .update(executionTasks)
        .set({ state: "running", startedAt: now, updatedAt: now })
        .where(
          and(
            eq(executionTasks.id, input.executionTaskId),
            eq(executionTasks.state, "needs_approval"),
          ),
        )
        .returning({ id: executionTasks.id });
      if (taskStarted.length !== 1) {
        throw new Error(
          "Approval consumption lost the execution-task transition. The transaction was rolled back.",
        );
      }
      if (
        input.actionExecutionId !== undefined &&
        input.actionType !== undefined
      ) {
        const insertedExecution = await transaction
          .insert(actionExecutions)
          .values({
            id: input.actionExecutionId,
            approvalId: input.approvalId,
            executionTaskId: input.executionTaskId,
            ownerId: input.ownerId,
            spaceId: input.spaceId,
            actionType: input.actionType,
            normalizedPayloadCiphertext: input.expectedPayloadCiphertext,
            actionHash: input.expectedActionHash,
            status: "pending",
            updatedAt: now,
          })
          .returning({ id: actionExecutions.id });
        if (insertedExecution.length !== 1) {
          throw new Error(
            "Approval consumption could not create one durable action execution. The transaction was rolled back.",
          );
        }
      }
      await transaction
        .update(chains)
        .set({ state: "executing", updatedAt: now })
        .where(eq(chains.id, approval.chainId));
      return true;
    });
  }

  public async expireStale(
    ownerId: string,
    spaceId: string,
    now: Date,
  ): Promise<number> {
    return (await this.expireStaleWithProgression(ownerId, spaceId, now))
      .expiredCount;
  }

  public async expireStaleWithProgression(
    ownerId: string,
    spaceId: string,
    now: Date,
  ): Promise<ApprovalExpiryOutcome> {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${spaceId}, 0))`,
      );
      const rows = await transaction
        .update(approvals)
        .set({ status: "expired", updatedAt: now })
        .where(
          and(
            eq(approvals.ownerId, ownerId),
            eq(approvals.spaceId, spaceId),
            inArray(approvals.status, ["pending", "approved"]),
            lte(approvals.expiresAt, now),
            isNull(approvals.consumedAt),
          ),
        )
        .returning({
          id: approvals.id,
          chainId: approvals.chainId,
          executionTaskId: approvals.executionTaskId,
        });
      if (rows.length > 0) {
        for (const row of rows) {
          const taskResult = await this.encryptedTerminalTaskResult(
            transaction,
            row.executionTaskId,
            "canceled",
            "The proposed action expired before approval.",
            "APPROVAL_EXPIRED",
          );
          const canceledTask = await transaction
            .update(executionTasks)
            .set({
              state: "canceled",
              ...(taskResult === undefined ? {} : { resultJson: taskResult }),
              completedAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(executionTasks.id, row.executionTaskId),
                eq(executionTasks.state, "needs_approval"),
              ),
            )
            .returning({ id: executionTasks.id });
          if (canceledTask.length !== 1) {
            throw new Error(
              "Approval expiry lost the execution-task transition. The transaction was rolled back.",
            );
          }
        }
      }
      const chainIds = [...new Set(rows.map((row) => row.chainId))];
      const progressions: ApprovalChainProgression[] = [];
      for (const chainId of chainIds) {
        await this.failBlockedDependents(transaction, chainId, now);
        const progression = await this.progressionForChain(
          transaction,
          chainId,
          now,
        );
        if (
          progression !== null &&
          this.options.encryptExecutionResult !== undefined
        ) {
          progressions.push(progression);
        }
      }
      return { expiredCount: rows.length, progressions };
    });
  }

  private async encryptedTerminalTaskResult(
    transaction: DatabaseTransaction,
    executionTaskId: string,
    status: "failed" | "canceled",
    safeSummary: string,
    errorCode: string,
  ): Promise<Record<string, unknown> | undefined> {
    if (this.options.encryptExecutionResult === undefined) {
      return undefined;
    }
    const [task] = await transaction
      .select({ logicalTaskId: executionTasks.name })
      .from(executionTasks)
      .where(eq(executionTasks.id, executionTaskId))
      .limit(1);
    if (task === undefined) {
      return undefined;
    }
    const result: ExecutionResult = executionResultSchema.parse({
      taskId: task.logicalTaskId,
      status,
      userSafeSummary: safeSummary,
      artifacts: [],
      proposedActions: [],
      memoryCandidates: [],
      error: {
        code: errorCode,
        retryable: false,
        safeMessage: safeSummary,
      },
    });
    return {
      ciphertext: await this.options.encryptExecutionResult(
        JSON.stringify(result),
      ),
    };
  }

  private async failBlockedDependents(
    transaction: DatabaseTransaction,
    chainId: string,
    now: Date,
  ): Promise<void> {
    if (this.options.encryptExecutionResult === undefined) {
      return;
    }
    const rows = await transaction
      .select({
        id: executionTasks.id,
        state: executionTasks.state,
        dependencies: executionTasks.dependsOnJson,
      })
      .from(executionTasks)
      .where(eq(executionTasks.chainId, chainId))
      .orderBy(asc(executionTasks.createdAt), asc(executionTasks.id));
    const states = new Map(rows.map((row) => [row.id, row.state]));
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (states.get(row.id) !== "queued") {
          continue;
        }
        const dependencies = dependencyIdsSchema.parse(row.dependencies);
        if (
          dependencies.some((dependency) => {
            const state = states.get(dependency);
            return state === "failed" || state === "canceled";
          })
        ) {
          const taskResult = await this.encryptedTerminalTaskResult(
            transaction,
            row.id,
            "failed",
            "This task could not run because an approved prerequisite did not complete.",
            "APPROVAL_PREREQUISITE_UNAVAILABLE",
          );
          await transaction
            .update(executionTasks)
            .set({
              state: "failed",
              ...(taskResult === undefined ? {} : { resultJson: taskResult }),
              completedAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(executionTasks.id, row.id),
                eq(executionTasks.state, "queued"),
              ),
            );
          states.set(row.id, "failed");
          changed = true;
        }
      }
    }
  }

  private async progressionForChain(
    transaction: DatabaseTransaction,
    chainId: string,
    now: Date,
  ): Promise<ApprovalChainProgression | null> {
    const [chain] = await transaction
      .select({
        id: chains.id,
        version: chains.version,
        state: chains.state,
        canceledAt: chains.canceledAt,
      })
      .from(chains)
      .where(eq(chains.id, chainId))
      .for("update")
      .limit(1);
    if (chain === undefined || chain.canceledAt !== null) {
      return null;
    }
    const tasks = await transaction
      .select({
        id: executionTasks.id,
        state: executionTasks.state,
        dependencies: executionTasks.dependsOnJson,
      })
      .from(executionTasks)
      .where(eq(executionTasks.chainId, chainId))
      .orderBy(asc(executionTasks.createdAt), asc(executionTasks.id));
    const states = new Map(tasks.map((task) => [task.id, task.state]));
    const stillAwaitingApproval = [...states.values()].some(
      (state) => state === "needs_approval",
    );
    if (!stillAwaitingApproval && chain.state === "awaiting_approval") {
      await transaction
        .update(chains)
        .set({ state: "executing", updatedAt: now })
        .where(
          and(
            eq(chains.id, chainId),
            eq(chains.state, "awaiting_approval"),
            isNull(chains.canceledAt),
          ),
        );
    }
    const newlyRunnableTasks = tasks
      .filter(
        (task) =>
          task.state === "queued" &&
          dependencyIdsSchema
            .parse(task.dependencies)
            .every((dependency) => states.get(dependency) === "succeeded"),
      )
      .map((task) => ({
        taskId: task.id,
        chainId,
        expectedChainVersion: chain.version,
        expectedState: "queued" as const,
      }));
    const shouldSynthesize =
      tasks.length > 0 &&
      [...states.values()].every((state) =>
        terminalTaskStates.includes(
          state as (typeof terminalTaskStates)[number],
        ),
      );
    return {
      chainId,
      expectedChainVersion: chain.version,
      newlyRunnableTasks,
      shouldSynthesize,
    };
  }
}
