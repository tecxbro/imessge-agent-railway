import type { PgBoss } from "pg-boss";

import type {
  MemoryCurationReconciliationWork,
  MemoryCurationRepository,
} from "../../db/repositories/memory-curation.js";
import { QUEUE_NAMES } from "../names.js";
import {
  memoryCuratePayloadSchema,
  type MemoryCuratePayload,
} from "../payloads.js";

const ACTIVE_JOB_STATES = new Set(["created", "retry", "active"]);

type MemoryQueueBoss = Pick<PgBoss, "send" | "findJobs">;

export interface MemoryQueueReconciliationReport {
  discovered: {
    completedWithoutRuns: number;
    pendingRuns: number;
    retryableFailedRuns: number;
    deferredRuns: number;
    staleRunningRuns: number;
  };
  pendingRunsWithoutJobs: number;
  enqueued: number;
}

export class PgBossMemoryQueuePublisher {
  public constructor(private readonly boss: MemoryQueueBoss) {}

  public async enqueue(payload: MemoryCuratePayload): Promise<string | null> {
    const parsed = memoryCuratePayloadSchema.parse(payload);
    return this.boss.send(QUEUE_NAMES.memoryCurate, parsed, {
      singletonKey: `chain:${parsed.chainId}:memory-curate`,
      retryLimit: 5,
      retryDelay: 2,
      retryBackoff: true,
      expireInSeconds: 900,
    });
  }

  public async reconcile(
    repository: Pick<MemoryCurationRepository, "findReconciliationWork">,
    options: {
      providerEnabled: boolean;
      limit?: number;
      runningStaleAfterMs?: number;
      now?: Date;
    },
  ): Promise<MemoryQueueReconciliationReport> {
    const now = options.now ?? new Date();
    const staleAfterMs = options.runningStaleAfterMs ?? 15 * 60 * 1_000;
    const work = await repository.findReconciliationWork({
      providerEnabled: options.providerEnabled,
      runningBefore: new Date(now.getTime() - staleAfterMs),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
    const activeJobs = await this.boss.findJobs<MemoryCuratePayload>(
      QUEUE_NAMES.memoryCurate,
    );
    const activeChainIds = new Set(
      activeJobs.flatMap((job) => {
        if (!ACTIVE_JOB_STATES.has(job.state)) {
          return [];
        }
        const parsed = memoryCuratePayloadSchema.safeParse(job.data);
        return parsed.success ? [parsed.data.chainId] : [];
      }),
    );

    const pendingRunsWithoutJobs = work.pendingRuns.filter(
      (candidate) => !activeChainIds.has(candidate.chainId),
    ).length;
    let enqueued = 0;
    for (const candidate of this.uniqueWork(work)) {
      if (activeChainIds.has(candidate.chainId)) {
        continue;
      }
      const jobId = await this.enqueue(candidate);
      if (jobId !== null) {
        enqueued += 1;
        activeChainIds.add(candidate.chainId);
      }
    }

    return {
      discovered: {
        completedWithoutRuns: work.completedWithoutRuns.length,
        pendingRuns: work.pendingRuns.length,
        retryableFailedRuns: work.retryableFailedRuns.length,
        deferredRuns: work.deferredRuns.length,
        staleRunningRuns: work.staleRunningRuns.length,
      },
      pendingRunsWithoutJobs,
      enqueued,
    };
  }

  private uniqueWork(
    work: MemoryCurationReconciliationWork,
  ): readonly MemoryCuratePayload[] {
    const unique = new Map<string, MemoryCuratePayload>();
    for (const candidate of [
      ...work.completedWithoutRuns,
      ...work.pendingRuns,
      ...work.retryableFailedRuns,
      ...work.deferredRuns,
      ...work.staleRunningRuns,
    ]) {
      unique.set(candidate.chainId, candidate);
    }
    return [...unique.values()];
  }
}
