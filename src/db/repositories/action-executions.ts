import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";

import { executionResultSchema, type ExecutionResult } from "../../agent/schemas.js";
import type { ActionExecutorResult } from "../../actions/action-executor.js";
import type { ApprovalChainProgression } from "../../security/approvals.js";
import {
  actionTypeSchema,
  type ActionType,
} from "../../security/action-schema.js";
import type { Database, DatabaseTransaction } from "../client.js";
import { actionExecutions } from "../schema-fragments/approval-executions.js";
import {
  approvals,
  chains,
  channelIdentities,
  deployments,
  executionTasks,
  owners,
  spaces,
} from "../schema.js";

const dependencyIdsSchema = z.array(z.uuid()).max(5);
const terminalTaskStates = ["succeeded", "failed", "canceled"] as const;

export interface StoredActionExecution {
  actionExecutionId: string;
  approvalId: string;
  executionTaskId: string;
  ownerId: string;
  spaceId: string;
  chainId: string;
  actionType: ActionType;
  actionHash: string;
  normalizedPayloadCiphertext: string;
}

export interface ActionExecutionRepositoryOptions {
  encryptExecutionResult(plaintext: string): Promise<string> | string;
}

export interface ClaimActionExecutionInput {
  actionExecutionId: string;
}

export interface ActionExecutionFailureOutcome {
  retry: boolean;
  progression: ApprovalChainProgression | null;
}

export interface RecordActionExecutionFailureInput {
  actionExecutionId: string;
  errorCode: string;
  retryable: boolean;
  safeMessage: string;
  now?: Date;
}

export class ActionExecutionRepository {
  public constructor(
    private readonly database: Database,
    private readonly options: ActionExecutionRepositoryOptions,
  ) {}

  public async claimActionExecution(
    payload: ClaimActionExecutionInput,
    now = new Date(),
  ): Promise<StoredActionExecution | null> {
    return this.database.transaction(async (transaction) => {
      const [row] = await transaction
        .select({
          actionExecutionId: actionExecutions.id,
          approvalId: actionExecutions.approvalId,
          executionTaskId: actionExecutions.executionTaskId,
          ownerId: actionExecutions.ownerId,
          spaceId: actionExecutions.spaceId,
          actionType: actionExecutions.actionType,
          actionHash: actionExecutions.actionHash,
          normalizedPayloadCiphertext:
            actionExecutions.normalizedPayloadCiphertext,
          chainId: chains.id,
        })
        .from(actionExecutions)
        .innerJoin(approvals, eq(approvals.id, actionExecutions.approvalId))
        .innerJoin(
          executionTasks,
          eq(executionTasks.id, actionExecutions.executionTaskId),
        )
        .innerJoin(chains, eq(chains.id, executionTasks.chainId))
        .innerJoin(spaces, eq(spaces.id, actionExecutions.spaceId))
        .innerJoin(owners, eq(owners.id, actionExecutions.ownerId))
        .innerJoin(deployments, eq(deployments.id, owners.deploymentId))
        .innerJoin(
          channelIdentities,
          eq(channelIdentities.id, approvals.approvedByIdentityId),
        )
        .where(
          and(
            eq(actionExecutions.id, payload.actionExecutionId),
            eq(actionExecutions.status, "pending"),
            eq(approvals.status, "consumed"),
            eq(approvals.executionTaskId, actionExecutions.executionTaskId),
            eq(approvals.ownerId, actionExecutions.ownerId),
            eq(approvals.spaceId, actionExecutions.spaceId),
            eq(approvals.actionHash, actionExecutions.actionHash),
            eq(executionTasks.state, "running"),
            eq(chains.state, "executing"),
            isNull(chains.canceledAt),
            eq(chains.spaceId, actionExecutions.spaceId),
            sql`${chains.version} = (select max(current_chain.version) from ${chains} current_chain where current_chain.space_id = ${chains.spaceId})`,
            eq(spaces.deploymentId, owners.deploymentId),
            eq(owners.status, "active"),
            eq(deployments.status, "active"),
            eq(channelIdentities.ownerId, actionExecutions.ownerId),
            eq(channelIdentities.role, "owner"),
            isNull(channelIdentities.revokedAt),
          ),
        )
        .for("update")
        .limit(1);
      if (row === undefined) {
        return null;
      }
      const [claimed] = await transaction
        .update(actionExecutions)
        .set({
          status: "running",
          attemptCount: sql`${actionExecutions.attemptCount} + 1`,
          claimedAt: now,
          lastErrorCode: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(actionExecutions.id, payload.actionExecutionId),
            eq(actionExecutions.status, "pending"),
          ),
        )
        .returning({ id: actionExecutions.id });
      if (claimed === undefined) {
        return null;
      }
      return {
        ...row,
        actionType: actionTypeSchema.parse(row.actionType),
      };
    });
  }

