import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import {
  executionResultSchema,
  executionTaskSchema,
  interactionDecisionSchema,
  type ExecutionResult,
} from "../../agent/schemas.js";
import { modelSelectionSchema } from "../../agent/model-selection.js";
import { permissionProfileNameSchema } from "../../security/permissions.js";
import type {
  ExecutionCapability,
  PersistedExecutionTaskInput,
  TurnPlanCommitBase,
  TurnPlanContext,
} from "../../queue/handlers/turn-plan.js";
import type {
  TaskAttemptFailureOutcome,
  TaskExecutionContext,
  TaskTerminalOutcome,
} from "../../queue/handlers/task-execute.js";
import type { TurnSynthesisContext } from "../../queue/handlers/turn-synthesize.js";
import type {
  TaskExecutePayload,
  TurnPlanPayload,
  TurnSynthesizePayload,
} from "../../queue/payloads.js";
import type { Database, DatabaseTransaction } from "../client.js";
import {
  agentThreads,
  carriedMessages,
  chains,
  channelIdentities,
  executionTasks,
  messages,
  outboundBatches,
  outboundParts,
  spaces,
} from "../schema.js";
import { stableClientGuid } from "./outbound.js";

const dependencyIdsSchema = z.array(z.uuid()).max(5);
const terminalTaskStates = [
  "succeeded",
  "failed",
  "canceled",
  "needs_approval",
] as const;

interface LoadedMessage {
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
  capabilities(input: {
    deploymentId: string;
    ownerId: string;
    spaceId: string;
  }): Promise<readonly ExecutionCapability[]> | readonly ExecutionCapability[];
  priorStatusMessages?(
    spaceId: string,
  ): Promise<TurnPlanContext["priorStatusMessages"]>;
  maximumTaskAttempts?: number;
}

type PlanFinalCommitInput = TurnPlanCommitBase & {
  encryptedParts: readonly string[];
};

interface SynthesisFinalCommitInput {
  payload: TurnSynthesizePayload;
  decision: unknown;
  terminalResults: readonly ExecutionResult[];
  promptVersion: string;
  promptSha256: string;
  encryptedParts: readonly string[];
}

function taskStateForResult(result: ExecutionResult) {
  return result.status;
}

function decisionForStorage(decision: ReturnType<typeof interactionDecisionSchema.parse>) {
  return {
    mode: decision.mode,
    hasUserMessage: decision.userMessage !== null,
    hasStatusMessage: decision.statusMessage !== null,
    waitForTasks: decision.waitForTasks,
    memoryCandidateCount: decision.memoryCandidates.length,
    tasks: decision.tasks.map((task) => ({
      id: task.id,
      agentName: task.agentName,
      workspaceBinding: task.workspaceBinding ?? task.agentName,
      permissionProfile: task.permissionProfile,
      dependsOn: task.dependsOn,
    })),
  };
}

function safeDependencyFailure(taskId: string): ExecutionResult {
  return executionResultSchema.parse({
    taskId,
    status: "failed",
    userSafeSummary:
      "This task could not run because a required earlier task did not complete successfully.",
    artifacts: [],
    proposedActions: [],
    memoryCandidates: [],
    error: {
      code: "DEPENDENCY_NOT_SUCCEEDED",
      retryable: false,
      safeMessage: "Resolve or retry the failed prerequisite before retrying this task.",
    },
  });
}

function safeAttemptsExhausted(taskId: string): ExecutionResult {
  return executionResultSchema.parse({
    taskId,
    status: "failed",
    userSafeSummary: "This task stopped after its bounded retry attempts were exhausted.",
    artifacts: [],
    proposedActions: [],
    memoryCandidates: [],
    error: {
      code: "TASK_ATTEMPTS_EXHAUSTED",
      retryable: false,
      safeMessage: "Narrow the task or resolve the runtime failure before retrying it in a new turn.",
    },
  });
}

export class OrchestrationRepository {
  private readonly maximumTaskAttempts: number;

  public constructor(
    private readonly database: Database,
    private readonly options: OrchestrationRepositoryOptions,
  ) {
    this.maximumTaskAttempts = options.maximumTaskAttempts ?? 3;
  }

