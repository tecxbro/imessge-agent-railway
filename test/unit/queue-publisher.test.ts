import { describe, expect, it, vi } from "vitest";

import { QUEUE_NAMES } from "../../src/queue/names.js";
import { PgBossPublisher } from "../../src/queue/publisher.js";

const spaceId = "00000000-0000-4000-8000-000000000001";
const chainId = "00000000-0000-4000-8000-000000000002";
const batchId = "00000000-0000-4000-8000-000000000003";
const taskId = "00000000-0000-4000-8000-000000000004";

describe("pg-boss publisher", () => {
  it("debounces inbound flushes by space with an ID-only payload", async () => {
    const upsert = vi.fn().mockResolvedValue({ jobs: ["job-id"], updated: 0, inserted: 1 });
    const publisher = new PgBossPublisher(
      { send: vi.fn(), upsert },
      () => new Date("2026-08-14T00:00:00Z"),
    );

    await publisher.scheduleInboundFlush({ spaceId }, 4_000);

    expect(upsert).toHaveBeenCalledWith(
      QUEUE_NAMES.inboundFlush,
      { spaceId },
      expect.objectContaining({
        singletonKey: `space:${spaceId}`,
        startAfter: new Date("2026-08-14T00:00:04Z"),
        retryLimit: 5,
        retryBackoff: true,
      }),
    );
    expect(JSON.stringify(upsert.mock.calls)).not.toContain("text");
  });

  it("makes a zero-debounce inbound flush immediately eligible", async () => {
    const now = new Date("2026-08-14T00:00:00Z");
    const upsert = vi.fn().mockResolvedValue({
      jobs: ["job-id"],
      updated: 0,
      inserted: 1,
    });

    const publisher = new PgBossPublisher(
      { send: vi.fn(), upsert },
      () => now,
    );

    await publisher.scheduleInboundFlush({ spaceId }, 0);

    expect(upsert).toHaveBeenCalledWith(
      QUEUE_NAMES.inboundFlush,
      { spaceId },
      expect.objectContaining({
        singletonKey: `space:${spaceId}`,
        startAfter: now,
        retryLimit: 5,
        retryBackoff: true,
      }),
    );
  });

  it("uses task, chain, and batch singleton keys for orchestration", async () => {
    const send = vi.fn().mockResolvedValue("job-id");
    const publisher = new PgBossPublisher({ send, upsert: vi.fn() });

    await publisher.enqueueTaskExecute({
      taskId,
      chainId,
      expectedChainVersion: 3,
      expectedState: "queued",
    });
    await publisher.enqueueTurnSynthesize({
      chainId,
      expectedChainVersion: 3,
      expectedState: "executing",
    });
    await publisher.enqueueOutboundSend({
      outboundBatchId: batchId,
      expectedState: "queued",
    });

    expect(send.mock.calls[0]?.[2]).toMatchObject({
      singletonKey: `task:${taskId}`,
    });
    expect(send.mock.calls[1]?.[2]).toMatchObject({
      singletonKey: `chain:${chainId}:synthesize`,
    });
    expect(send.mock.calls[2]?.[2]).toMatchObject({
      singletonKey: `outbound:${batchId}`,
    });
  });
});
