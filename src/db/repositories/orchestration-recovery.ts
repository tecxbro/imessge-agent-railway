import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import type {
  TaskExecutePayload,
  TurnSynthesizePayload,
} from "../../queue/payloads.js";
import type { Database } from "../client.js";
import { chains, executionTasks } from "../schema.js";
import { OrchestrationCodec } from "./orchestration-codec.js";
import {
  dependencyIdsSchema,
  releaseDependents,
  terminalTaskStates,
} from "./orchestration-shared.js";

export class OrchestrationRecoveryRepository {
  public constructor(
    private readonly database: Database,
    private readonly maximumTaskAttempts: number,
    private readonly codec: OrchestrationCodec,
  ) {}

  public async findRunnableTaskPayloads(
    limit = 100,
  ): Promise<TaskExecutePayload[]> {
    const rows = await this.database
      .select({
        taskId: executionTasks.id,
        chainId: executionTasks.chainId,
        version: chains.version,
        dependencies: executionTasks.dependsOnJson,
      })
      .from(executionTasks)
      .innerJoin(chains, eq(chains.id, executionTasks.chainId))
      .where(
        and(
          eq(executionTasks.state, "queued"),
          eq(chains.state, "executing"),
          isNull(chains.canceledAt),
        ),
      )
      .orderBy(asc(executionTasks.createdAt))
      .limit(limit);
    const taskStates = await this.database
      .select({ id: executionTasks.id, state: executionTasks.state })
      .from(executionTasks)
      .where(
        inArray(
          executionTasks.id,
          rows.flatMap((row) =>
            dependencyIdsSchema.parse(row.dependencies),
          ),
        ),
      );
    const states = new Map(taskStates.map((task) => [task.id, task.state]));
    return rows
      .filter((row) =>
        dependencyIdsSchema
          .parse(row.dependencies)
          .every((dependency) => states.get(dependency) === "succeeded"),
      )
      .map((row) => ({
        taskId: row.taskId,
        chainId: row.chainId,
        expectedChainVersion: row.version,
        expectedState: "queued",
      }));
  }

  public async denyChainCodexStart(input: {
    chainId: string;
    expectedChainVersion: number;
    expectedState: "queued" | "executing";
    errorCode: string;
  }): Promise<boolean> {
    const now = new Date();
    const failed = await this.database
      .update(chains)
      .set({
        state: "failed",
        terminalErrorCode: input.errorCode,
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(chains.id, input.chainId),
          eq(chains.version, input.expectedChainVersion),
          eq(chains.state, input.expectedState),
          isNull(chains.canceledAt),
        ),
      )
      .returning({ id: chains.id });
    return failed.length === 1;
  }

  public async requeueStaleRunningTasks(
    staleBefore: Date,
    limit = 100,
  ): Promise<number> {
    const stale = await this.database
      .select({
        taskId: executionTasks.id,
        logicalId: executionTasks.name,
        chainId: executionTasks.chainId,
      })
      .from(executionTasks)
      .innerJoin(chains, eq(chains.id, executionTasks.chainId))
      .where(
        and(
          eq(executionTasks.state, "running"),
          eq(chains.state, "executing"),
          isNull(chains.canceledAt),
          sql`${executionTasks.startedAt} < ${staleBefore}`,
        ),
      )
      .orderBy(asc(executionTasks.startedAt))
      .limit(limit);
    let recovered = 0;
    for (const task of stale) {
      await this.database.transaction(async (transaction) => {
        await transaction.execute(
          sql`select id from ${executionTasks} where ${executionTasks.id} = ${task.taskId} for update`,
        );
        const [current] = await transaction
          .select({
            state: executionTasks.state,
            startedAt: executionTasks.startedAt,
            attemptCount: executionTasks.attemptCount,
          })
          .from(executionTasks)
          .where(eq(executionTasks.id, task.taskId))
          .limit(1);
        if (
          current?.state !== "running" ||
          current.startedAt === null ||
          current.startedAt >= staleBefore
        ) {
          return;
        }
        if (current.attemptCount >= this.maximumTaskAttempts) {
          await transaction
            .update(executionTasks)
            .set({
              state: "failed",
              resultJson: await this.codec.resultForStorage(
                this.codec.safeAttemptsExhausted(task.logicalId),
              ),
              completedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(executionTasks.id, task.taskId));
          await releaseDependents(
            transaction,
            task.chainId,
            this.codec,
          );
        } else {
          await transaction
            .update(executionTasks)
            .set({ state: "queued", startedAt: null, updatedAt: new Date() })
            .where(eq(executionTasks.id, task.taskId));
        }
        recovered += 1;
      });
    }
    return recovered;
  }

  public async findSynthesisPayloads(
    limit = 100,
  ): Promise<TurnSynthesizePayload[]> {
    const active = await this.database
      .select({ chainId: chains.id, version: chains.version })
      .from(chains)
      .where(and(eq(chains.state, "executing"), isNull(chains.canceledAt)))
      .orderBy(asc(chains.createdAt))
      .limit(limit);
    const payloads: TurnSynthesizePayload[] = [];
    for (const chain of active) {
      const tasks = await this.database
        .select({ state: executionTasks.state })
        .from(executionTasks)
        .where(eq(executionTasks.chainId, chain.chainId));
      if (
        tasks.length > 0 &&
        tasks.every((task) =>
          terminalTaskStates.includes(
            task.state as (typeof terminalTaskStates)[number],
          ),
        )
      ) {
        payloads.push({
          chainId: chain.chainId,
          expectedChainVersion: chain.version,
          expectedState: "executing",
        });
      }
    }
    return payloads;
  }
}
