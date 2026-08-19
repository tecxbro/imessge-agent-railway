import { describe, expect, it, vi } from "vitest";

import { createInboundFlushHandler } from "../../src/queue/handlers/inbound-flush.js";
import { DurablePipeline } from "../../src/queue/pipeline.js";
import { PgBossPublisher } from "../../src/queue/publisher.js";

const spaceId = "00000000-0000-4000-8000-000000000101";
const chainId = "00000000-0000-4000-8000-000000000102";
const messageId = "00000000-0000-4000-8000-000000000103";
const batchId = "00000000-0000-4000-8000-000000000104";
const taskId = "00000000-0000-4000-8000-000000000106";

describe("durable receive, debounce, planning, and synthesis recovery", () => {
  it("interrupts superseded in-flight work before scheduling the replacement flush", async () => {
    const order: string[] = [];
    const onChainsSuperseded = vi.fn((chainIds: readonly string[]) => {
      order.push(`cancel:${chainIds.join(",")}`);
    });
    const pipeline = new DurablePipeline({
      inbound: {
        ingestAcceptedMessage: vi.fn(async () => ({
          inserted: true,
          messageId,
        })),
        findSpacesWithUndrainedInbound: vi.fn(async () => []),
      },
      chains: {
        supersedeActiveChain: vi.fn(async () => ({
          canceledChainIds: [chainId],
          carriedMessageIds: [],
        })),
        findQueuedChains: vi.fn(async () => []),
      },
      outbound: { findResumableBatchIds: vi.fn(async () => []) },
      publisher: {
        scheduleInboundFlush: vi.fn(async () => {
          order.push("schedule-replacement");
        }),
        enqueueTurnPlan: vi.fn(async () => undefined),
        enqueueTaskExecute: vi.fn(async () => undefined),
        enqueueTurnSynthesize: vi.fn(async () => undefined),
        enqueueOutboundSend: vi.fn(async () => undefined),
        enqueueApprovalRequest: vi.fn(async () => undefined),
        enqueueApprovalExecute: vi.fn(async () => undefined),
        enqueueMemoryCurate: vi.fn(async () => undefined),
      },
      onChainsSuperseded,
      debounceMs: 4_000,
    });

    await pipeline.ingestAndSchedule({
      spaceId,
      externalMessageId: "provider-message-correction",
      senderIdentityId: "00000000-0000-4000-8000-000000000105",
      contentCiphertext: "encrypted",
      contentHash: "hash",
      receivedAt: new Date("2026-08-14T12:00:00.000Z"),
      retentionExpiresAt: new Date("2026-09-13T12:00:00.000Z"),
    });

    expect(onChainsSuperseded).toHaveBeenCalledWith([chainId]);
    expect(order).toEqual([`cancel:${chainId}`, "schedule-replacement"]);
  });

  it("interrupts chains superseded during reconciliation flush recovery", async () => {
    const onChainsSuperseded = vi.fn();
    const enqueueTurnPlan = vi.fn(async () => undefined);
    const handler = createInboundFlushHandler({
      chains: {
        flushInboundMessages: vi.fn(async () => ({
          chainId,
          version: 2,
          messageIds: [messageId],
          canceledChainIds: ["00000000-0000-4000-8000-000000000107"],
        })),
      },
      publisher: { enqueueTurnPlan },
      onChainsSuperseded,
    });

    await handler({ spaceId });

    expect(onChainsSuperseded).toHaveBeenCalledWith([
      "00000000-0000-4000-8000-000000000107",
    ]);
    expect(enqueueTurnPlan).toHaveBeenCalledWith({
      chainId,
      expectedChainVersion: 2,
      expectedState: "queued",
    });
  });

  it("recovers a receive crash after durable insert but before debounce scheduling", async () => {
    const scheduleInboundFlush = vi
      .fn()
      .mockRejectedValueOnce(new Error("simulated queue outage"))
      .mockResolvedValue(undefined);
    const pipeline = new DurablePipeline({
      inbound: {
        ingestAcceptedMessage: vi.fn(async () => ({
          inserted: true,
          messageId,
        })),
        findSpacesWithUndrainedInbound: vi.fn(async () => [spaceId]),
      },
      chains: {
        supersedeActiveChain: vi.fn(async () => ({
          canceledChainIds: [],
          carriedMessageIds: [],
        })),
        findQueuedChains: vi.fn(async () => []),
      },
      outbound: { findResumableBatchIds: vi.fn(async () => []) },
      publisher: {
        scheduleInboundFlush,
        enqueueTurnPlan: vi.fn(async () => undefined),
        enqueueTaskExecute: vi.fn(async () => undefined),
        enqueueTurnSynthesize: vi.fn(async () => undefined),
        enqueueOutboundSend: vi.fn(async () => undefined),
        enqueueApprovalRequest: vi.fn(async () => undefined),
        enqueueApprovalExecute: vi.fn(async () => undefined),
        enqueueMemoryCurate: vi.fn(async () => undefined),
      },
      debounceMs: 4_000,
    });

    await expect(
      pipeline.ingestAndSchedule({
        spaceId,
        externalMessageId: "provider-message-1",
        senderIdentityId: "00000000-0000-4000-8000-000000000105",
        contentCiphertext: "encrypted",
        contentHash: "hash",
        receivedAt: new Date("2026-08-14T12:00:00.000Z"),
        retentionExpiresAt: new Date("2026-09-13T12:00:00.000Z"),
      }),
    ).rejects.toThrow(/message is durable/);

    await expect(pipeline.reconcile()).resolves.toEqual({
      inboundFlushesScheduled: 1,
      planJobsScheduled: 0,
      staleTasksRecovered: 0,
      taskJobsScheduled: 0,
      synthesisJobsScheduled: 0,
      outboundJobsScheduled: 0,
    });
    expect(scheduleInboundFlush).toHaveBeenNthCalledWith(2, { spaceId }, 4_000);
  });

  it("uses stable singleton keys when debounce, planning, synthesis, and send enqueue retry", async () => {
    const upsertSingletonKeys: string[] = [];
    const sendSingletonKeys: string[] = [];
    const upsert = vi.fn(async (...arguments_: unknown[]) => {
      upsertSingletonKeys.push(
        (arguments_[2] as { singletonKey: string }).singletonKey,
      );
    });
    let sendAttempt = 0;
    const send = vi.fn(async (...arguments_: unknown[]) => {
      sendSingletonKeys.push(
        (arguments_[2] as { singletonKey: string }).singletonKey,
      );
      sendAttempt += 1;
      if (sendAttempt === 1) {
        throw new Error("simulated plan enqueue timeout");
      }
    });
    const now = new Date("2026-08-14T12:00:00.000Z");
    const publisher = new PgBossPublisher(
      { upsert, send } as never,
      () => now,
    );

    await publisher.scheduleInboundFlush({ spaceId }, 4_000);
    await publisher.scheduleInboundFlush({ spaceId }, 4_000);
    expect(upsertSingletonKeys).toEqual([
      `space:${spaceId}`,
      `space:${spaceId}`,
    ]);

    const plan = {
      chainId,
      expectedChainVersion: 1,
      expectedState: "queued" as const,
    };
    await expect(publisher.enqueueTurnPlan(plan)).rejects.toThrow(
      "simulated plan enqueue timeout",
    );
    await publisher.enqueueTurnPlan(plan);
    await publisher.enqueueTaskExecute({
      taskId,
      chainId,
      expectedChainVersion: 1,
      expectedState: "queued",
    });
    await publisher.enqueueTurnSynthesize({
      chainId,
      expectedChainVersion: 1,
      expectedState: "executing",
    });
    await publisher.enqueueOutboundSend({
      outboundBatchId: batchId,
      expectedState: "sending",
    });

    expect(sendSingletonKeys).toEqual([
      `chain:${chainId}:plan`,
      `chain:${chainId}:plan`,
      `task:${taskId}`,
      `chain:${chainId}:synthesize`,
      `outbound:${batchId}`,
    ]);
  });
});
