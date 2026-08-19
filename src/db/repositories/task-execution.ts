import { and, eq, inArray, sql } from "drizzle-orm";

import { modelSelectionSchema } from "../../agent/model-selection.js";
import {
  executionResultSchema,
  executionTaskSchema,
} from "../../agent/schemas.js";
import type {
  CompleteTaskInput,
  FailTaskAttemptInput,
  TaskAttemptFailureOutcome,
  TaskExecutionContext,
  TaskExecutionRepositoryContract,
  TaskTerminalOutcome,
} from "../../orchestration/contracts/task-execution.js";
import type { TaskExecutePayload } from "../../queue/payloads.js";
import { permissionProfileNameSchema } from "../../security/permissions.js";
import { CodexStartDeniedError } from "../../security/queued-authorization.js";
import type { Database } from "../client.js";
import {
  agentThreads,
  chains,
  executionTasks,
  spaces,
} from "../schema.js";
import { OrchestrationCodec, taskStateForResult } from "./orchestration-codec.js";
import {
  dependencyIdsSchema,
  releaseDependents,
  type OrchestrationRepositoryOptions,
} from "./orchestration-shared.js";

export class TaskExecutionRepository
  implements TaskExecutionRepositoryContract
{
  private readonly maximumTaskAttempts: number;

  public constructor(
    private readonly database: Database,
    private readonly options: OrchestrationRepositoryOptions,
    private readonly codec: OrchestrationCodec,
  ) {
    this.maximumTaskAttempts = options.maximumTaskAttempts ?? 3;
  }

  public async claimTask(
    payload: TaskExecutePayload,
  ): Promise<TaskExecutionContext | null> {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select id from ${executionTasks} where ${executionTasks.id} = ${payload.taskId} for update`,
      );
      const [row] = await transaction
        .select({
          id: executionTasks.id,
          logicalId: executionTasks.name,
          purpose: executionTasks.purpose,
          instructionsCiphertext: executionTasks.instructionsCiphertext,
          modelId: chains.modelId,
          reasoningEffort: chains.reasoningEffort,
          permissionProfile: executionTasks.permissionProfile,
          dependencies: executionTasks.dependsOnJson,
          taskState: executionTasks.state,
          agentName: agentThreads.agentName,
          workspaceBinding: agentThreads.workspaceBinding,
          agentSummary: agentThreads.summary,
          ownerId: agentThreads.ownerId,
          chainState: chains.state,
          chainVersion: chains.version,
          canceledAt: chains.canceledAt,
          deploymentId: spaces.deploymentId,
          spaceId: spaces.id,
        })
        .from(executionTasks)
        .innerJoin(chains, eq(chains.id, executionTasks.chainId))
        .innerJoin(spaces, eq(spaces.id, chains.spaceId))
        .innerJoin(
          agentThreads,
          eq(agentThreads.id, executionTasks.agentThreadId),
        )
        .where(
          and(
            eq(executionTasks.id, payload.taskId),
            eq(executionTasks.chainId, payload.chainId),
          ),
        )
        .limit(1);
      if (
        row === undefined ||
        row.taskState !== payload.expectedState ||
        row.chainState !== "executing" ||
        row.chainVersion !== payload.expectedChainVersion ||
        row.canceledAt !== null
      ) {
        return null;
      }

      const dependencyIds = dependencyIdsSchema.parse(row.dependencies);
      const dependencies =
        dependencyIds.length === 0
          ? []
          : await transaction
              .select({
                id: executionTasks.id,
                logicalId: executionTasks.name,
                state: executionTasks.state,
              })
              .from(executionTasks)
              .where(inArray(executionTasks.id, dependencyIds));
      if (
        dependencies.length !== dependencyIds.length ||
        dependencies.some((dependency) => dependency.state !== "succeeded")
      ) {
        return null;
      }
      if (row.instructionsCiphertext === null) {
        throw new Error(
          "The queued task has no encrypted instructions. Repair the task row before retrying.",
        );
      }

      await transaction
        .update(executionTasks)
        .set({
          state: "running",
          startedAt: new Date(),
          attemptCount: sql`${executionTasks.attemptCount} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(executionTasks.id, row.id));

      const task = executionTaskSchema.parse({
        id: row.logicalId,
        agentName: row.agentName,
        purpose: await this.options.decrypt(row.purpose),
        instructions: await this.options.decrypt(row.instructionsCiphertext),
        workspaceBinding: row.workspaceBinding,
        permissionProfile: permissionProfileNameSchema.parse(
          row.permissionProfile,
        ),
        dependsOn: dependencies.map((dependency) => dependency.logicalId),
      });
      const identity = {
        deploymentId: row.deploymentId,
        ownerId: row.ownerId,
        spaceId: row.spaceId,
        chainId: payload.chainId,
      };
      const authorizationReference =
        await this.options.authorizationReferences?.load(payload.chainId);
      if (
        this.options.authorizationReferences !== undefined &&
        (authorizationReference === undefined ||
          authorizationReference.deploymentId !== row.deploymentId ||
          authorizationReference.ownerId !== row.ownerId)
      ) {
        throw new CodexStartDeniedError("CODEX_START_AUTHORIZATION_INVALID");
      }
      const authorized =
        authorizationReference !== undefined &&
        this.options.authorizeCapability !== undefined
          ? await this.options.authorizeCapability({
              identity,
              authorizationReference,
              workspaceBinding: row.workspaceBinding,
              permissionProfile: task.permissionProfile,
            })
          : undefined;
      const currentCapabilities =
        authorized === undefined
          ? await this.options.capabilities(identity)
          : [];
      const currentCapability = currentCapabilities.find(
        (candidate) => candidate.workspaceBinding === row.workspaceBinding,
      );
      if (
        authorized === undefined &&
        (currentCapability === undefined ||
          !currentCapability.permissionProfiles.includes(task.permissionProfile))
      ) {
        throw new Error(
          "The queued task no longer has a code-authorized workspace permission. Cancel it and create a newly authorized task.",
        );
      }

      return {
        chainId: payload.chainId,
        ownerId: row.ownerId,
        ...(authorizationReference === undefined
          ? {}
          : { authorizationReference }),
        task,
        modelSelection: modelSelectionSchema.parse({
          modelId: row.modelId,
          reasoningEffort: row.reasoningEffort,
        }),
        authorizedPermissionProfiles:
          authorized?.allowedPermissionProfiles ?? [task.permissionProfile],
        resolvedWorkspacePath:
          authorized?.resolvedWorkspacePath ??
          `${this.options.workspaceRoot}/${row.workspaceBinding}`,
        relevantContext:
          row.agentSummary === null
            ? []
            : [await this.options.decrypt(row.agentSummary)],
        ...(row.agentSummary === null
          ? {}
          : { recoverySummary: await this.options.decrypt(row.agentSummary) }),
      };
    });
  }

  public async denyTaskCodexStart(input: {
    payload: TaskExecutePayload;
    errorCode: string;
  }): Promise<TaskTerminalOutcome> {
    return await this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select id from ${executionTasks} where ${executionTasks.id} = ${input.payload.taskId} for update`,
      );
      const [row] = await transaction
        .select({
          logicalId: executionTasks.name,
          state: executionTasks.state,
          chainState: chains.state,
          chainVersion: chains.version,
          canceledAt: chains.canceledAt,
        })
        .from(executionTasks)
        .innerJoin(chains, eq(chains.id, executionTasks.chainId))
        .where(
          and(
            eq(executionTasks.id, input.payload.taskId),
            eq(executionTasks.chainId, input.payload.chainId),
          ),
        )
        .limit(1);
      if (
        row === undefined ||
        row.state !== "queued" ||
        row.chainState !== "executing" ||
        row.chainVersion !== input.payload.expectedChainVersion ||
        row.canceledAt !== null
      ) {
        return { accepted: false, readyTasks: [], shouldSynthesize: false };
      }
      const result = executionResultSchema.parse({
        taskId: row.logicalId,
        status: "failed",
        userSafeSummary:
          "This task was denied because its queued authorization is no longer valid.",
        artifacts: [],
        proposedActions: [],
        memoryCandidates: [],
        error: {
          code: input.errorCode,
          retryable: false,
          safeMessage:
            "The queued authorization or capability grant is no longer valid.",
        },
      });
      await transaction
        .update(executionTasks)
        .set({
          state: "failed",
          resultJson: await this.codec.resultForStorage(result),
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(executionTasks.id, input.payload.taskId));
      return await releaseDependents(
        transaction,
        input.payload.chainId,
        this.codec,
      );
    });
  }

  public async completeTask(
    input: CompleteTaskInput,
  ): Promise<TaskTerminalOutcome> {
    const result = executionResultSchema.parse(input.result);
    const storedResult = await this.codec.resultForStorage(result);
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select id from ${executionTasks} where ${executionTasks.id} = ${input.payload.taskId} for update`,
      );
      const [row] = await transaction
        .select({
          logicalId: executionTasks.name,
          state: executionTasks.state,
          agentThreadId: executionTasks.agentThreadId,
          ownerId: agentThreads.ownerId,
          spaceId: chains.spaceId,
          chainState: chains.state,
          chainVersion: chains.version,
          canceledAt: chains.canceledAt,
        })
        .from(executionTasks)
        .innerJoin(chains, eq(chains.id, executionTasks.chainId))
        .innerJoin(
          agentThreads,
          eq(agentThreads.id, executionTasks.agentThreadId),
        )
        .where(eq(executionTasks.id, input.payload.taskId))
        .limit(1);
      if (
        row === undefined ||
        row.state !== "running" ||
        row.chainState !== "executing" ||
        row.chainVersion !== input.payload.expectedChainVersion ||
        row.canceledAt !== null
      ) {
        return { accepted: false, readyTasks: [], shouldSynthesize: false };
      }
      if (result.taskId !== row.logicalId) {
        throw new Error(
          "The execution result logical task ID does not match the claimed database task.",
        );
      }

      if (this.options.memoryCuration !== undefined) {
        await this.options.memoryCuration.recordCandidatesInTransaction(
          transaction,
          {
            chainId: input.payload.chainId,
            ownerId: row.ownerId,
            spaceId: row.spaceId,
            sourceStage: "task",
            sourceTaskId: input.payload.taskId,
            candidates: result.memoryCandidates,
          },
        );
      }

      await transaction
        .update(executionTasks)
        .set({
          state: taskStateForResult(result),
          resultJson: storedResult,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(executionTasks.id, input.payload.taskId));
      if (row.agentThreadId !== null) {
        await transaction
          .update(agentThreads)
          .set({
            ...(input.threadId === undefined
              ? {}
              : { codexThreadId: input.threadId }),
            summary: await this.options.encrypt(result.userSafeSummary),
            lastModelProfile: "main",
            lastUsedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(agentThreads.id, row.agentThreadId));
      }
      return await releaseDependents(
        transaction,
        input.payload.chainId,
        this.codec,
      );
    });
  }

  public async failTaskAttempt(
    input: FailTaskAttemptInput,
  ): Promise<TaskAttemptFailureOutcome> {
    const result = executionResultSchema.parse(input.result);
    const storedResult = await this.codec.resultForStorage(result);
    const [task] = await this.database
      .select({ attemptCount: executionTasks.attemptCount })
      .from(executionTasks)
      .where(eq(executionTasks.id, input.payload.taskId))
      .limit(1);
    if (
      result.error?.retryable === true &&
      task !== undefined &&
      task.attemptCount < this.maximumTaskAttempts
    ) {
      const reset = await this.database
        .update(executionTasks)
        .set({
          state: "queued",
          resultJson: storedResult,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(executionTasks.id, input.payload.taskId),
            eq(executionTasks.state, "running"),
          ),
        )
        .returning({ id: executionTasks.id });
      return {
        accepted: reset.length === 1,
        readyTasks: [],
        shouldSynthesize: false,
        retry: reset.length === 1,
      };
    }

    const terminal = await this.completeTask({
      payload: input.payload,
      result,
      promptSha256: "runtime-failure",
      recovered: false,
    });
    return { ...terminal, retry: false };
  }
}