  public async loadPlanContext(
    payload: TurnPlanPayload,
  ): Promise<TurnPlanContext | null> {
    const [envelope] = await this.database
      .select({
        chainId: chains.id,
        chainVersion: chains.version,
        state: chains.state,
        canceledAt: chains.canceledAt,
        spaceId: spaces.id,
        deploymentId: spaces.deploymentId,
        modelId: chains.modelId,
        reasoningEffort: chains.reasoningEffort,
        recoverySummary: spaces.interactionSummary,
      })
      .from(chains)
      .innerJoin(spaces, eq(spaces.id, chains.spaceId))
      .where(
        and(
          eq(chains.id, payload.chainId),
          eq(chains.version, payload.expectedChainVersion),
          eq(chains.state, payload.expectedState),
          isNull(chains.canceledAt),
          sql`${chains.version} = (select max(current_chain.version) from ${chains} current_chain where current_chain.space_id = ${chains.spaceId})`,
        ),
      )
      .limit(1);
    if (envelope === undefined) {
      return null;
    }

    const chainMessages = await this.loadChainMessages(
      this.database,
      envelope.chainId,
    );
    if (chainMessages.length === 0) {
      throw new Error(
        "The current chain has no drained or carried messages. Reconcile inbound persistence before retrying planning.",
      );
    }
    const ownerIds = new Set(
      chainMessages
        .map((message) => message.ownerId)
        .filter((ownerId): ownerId is string => ownerId !== null),
    );
    if (ownerIds.size !== 1) {
      throw new Error(
        "Planning requires exactly one authorized owner across the drained turn. Repair sender ownership before retrying.",
      );
    }
    const ownerId = [...ownerIds][0];
    if (ownerId === undefined) {
      throw new Error("The drained turn did not resolve an authorized owner.");
    }

    const plaintext = await Promise.all(
      chainMessages.map(async (message) => ({
        ...message,
        text:
          message.contentCiphertext === null
            ? ""
            : await this.options.decrypt(message.contentCiphertext),
      })),
    );
    const sendable = plaintext.filter((message) => message.text.trim().length > 0);
    const newestDirect = [...sendable]
      .reverse()
      .find((message) => !message.carried);
    const newest = newestDirect ?? sendable.at(-1);
    if (newest === undefined) {
      throw new Error(
        "The current chain contains no decryptable text. Restore the retained message content before retrying.",
      );
    }

    const historyRows = await this.database
      .select({ contentCiphertext: messages.contentCiphertext })
      .from(messages)
      .where(eq(messages.spaceId, envelope.spaceId))
      .orderBy(desc(messages.receivedAt), desc(messages.id))
      .limit(20);
    const conversationHistory = (
      await Promise.all(
        historyRows.reverse().map(async (row) =>
          row.contentCiphertext === null
            ? ""
            : await this.options.decrypt(row.contentCiphertext),
        ),
      )
    ).filter((text) => text.trim().length > 0);

    const activeAgentRows = await this.database
      .select({
        name: agentThreads.agentName,
        status: agentThreads.status,
        summary: agentThreads.summary,
      })
      .from(agentThreads)
      .where(eq(agentThreads.ownerId, ownerId))
      .orderBy(desc(agentThreads.lastUsedAt))
      .limit(20);
    const activeAgents = await Promise.all(
      activeAgentRows.map(async (agent) => ({
        name: agent.name,
        status: agent.status === "active" ? ("active" as const) : agent.status,
        ...(agent.summary === null
          ? {}
          : { summary: await this.options.decrypt(agent.summary) }),
      })),
    );
    const modelSelection = modelSelectionSchema.parse({
      modelId: envelope.modelId,
      reasoningEffort: envelope.reasoningEffort,
    });
    const combinedTurnText = sendable
      .map((message) =>
        message.carried ? `[Earlier message] ${message.text}` : message.text,
      )
      .join("\n");
    const identity = {
      deploymentId: envelope.deploymentId,
      ownerId,
      spaceId: envelope.spaceId,
    };

    return {
      ...identity,
      chainId: envelope.chainId,
      chainVersion: envelope.chainVersion,
      currentUserMessage: newest.text,
      combinedTurnText,
      conversationHistory,
      activeAgents,
      capabilities: await this.options.capabilities(identity),
      priorStatusMessages:
        (await this.options.priorStatusMessages?.(envelope.spaceId)) ?? [],
      modelSelection,
      interactionWorkingDirectory: this.options.interactionWorkingDirectory,
      ...(envelope.recoverySummary === null
        ? {}
        : {
            recoverySummary: await this.options.decrypt(
              envelope.recoverySummary,
            ),
          }),
    };
  }

