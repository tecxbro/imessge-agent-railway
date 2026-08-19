import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { DurableQueue } from "../../src/queue/boss.js";
import { QUEUE_NAMES } from "../../src/queue/names.js";
import { PgBossPublisher } from "../../src/queue/publisher.js";

const databaseUrl = process.env["POSTGRES_PIPELINE_TEST_DATABASE_URL"];
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;
const batchId = "20000000-0000-4000-8000-000000000001";
const chainId = "20000000-0000-4000-8000-000000000002";
const spaceId = "20000000-0000-4000-8000-000000000003";

describeDatabase("pg-boss durable queue", () => {
  let queue: DurableQueue;

  beforeAll(async () => {
    if (databaseUrl === undefined) {
      return;
    }
    queue = new DurableQueue({ connectionString: databaseUrl });
    await queue.start();
    await queue.boss.deleteAllJobs(QUEUE_NAMES.outboundSend);
    await queue.boss.deleteAllJobs(QUEUE_NAMES.turnSynthesize);
    await queue.boss.deleteAllJobs(QUEUE_NAMES.inboundFlush);
    await queue.boss.deleteAllJobs(QUEUE_NAMES.turnPlan);
  });

  afterAll(async () => {
    await queue?.stop();
  });

  it("creates one queued outbound job for concurrent singleton sends", async () => {
    const publisher = new PgBossPublisher(queue.boss);
    await Promise.all([
      publisher.enqueueOutboundSend({
        outboundBatchId: batchId,
        expectedState: "queued",
      }),
      publisher.enqueueOutboundSend({
        outboundBatchId: batchId,
        expectedState: "queued",
      }),
    ]);

    const jobs = await queue.boss.findJobs(QUEUE_NAMES.outboundSend, {
      queued: true,
    });
    expect(
      jobs.filter(
        (job) =>
          (job.data as { outboundBatchId?: string }).outboundBatchId === batchId,
      ),
    ).toHaveLength(1);
  });

  it("keeps one movable flush schedule per space", async () => {
    const publisher = new PgBossPublisher(queue.boss);
    await Promise.all([
      publisher.scheduleInboundFlush({ spaceId }, 4_000),
      publisher.scheduleInboundFlush({ spaceId }, 4_000),
    ]);
    const resetAt = Date.now();
    await publisher.scheduleInboundFlush({ spaceId }, 5_000);

    const jobs = await queue.boss.findJobs(QUEUE_NAMES.inboundFlush, {
      queued: true,
    });
    const matching = jobs.filter(
      (job) => (job.data as { spaceId?: string }).spaceId === spaceId,
    );
    expect(matching).toHaveLength(1);
    expect(matching[0]?.startAfter.getTime()).toBeGreaterThanOrEqual(
      resetAt + 4_900,
    );
  });

  it("stores a zero-debounce flush without a future start time", async () => {
    const immediateSpaceId = "20000000-0000-4000-8000-000000000004";
    const publisher = new PgBossPublisher(queue.boss);

    await publisher.scheduleInboundFlush({ spaceId: immediateSpaceId }, 0);

    const jobs = await queue.boss.findJobs(QUEUE_NAMES.inboundFlush, {
      queued: true,
    });
    const job = jobs.find(
      (candidate) =>
        (candidate.data as { spaceId?: string }).spaceId === immediateSpaceId,
    );

    expect(job).toBeDefined();
    expect(job!.startAfter.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("creates one synthesis job per chain", async () => {
    const publisher = new PgBossPublisher(queue.boss);
    const payload = {
      chainId,
      expectedChainVersion: 1,
      expectedState: "executing" as const,
    };
    await Promise.all([
      publisher.enqueueTurnSynthesize(payload),
      publisher.enqueueTurnSynthesize(payload),
    ]);

    const jobs = await queue.boss.findJobs(QUEUE_NAMES.turnSynthesize, {
      queued: true,
    });
    expect(
      jobs.filter(
        (job) => (job.data as { chainId?: string }).chainId === chainId,
      ),
    ).toHaveLength(1);
  });

  it("does not retry a worker error classified as non-retryable", async () => {
    const handler = vi.fn(async () => {
      throw Object.assign(new Error("invalid structured output schema"), {
        code: "CODEX_STRUCTURED_OUTPUT_INVALID",
        retryable: false,
      });
    });
    await queue.registerWorker(QUEUE_NAMES.turnPlan, handler);
    const jobId = await queue.boss.send(
      QUEUE_NAMES.turnPlan,
      {
        chainId,
        expectedChainVersion: 1,
        expectedState: "queued",
      },
      { retryLimit: 5, retryDelay: 1 },
    );
    expect(jobId).not.toBeNull();

    let state: string | undefined;
    for (let attempt = 0; attempt < 100 && state !== "failed"; attempt += 1) {
      const job =
        jobId === null
          ? null
          : await queue.boss.getJobById(QUEUE_NAMES.turnPlan, jobId);
      state = job?.state;
      if (state !== "failed") {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    expect(state).toBe("failed");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
