import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { modelSelectionSchema } from "../../agent/model-selection.js";
import {
  executionResultSchema,
  type ExecutionResult,
} from "../../agent/schemas.js";
import type {
  SynthesisFinalCommitInput,
  TurnSynthesisContext,
  TurnSynthesisRepositoryContract,
} from "../../orchestration/contracts/turn-synthesis.js";
import type { TurnSynthesizePayload } from "../../queue/payloads.js";
import { CodexStartDeniedError } from "../../security/queued-authorization.js";
import type { Database } from "../client.js";
import {
  agentThreads,
  chains,
  executionTasks,
  spaces,
} from "../schema.js";
import { OrchestrationCodec } from "./orchestration-codec.js";
import {
  commitFinalResponse,
  loadChainMessages,
  terminalTaskStates,
  type OrchestrationRepositoryOptions,
} from "./orchestration-shared.js";

export class TurnSynthesisRepository
  implements TurnSynthesisRepositoryContract
{
  public constructor(
    private readonly database: Database,
    private readonly options: OrchestrationRepositoryOptions,
    private readonly codec: OrchestrationCodec,
  ) {}

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
      .innerJoin(
        agentThreads,
        eq(agentThreads.id, executionTasks.agentThreadId),
      )
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
    const authorizationReference =
      await this.options.authorizationReferences?.load(chain.chainId);
    if (
      this.options.authorizationReferences !== undefined &&
      (authorizationReference === undefined ||
        authorizationReference.deploymentId !== chain.deploymentId ||
        authorizationReference.ownerId !== ownerId)
    ) {
      throw new CodexStartDeniedError("CODEX_START_AUTHORIZATION_INVALID");
    }
    const terminalResults: ExecutionResult[] = await Promise.all(
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
    const chainMessages = await loadChainMessages(
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
      ...(authorizationReference === undefined
        ? {}
        : { authorizationReference }),
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

  public commitFinal(
    input: SynthesisFinalCommitInput,
  ): Promise<{ outboundBatchId: string }> {
    return commitFinalResponse(this.database, input, this.options, this.codec);
  }
}