  public async commitFinal(
    input: PlanFinalCommitInput | SynthesisFinalCommitInput,
  ): Promise<{ outboundBatchId: string }> {
    const decision = interactionDecisionSchema.parse(input.decision);
    if (input.encryptedParts.length === 0) {
      throw new Error("A final response must contain at least one encrypted bubble.");
    }

    return this.database.transaction(async (transaction) => {
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
      await transaction
        .update(chains)
        .set({
          state: "sending",
          decisionJson: decisionForStorage(decision),
          promptVersion: input.promptVersion,
          terminalErrorCode: null,
          updatedAt: new Date(),
        })
        .where(eq(chains.id, chain.id));
      return { outboundBatchId: batchId };
    });
  }

  public async commitDelegation(
    input: TurnPlanCommitBase & {
      tasks: readonly PersistedExecutionTaskInput[];
      rootLogicalTaskIds: readonly string[];
    },
  ): Promise<{ rootTasks: readonly { taskId: string }[] }> {
    const decision = interactionDecisionSchema.parse(input.decision);
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select id from ${chains} where ${chains.id} = ${input.payload.chainId} for update`,
      );
      const existing = await transaction
        .select({
          id: executionTasks.id,
          dependencies: executionTasks.dependsOnJson,
        })
        .from(executionTasks)
        .where(eq(executionTasks.chainId, input.payload.chainId));
      if (existing.length > 0) {
        return {
          rootTasks: existing
            .filter((task) => task.dependencies.length === 0)
            .map((task) => ({ taskId: task.id })),
        };
      }

      const [chain] = await transaction
        .select({ state: chains.state, version: chains.version, canceledAt: chains.canceledAt })
        .from(chains)
        .where(eq(chains.id, input.payload.chainId))
        .limit(1);
      if (
        chain === undefined ||
        chain.state !== input.payload.expectedState ||
        chain.version !== input.payload.expectedChainVersion ||
        chain.canceledAt !== null
      ) {
        throw new Error(
          "Delegation commit rejected because the chain is stale, canceled, or no longer queued.",
        );
      }

      const ownerId = await this.ownerIdForChain(transaction, input.payload.chainId);
      const taskIds = new Map(
        input.tasks.map(({ task }) => [task.id, randomUUID()]),
      );
      for (const persisted of input.tasks) {
        const task = executionTaskSchema.parse(persisted.task);
        const workspaceBinding = task.workspaceBinding ?? task.agentName;
        const [thread] = await transaction
          .insert(agentThreads)
          .values({
            id: randomUUID(),
            ownerId,
            agentName: task.agentName,
            workspaceBinding,
            lastModelProfile: "main",
            status: "active",
            lastUsedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [
              agentThreads.ownerId,
              agentThreads.agentName,
              agentThreads.workspaceBinding,
            ],
            set: {
              lastModelProfile: "main",
              lastUsedAt: new Date(),
              updatedAt: new Date(),
            },
          })
          .returning({ id: agentThreads.id, status: agentThreads.status });
        if (thread === undefined || thread.status === "disabled") {
          throw new Error(
            `Named execution context ${task.agentName} is disabled or unavailable. Choose another configured context.`,
          );
        }
        const databaseTaskId = taskIds.get(task.id);
        if (databaseTaskId === undefined) {
          throw new Error("The task identifier map is incomplete.");
        }
        await transaction.insert(executionTasks).values({
          id: databaseTaskId,
          chainId: input.payload.chainId,
          agentThreadId: thread.id,
          name: task.id,
          purpose: await this.options.encrypt(task.purpose),
          instructionsCiphertext: persisted.instructionsCiphertext,
          modelProfile: "main",
          permissionProfile: task.permissionProfile,
          state: "queued",
          dependsOnJson: task.dependsOn.map((dependency) => {
            const dependencyId = taskIds.get(dependency);
            if (dependencyId === undefined) {
              throw new Error(`Unknown persisted task dependency: ${dependency}`);
            }
            return dependencyId;
          }),
        });
      }

      await transaction
        .update(chains)
        .set({
          state: "executing",
          promptVersion: input.promptVersion,
          decisionJson: decisionForStorage(decision),
          updatedAt: new Date(),
        })
        .where(eq(chains.id, input.payload.chainId));

      return {
        rootTasks: input.rootLogicalTaskIds.map((logicalId) => {
          const taskId = taskIds.get(logicalId);
          if (taskId === undefined) {
            throw new Error(`Unknown root task identifier: ${logicalId}`);
          }
          return { taskId };
        }),
      };
    });
  }

  public async commitSilent(input: TurnPlanCommitBase): Promise<void> {
    const decision = interactionDecisionSchema.parse(input.decision);
    const updated = await this.database
      .update(chains)
      .set({
        state: "complete",
        promptVersion: input.promptVersion,
        decisionJson: decisionForStorage(decision),
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(chains.id, input.payload.chainId),
          eq(chains.version, input.payload.expectedChainVersion),
          eq(chains.state, input.payload.expectedState),
          isNull(chains.canceledAt),
        ),
      )
      .returning({ id: chains.id });
    if (updated.length !== 1) {
      throw new Error(
        "Silent completion rejected because the chain is stale, canceled, or no longer queued.",
      );
    }
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
        .innerJoin(agentThreads, eq(agentThreads.id, executionTasks.agentThreadId))
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
      const currentCapabilities = await this.options.capabilities({
        deploymentId: row.deploymentId,
        ownerId: row.ownerId,
        spaceId: row.spaceId,
      });
      const currentCapability = currentCapabilities.find(
        (candidate) => candidate.workspaceBinding === row.workspaceBinding,
      );
      if (
        currentCapability === undefined ||
        !currentCapability.permissionProfiles.includes(task.permissionProfile)
      ) {
        throw new Error(
          "The queued task no longer has a code-authorized workspace permission. Cancel it and create a newly authorized task.",
        );
      }

      return {
        ownerId: row.ownerId,
        task,
        modelSelection: modelSelectionSchema.parse({
          modelId: row.modelId,
          reasoningEffort: row.reasoningEffort,
        }),
        maximumPermissionProfile: task.permissionProfile,
        workspaceRoot: this.options.workspaceRoot,
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

  public async completeTask(input: {
    payload: TaskExecutePayload;
    result: ExecutionResult;
    threadId?: string;
    promptSha256: string;
    recovered: boolean;
  }): Promise<TaskTerminalOutcome> {
    const result = executionResultSchema.parse(input.result);
    const storedResult = await this.resultForStorage(result);
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select id from ${executionTasks} where ${executionTasks.id} = ${input.payload.taskId} for update`,
      );
      const [row] = await transaction
        .select({
          logicalId: executionTasks.name,
          state: executionTasks.state,
          agentThreadId: executionTasks.agentThreadId,
          chainState: chains.state,
          chainVersion: chains.version,
          canceledAt: chains.canceledAt,
        })
        .from(executionTasks)
        .innerJoin(chains, eq(chains.id, executionTasks.chainId))
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
      return await this.releaseDependents(
        transaction,
        input.payload.chainId,
      );
    });
  }

  public async failTaskAttempt(input: {
    payload: TaskExecutePayload;
    result: ExecutionResult;
  }): Promise<TaskAttemptFailureOutcome> {
    const result = executionResultSchema.parse(input.result);
    const storedResult = await this.resultForStorage(result);
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

  public async loadSynthesisContext(
    payload: TurnSynthesizePayload,
  ): Promise<TurnSynthesisContext | null> {
    const [chain] = await this.database
      .select({
        chainId: chains.id,
        chainVersion: chains.version,
        state: chains.state,
        canceledAt: chains.canceledAt,
        modelId: chains.modelId,
        reasoningEffort: chains.reasoningEffort,
        spaceId: spaces.id,
        deploymentId: spaces.deploymentId,
        recoverySummary: spaces.interactionSummary,
      })
      .from(chains)
      .innerJoin(spaces, eq(spaces.id, chains.spaceId))
      .where(
        and(
          eq(chains.id, payload.chainId),
          eq(chains.version, payload.expectedChainVersion),
          eq(chains.state, payload.expectedState),
          isNull(chains.canceledAt),
          sql`${chains.version} = (select max(current_chain.version) from ${chains} current_chain where current_chain.space_id = ${chains.spaceId})`,
        ),
      )
      .limit(1);
    if (chain === undefined) {
      return null;
    }
    const tasks = await this.database
      .select({
        state: executionTasks.state,
        result: executionTasks.resultJson,
        ownerId: agentThreads.ownerId,
      })
      .from(executionTasks)
      .innerJoin(agentThreads, eq(agentThreads.id, executionTasks.agentThreadId))
      .where(eq(executionTasks.chainId, chain.chainId))
      .orderBy(asc(executionTasks.createdAt), asc(executionTasks.id));
    if (
      tasks.length === 0 ||
      tasks.some(
        (task) =>
          !terminalTaskStates.includes(
            task.state as (typeof terminalTaskStates)[number],
          ),
      )
    ) {
      return null;
    }
    const ownerIds = new Set(tasks.map((task) => task.ownerId));
    if (ownerIds.size !== 1) {
      throw new Error("Synthesis tasks do not resolve to one authorized owner.");
    }
    const ownerId = [...ownerIds][0];
    if (ownerId === undefined) {
      throw new Error("Synthesis could not resolve an authorized owner.");
    }
    const terminalResults = await Promise.all(
      tasks.map(async (task) => {
        const ciphertext = z
          .object({ ciphertext: z.string().min(1) })
          .strict()
          .parse(task.result).ciphertext;
        return executionResultSchema.parse(
          JSON.parse(await this.options.decrypt(ciphertext)) as unknown,
        );
      }),
    );
    const chainMessages = await this.loadChainMessages(
      this.database,
      chain.chainId,
    );
    const userRequest = (
      await Promise.all(
        chainMessages.map(async (message) =>
          message.contentCiphertext === null
            ? ""
            : await this.options.decrypt(message.contentCiphertext),
        ),
      )
    )
      .filter((text) => text.trim().length > 0)
      .join("\n");

    return {
      deploymentId: chain.deploymentId,
      ownerId,
      spaceId: chain.spaceId,
      chainId: chain.chainId,
      chainVersion: chain.chainVersion,
      userRequest,
      conversationHistory: [],
      terminalResults,
      modelSelection: modelSelectionSchema.parse({
        modelId: chain.modelId,
        reasoningEffort: chain.reasoningEffort,
      }),
      interactionWorkingDirectory: this.options.interactionWorkingDirectory,
      ...(chain.recoverySummary === null
        ? {}
        : {
            recoverySummary: await this.options.decrypt(
              chain.recoverySummary,
            ),
          }),
    };
  }

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
          rows.flatMap((row) => dependencyIdsSchema.parse(row.dependencies)),
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
              resultJson: await this.resultForStorage(
                safeAttemptsExhausted(task.logicalId),
              ),
              completedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(executionTasks.id, task.taskId));
          await this.releaseDependents(transaction, task.chainId);
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

  private async loadChainMessages(
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

  private async ownerIdForChain(
    transaction: DatabaseTransaction,
    chainId: string,
  ): Promise<string> {
    const rows = await this.loadChainMessages(transaction, chainId);
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

  private async releaseDependents(
    transaction: DatabaseTransaction,
    chainId: string,
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
          const result = safeDependencyFailure(task.logicalId);
          await transaction
            .update(executionTasks)
            .set({
              state: "failed",
              resultJson: await this.resultForStorage(result),
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
      terminalTaskStates.includes(state as (typeof terminalTaskStates)[number]),
    );
    return { accepted: true, readyTasks, shouldSynthesize };
  }

  private async resultForStorage(
    result: ExecutionResult,
  ): Promise<Record<string, unknown>> {
    return {
      ciphertext: await this.options.encrypt(JSON.stringify(result)),
    };
  }
}
