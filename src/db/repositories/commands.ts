import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import type {
  CommandContext,
  CommandHandlersDependencies,
  CommandStatusSnapshot,
  ComponentStatus,
  NamedAgentSummary,
} from "../../commands/handlers.js";
import { modelSelectionSchema } from "../../agent/model-selection.js";
import type { Database } from "../client.js";
import {
  agentThreads,
  chains,
  channelIdentities,
  deployments,
  executionTasks,
  messages,
  spaces,
} from "../schema.js";

export interface CommandReadinessSnapshot {
  messaging: ComponentStatus;
  signIn: ComponentStatus;
  work: ComponentStatus;
  memory: ComponentStatus | "disabled";
}

export interface CommandRepositoryOptions {
  readiness():
    | Promise<CommandReadinessSnapshot>
    | CommandReadinessSnapshot;
  decrypt(ciphertext: string): Promise<string> | string;
}

export class CommandRepository implements CommandHandlersDependencies {
  public constructor(
    private readonly database: Database,
    private readonly options: CommandRepositoryOptions,
  ) {}

  public async getStatus(
    context: CommandContext,
  ): Promise<CommandStatusSnapshot> {
    await this.assertOwnerSpace(context);
    const [active] = await this.database
      .select({ count: sql<number>`count(*)::int` })
      .from(executionTasks)
      .innerJoin(chains, eq(chains.id, executionTasks.chainId))
      .where(
        and(
          eq(chains.spaceId, context.spaceId),
          isNull(chains.canceledAt),
          inArray(executionTasks.state, ["queued", "running"]),
        ),
      );
    return {
      ...(await this.options.readiness()),
      activeTaskCount: active?.count ?? 0,
      modelSelection: await this.getModelSelection(context),
    };
  }

  public async getModelSelection(context: CommandContext) {
    await this.assertOwnerSpace(context);
    const [deployment] = await this.database
      .select({
        modelId: deployments.effectiveModelId,
        reasoningEffort: deployments.effectiveReasoningEffort,
      })
      .from(spaces)
      .innerJoin(deployments, eq(deployments.id, spaces.deploymentId))
      .where(
        and(
          eq(spaces.id, context.spaceId),
          eq(spaces.deploymentId, context.deploymentId),
        ),
      )
      .limit(1);
    if (deployment === undefined) {
      throw new Error(
        "The command space no longer exists. Rehydrate the Spectrum space before retrying.",
      );
    }
    return modelSelectionSchema.parse(deployment);
  }

  public async cancelActive(
    context: CommandContext,
  ): Promise<{ canceledCount: number }> {
    await this.assertOwnerSpace(context);
    // Inbound ingestion is responsible for superseding and carrying the prior
    // chain before command handling. Report that authoritative result rather
    // than performing a second, lossy cancellation from this command path.
    if (context.currentChainId === undefined) {
      return { canceledCount: 0 };
    }
    const commandMessages = await this.database
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.drainedChainId, context.currentChainId));
    if (commandMessages.length === 0) {
      return { canceledCount: 0 };
    }
    const [count] = await this.database
      .select({ count: sql<number>`count(*)::int` })
      .from(chains)
      .where(
        and(
          eq(chains.spaceId, context.spaceId),
          eq(chains.state, "canceled"),
          inArray(
            chains.canceledByMessageId,
            commandMessages.map((message) => message.id),
          ),
        ),
      );
    return { canceledCount: count?.count ?? 0 };
  }

  public async resetInteractionThread(context: CommandContext): Promise<void> {
    await this.assertOwnerSpace(context);
    const updated = await this.database
      .update(spaces)
      .set({
        interactionThreadId: null,
        interactionSummary: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(spaces.id, context.spaceId),
          eq(spaces.deploymentId, context.deploymentId),
        ),
      )
      .returning({ id: spaces.id });
    if (updated.length !== 1) {
      throw new Error(
        "The interaction thread could not be reset. Reload the conversation and retry.",
      );
    }
  }

  public async listAgents(
    context: CommandContext,
  ): Promise<readonly NamedAgentSummary[]> {
    await this.assertOwnerSpace(context);
    const rows = await this.database
      .select({
        name: agentThreads.agentName,
        status: agentThreads.status,
        summary: agentThreads.summary,
      })
      .from(agentThreads)
      .where(eq(agentThreads.ownerId, context.ownerId))
      .orderBy(desc(agentThreads.lastUsedAt))
      .limit(20);
    return Promise.all(
      rows.map(async (row) => ({
        name: row.name,
        status: row.status === "active" ? "idle" : row.status,
        ...(row.summary === null
          ? {}
          : { summary: await this.options.decrypt(row.summary) }),
      })),
    );
  }

  private async assertOwnerSpace(context: CommandContext): Promise<void> {
    const [authorized] = await this.database
      .select({ id: channelIdentities.id })
      .from(messages)
      .innerJoin(
        channelIdentities,
        eq(channelIdentities.id, messages.senderIdentityId),
      )
      .innerJoin(spaces, eq(spaces.id, messages.spaceId))
      .where(
        and(
          eq(messages.spaceId, context.spaceId),
          eq(channelIdentities.ownerId, context.ownerId),
          eq(channelIdentities.deploymentId, context.deploymentId),
          eq(spaces.deploymentId, context.deploymentId),
          isNull(channelIdentities.revokedAt),
        ),
      )
      .limit(1);
    if (authorized === undefined) {
      throw new Error(
        "Command scope authorization failed. Do not run the command until the owner and space binding is repaired.",
      );
    }
  }
}
