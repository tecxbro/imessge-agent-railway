import type {
  AcceptedInboundMessage,
  InboundRepository,
  IngestResult,
} from "../db/repositories/inbound.js";
import type { ChainRepository } from "../db/repositories/chains.js";
import type { OutboundRepository } from "../db/repositories/outbound.js";
import type { OrchestrationRepository } from "../db/repositories/orchestration.js";
import type { QueuePublisher } from "./publisher.js";

export interface DurableInboundPipelineDependencies {
  inbound: Pick<
    InboundRepository,
    "ingestAcceptedMessage" | "findSpacesWithUndrainedInbound"
  >;
  chains: Pick<
    ChainRepository,
    "supersedeActiveChain" | "findQueuedChains"
  >;
  outbound: Pick<OutboundRepository, "findResumableBatchIds">;
  orchestration?: Pick<
    OrchestrationRepository,
    | "requeueStaleRunningTasks"
    | "findRunnableTaskPayloads"
    | "findSynthesisPayloads"
  >;
  publisher: QueuePublisher;
  onChainsSuperseded?: (chainIds: readonly string[]) => void;
  debounceMs: number;
  taskRuntimeMs?: number;
  now?: () => Date;
}

export interface ReconciliationResult {
  inboundFlushesScheduled: number;
  planJobsScheduled: number;
  staleTasksRecovered: number;
  taskJobsScheduled: number;
  synthesisJobsScheduled: number;
  outboundJobsScheduled: number;
}

export class DurablePipeline {
  public constructor(
    private readonly dependencies: DurableInboundPipelineDependencies,
  ) {}

  public async ingestAndSchedule(
    input: AcceptedInboundMessage,
  ): Promise<IngestResult> {
    // Commit accepted content before touching pg-boss. A queue outage may delay
    // work, but it cannot make an authorized inbound message disappear.
    const result = await this.dependencies.inbound.ingestAcceptedMessage(input);
    if (result.inserted) {
      // Supersession interrupts stale work; its already accepted messages stay
      // durable so the repository can carry them into the replacement chain.
      const superseded = await this.dependencies.chains.supersedeActiveChain(
        input.spaceId,
        result.messageId,
      );
      if (superseded.canceledChainIds.length > 0) {
        this.dependencies.onChainsSuperseded?.(superseded.canceledChainIds);
      }
    }

    try {
      await this.dependencies.publisher.scheduleInboundFlush(
        { spaceId: input.spaceId },
        this.dependencies.debounceMs,
      );
    } catch (error) {
      throw new Error(
        "Inbound message is durable but its flush job could not be scheduled. Run pipeline reconciliation after queue recovery.",
        { cause: error },
      );
    }

    return result;
  }

  public async reconcile(limit = 100): Promise<ReconciliationResult> {
    // Reconciliation recreates identifier-only jobs from authoritative rows
    // after a crash or a database-commit/queue-publish split failure.
    const spaceIds = await this.dependencies.inbound.findSpacesWithUndrainedInbound(
      limit,
    );
    for (const spaceId of spaceIds) {
      await this.dependencies.publisher.scheduleInboundFlush(
        { spaceId },
        this.dependencies.debounceMs,
      );
    }

    const queuedChains = await this.dependencies.chains.findQueuedChains(limit);
    for (const chain of queuedChains) {
      await this.dependencies.publisher.enqueueTurnPlan({
        chainId: chain.chainId,
        expectedChainVersion: chain.version,
        expectedState: "queued",
      });
    }

    const now = this.dependencies.now?.() ?? new Date();
    const staleBefore = new Date(
      now.getTime() - (this.dependencies.taskRuntimeMs ?? 900_000),
    );
    const staleTasksRecovered =
      (await this.dependencies.orchestration?.requeueStaleRunningTasks(
        staleBefore,
        limit,
      )) ?? 0;
    const runnableTasks =
      (await this.dependencies.orchestration?.findRunnableTaskPayloads(limit)) ??
      [];
    for (const task of runnableTasks) {
      await this.dependencies.publisher.enqueueTaskExecute(task);
    }

    const syntheses =
      (await this.dependencies.orchestration?.findSynthesisPayloads(limit)) ?? [];
    for (const synthesis of syntheses) {
      await this.dependencies.publisher.enqueueTurnSynthesize(synthesis);
    }

    const batchIds = await this.dependencies.outbound.findResumableBatchIds(limit);
    for (const outboundBatchId of batchIds) {
      await this.dependencies.publisher.enqueueOutboundSend({
        outboundBatchId,
        expectedState: "sending",
      });
    }

    return {
      inboundFlushesScheduled: spaceIds.length,
      planJobsScheduled: queuedChains.length,
      staleTasksRecovered,
      taskJobsScheduled: runnableTasks.length,
      synthesisJobsScheduled: syntheses.length,
      outboundJobsScheduled: batchIds.length,
    };
  }
}