  public async findPendingActionExecutionIds(limit = 100): Promise<string[]> {
    const rows = await this.database
      .select({ id: actionExecutions.id })
      .from(actionExecutions)
      .where(eq(actionExecutions.status, "pending"))
      .orderBy(asc(actionExecutions.updatedAt), asc(actionExecutions.id))
      .limit(limit);
    return rows.map((row) => row.id);
  }

  public async completeActionExecution(
    actionExecutionId: string,
    result: ActionExecutorResult,
    now = new Date(),
  ): Promise<ApprovalChainProgression | null> {
    return this.database.transaction(async (transaction) => {
      const row = await this.lockRunning(transaction, actionExecutionId);
      if (row === null) {
        return null;
      }
      const safeResult = {
        safeSummary: result.safeSummary,
        safeMetadata: result.safeMetadata,
      };
      const completed = await transaction
        .update(actionExecutions)
        .set({
          status: "succeeded",
          safeResultJson: safeResult,
          providerReference: result.providerReference,
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(actionExecutions.id, actionExecutionId),
            eq(actionExecutions.status, "running"),
          ),
        )
        .returning({ id: actionExecutions.id });
      if (completed.length !== 1) {
        return null;
      }
      await this.finishTask(
        transaction,
        row.executionTaskId,
        "succeeded",
        result.safeSummary,
        null,
        now,
      );
      await this.failBlockedDependents(transaction, row.chainId, now);
      return this.progressionForChain(transaction, row.chainId, now);
    });
  }

