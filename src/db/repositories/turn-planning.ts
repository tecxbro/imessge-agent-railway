import { randomUUID } from "node:crypto";

import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { modelSelectionSchema } from "../../agent/model-selection.js";
import {
  executionTaskSchema,
  interactionDecisionSchema,
} from "../../agent/schemas.js";
import type {
  PersistedExecutionTaskInput,
  PlanFinalCommitInput,
  TurnPlanCommitBase,
  TurnPlanContext,
  TurnPlanRepositoryContract,
} from "../../orchestration/contracts/turn-plan.js";
import type { TurnPlanPayload } from "../../queue/payloads.js";
import { CodexStartDeniedError } from "../../security/queued-authorization.js";
import type { Database } from "../client.js";
import {
  agentThreads,
  chains,
  executionTasks,
  messages,
  spaces,
} from "../schema.js";
import { OrchestrationCodec } from "./orchestration-codec.js";
import {
  commitFinalResponse,
  loadChainMessages,
  ownerIdForChain,
  type OrchestrationRepositoryOptions,
} from "./orchestration-shared.js";

export class TurnPlanningRepository
  implements TurnPlanRepositoryContract
{
  public constructor(
    private readonly database: Database,
    private readonly options: OrchestrationRepositoryOptions,
    private readonly codec: OrchestrationCodec,
  ) {}

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

    const chainMessages = await loadChainMessages(
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
    const sendable = plaintext.filter(
      (message) => message.text.trim().length > 0,
    );
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
      chainId: envelope.chainId,
    };
    const authorizationReference =
      await this.options.authorizationReferences?.load(envelope.chainId);
    if (
      this.options.authorizationReferences !== undefined &&
      (authorizationReference === undefined ||
        authorizationReference.deploymentId !== envelope.deploymentId ||
        authorizationReference.ownerId !== ownerId)
    ) {
      throw new CodexStartDeniedError("CODEX_START_AUTHORIZATION_INVALID");
    }

    return {
      ...identity,
      chainId: envelope.chainId,
      chainVersion: envelope.chainVersion,
      ...(authorizationReference === undefined
        ? {}
        : { authorizationReference }),
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

  public commitFinal(
    input: PlanFinalCommitInput,
  ): Promise<{ outboundBatchId: string }> {
    return commitFinalResponse(this.database, input, this.options, this.codec);
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
        .select({
          state: chains.state,
          version: chains.version,
          canceledAt: chains.canceledAt,
        })
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

      const ownerId = await ownerIdForChain(
        transaction,
        input.payload.chainId,
      );
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
              throw new Error(
                `Unknown persisted task dependency: ${dependency}`,
              );
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
          decisionJson: this.codec.decisionForStorage(decision),
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
    await this.database.transaction(async (transaction) => {
      const [chain] = await transaction
        .update(chains)
        .set({
          state: "complete",
          promptVersion: input.promptVersion,
          decisionJson: this.codec.decisionForStorage(decision),
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
        .returning({ id: chains.id, spaceId: chains.spaceId });
      if (chain === undefined) {
        throw new Error(
          "Silent completion rejected because the chain is stale, canceled, or no longer queued.",
        );
      }
      if (this.options.memoryCuration !== undefined) {
        await this.options.memoryCuration.recordCandidatesInTransaction(
          transaction,
          {
            chainId: input.payload.chainId,
            ownerId: await ownerIdForChain(transaction, input.payload.chainId),
            spaceId: chain.spaceId,
            sourceStage: "direct",
            sourceTaskId: null,
            candidates: decision.memoryCandidates,
          },
        );
      }
    });
  }
}