  public async recordActionExecutionFailure(
    input: RecordActionExecutionFailureInput,
  ): Promise<ActionExecutionFailureOutcome> {
    const now = input.now ?? new Date();
    z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/u).parse(input.errorCode);
    z.string().trim().min(1).max(1_000).parse(input.safeMessage);
    return this.database.transaction(async (transaction) => {
      const row = await this.lockRunning(transaction, input.actionExecutionId);
      if (row === null) {
        return { retry: false, progression: null };
      }
      if (input.retryable) {
        const reset = await transaction
          .update(actionExecutions)
          .set({
            status: "pending",
            claimedAt: null,
            lastErrorCode: input.errorCode,
            safeResultJson: { safeSummary: input.safeMessage },
            updatedAt: now,
          })
          .where(
            and(
              eq(actionExecutions.id, input.actionExecutionId),
              eq(actionExecutions.status, "running"),
            ),
          )
          .returning({ id: actionExecutions.id });
        return { retry: reset.length === 1, progression: null };
      }

      const failed = await transaction
        .update(actionExecutions)
        .set({
          status: "failed",
          lastErrorCode: input.errorCode,
          safeResultJson: { safeSummary: input.safeMessage },
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(actionExecutions.id, input.actionExecutionId),
            eq(actionExecutions.status, "running"),
          ),
        )
        .returning({ id: actionExecutions.id });
      if (failed.length !== 1) {
        return { retry: false, progression: null };
      }
      await this.finishTask(
        transaction,
        row.executionTaskId,
        "failed",
        input.safeMessage,
        input.errorCode,
        now,
      );
      await this.failBlockedDependents(transaction, row.chainId, now);
      return {
        retry: false,
        progression: await this.progressionForChain(
          transaction,
          row.chainId,
          now,
        ),
      };
    });
  }

  /**
   * Re-derives downstream scheduling after a crash between terminal commit and
   * queue publication. Queue publishers must keep chain/task jobs idempotent.
   */
  public async loadCompletedProgression(
    actionExecutionId: string,
    now = new Date(),
  ): Promise<ApprovalChainProgression | null> {
    return this.database.transaction(async (transaction) => {
      const [row] = await transaction
        .select({ chainId: executionTasks.chainId })
        .from(actionExecutions)
        .innerJoin(
          executionTasks,
          eq(executionTasks.id, actionExecutions.executionTaskId),
        )
        .where(
          and(
            eq(actionExecutions.id, actionExecutionId),
            inArray(actionExecutions.status, ["succeeded", "failed"]),
            inArray(executionTasks.state, ["succeeded", "failed"]),
          ),
        )
        .limit(1);
      return row === undefined
        ? null
        : this.progressionForChain(transaction, row.chainId, now);
    });
  }

  public async requeueStaleRunning(
    staleBefore: Date,
    now = new Date(),
  ): Promise<readonly string[]> {
    const rows = await this.database
      .update(actionExecutions)
      .set({
        status: "pending",
        claimedAt: null,
        lastErrorCode: "ACTION_EXECUTION_LEASE_EXPIRED",
        updatedAt: now,
      })
      .where(
        and(
          eq(actionExecutions.status, "running"),
          lte(actionExecutions.claimedAt, staleBefore),
        ),
      )
      .returning({ id: actionExecutions.id });
    return rows.map((row) => row.id);
  }

  private async lockRunning(
    transaction: DatabaseTransaction,
    actionExecutionId: string,
  ): Promise<{
    executionTaskId: string;
    chainId: string;
  } | null> {
    const [row] = await transaction
      .select({
        executionTaskId: actionExecutions.executionTaskId,
        chainId: executionTasks.chainId,
      })
      .from(actionExecutions)
      .innerJoin(
        executionTasks,
        eq(executionTasks.id, actionExecutions.executionTaskId),
      )
      .where(
        and(
          eq(actionExecutions.id, actionExecutionId),
          eq(actionExecutions.status, "running"),
          eq(executionTasks.state, "running"),
        ),
      )
      .for("update")
      .limit(1);
    return row ?? null;
  }

  private async finishTask(
    transaction: DatabaseTransaction,
    executionTaskId: string,
    status: "succeeded" | "failed",
    safeSummary: string,
    errorCode: string | null,
    now: Date,
  ): Promise<void> {
    const [task] = await transaction
      .select({ logicalTaskId: executionTasks.name })
      .from(executionTasks)
      .where(eq(executionTasks.id, executionTaskId))
      .limit(1);
    if (task === undefined) {
      throw new Error("Action execution lost its durable execution task.");
    }
    const result: ExecutionResult = executionResultSchema.parse({
      taskId: task.logicalTaskId,
      status,
      userSafeSummary: safeSummary,
      artifacts: [],
      proposedActions: [],
      memoryCandidates: [],
      error:
        errorCode === null
          ? null
          : {
              code: errorCode,
              retryable: false,
              safeMessage: safeSummary,
            },
    });
    const updated = await transaction
      .update(executionTasks)
      .set({
        state: status,
        resultJson: {
          ciphertext: await this.options.encryptExecutionResult(
            JSON.stringify(result),
          ),
        },
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(executionTasks.id, executionTaskId),
          eq(executionTasks.state, "running"),
        ),
      )
      .returning({ id: executionTasks.id });
    if (updated.length !== 1) {
      throw new Error(
        "Action execution lost the task completion transition. The transaction was rolled back.",
      );
    }
  }

  private async failBlockedDependents(
    transaction: DatabaseTransaction,
    chainId: string,
    now: Date,
  ): Promise<void> {
    const tasks = await transaction
      .select({
        id: executionTasks.id,
        logicalTaskId: executionTasks.name,
        state: executionTasks.state,
        dependencies: executionTasks.dependsOnJson,
      })
      .from(executionTasks)
      .where(eq(executionTasks.chainId, chainId))
      .orderBy(asc(executionTasks.createdAt), asc(executionTasks.id));
    const states = new Map(tasks.map((task) => [task.id, task.state]));
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of tasks) {
        if (states.get(task.id) !== "queued") {
          continue;
        }
        if (
          dependencyIdsSchema.parse(task.dependencies).some((dependency) => {
            const state = states.get(dependency);
            return state === "failed" || state === "canceled";
          })
        ) {
          const safeSummary =
            "This task could not run because an action prerequisite failed.";
          const result = executionResultSchema.parse({
            taskId: task.logicalTaskId,
            status: "failed",
            userSafeSummary: safeSummary,
            artifacts: [],
            proposedActions: [],
            memoryCandidates: [],
            error: {
              code: "ACTION_PREREQUISITE_FAILED",
              retryable: false,
              safeMessage: safeSummary,
            },
          });
          await transaction
            .update(executionTasks)
            .set({
              state: "failed",
              resultJson: {
                ciphertext: await this.options.encryptExecutionResult(
                  JSON.stringify(result),
                ),
              },
              completedAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(executionTasks.id, task.id),
                eq(executionTasks.state, "queued"),
              ),
            );
          states.set(task.id, "failed");
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
    const awaitingApproval = [...states.values()].some(
      (state) => state === "needs_approval",
    );
    await transaction
      .update(chains)
      .set({
        state: awaitingApproval ? "awaiting_approval" : "executing",
        updatedAt: now,
      })
      .where(
        and(
          eq(chains.id, chainId),
          inArray(chains.state, ["executing", "awaiting_approval"]),
          isNull(chains.canceledAt),
        ),
      );
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
    return {
      chainId,
      expectedChainVersion: chain.version,
      newlyRunnableTasks,
      shouldSynthesize:
        tasks.length > 0 &&
        [...states.values()].every((state) =>
          terminalTaskStates.includes(
            state as (typeof terminalTaskStates)[number],
          ),
        ),
    };
  }
}
