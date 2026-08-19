import { afterEach, describe, expect, it, vi } from "vitest";

import {
  READ_RECEIPT_METRICS,
  ReadReceiptMetrics,
} from "../../src/observability/read-receipt-metrics.js";
import { ReadReceiptDispatcher } from "../../src/transport/read-receipts.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ReadReceiptDispatcher", () => {
  it("bounds active attempts and starts pending work as capacity opens", async () => {
    const metrics = new ReadReceiptMetrics();
    const dispatcher = new ReadReceiptDispatcher({
      attemptTimeoutMs: 1_000,
      concurrency: 2,
      maxPending: 1,
      metrics,
      shutdownDrainMs: 1_000,
    });
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    let active = 0;
    let maximumActive = 0;
    const started: number[] = [];

    for (const [index, gate] of gates.entries()) {
      expect(
        dispatcher.dispatch(async () => {
          started.push(index);
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await gate.promise;
          active -= 1;
        }),
      ).toBe(true);
    }

    expect(started).toEqual([0, 1]);
    expect(maximumActive).toBe(2);

    gates[0]?.resolve();
    await flushPromises();
    expect(started).toEqual([0, 1, 2]);
    expect(maximumActive).toBe(2);

    gates[1]?.resolve();
    gates[2]?.resolve();
    await dispatcher.close();
    expect(metrics.snapshot()[READ_RECEIPT_METRICS.attempts]).toBe(3);
  });

  it("increments only the dropped metric when the pending queue overflows", async () => {
    const metrics = new ReadReceiptMetrics();
    const dispatcher = new ReadReceiptDispatcher({
      attemptTimeoutMs: 1_000,
      concurrency: 1,
      maxPending: 1,
      metrics,
      shutdownDrainMs: 1_000,
    });
    const first = deferred<void>();
    const second = deferred<void>();

    expect(dispatcher.dispatch(() => first.promise)).toBe(true);
    expect(dispatcher.dispatch(() => second.promise)).toBe(true);
    const beforeOverflow = metrics.snapshot();

    expect(dispatcher.dispatch(async () => undefined)).toBe(false);
    expect(metrics.snapshot()).toEqual({
      ...beforeOverflow,
      [READ_RECEIPT_METRICS.dropped]:
        beforeOverflow[READ_RECEIPT_METRICS.dropped] + 1,
    });

    first.resolve();
    await flushPromises();
    second.resolve();
    await dispatcher.close();
  });

  it("times out an attempt without classifying it as a provider failure", async () => {
    vi.useFakeTimers();
    const metrics = new ReadReceiptMetrics();
    const dispatcher = new ReadReceiptDispatcher({
      attemptTimeoutMs: 25,
      concurrency: 1,
      maxPending: 0,
      metrics,
      shutdownDrainMs: 25,
    });

    expect(dispatcher.dispatch(() => new Promise<void>(() => undefined))).toBe(
      true,
    );
    await vi.advanceTimersByTimeAsync(25);
    await dispatcher.close();

    expect(metrics.snapshot()).toEqual({
      [READ_RECEIPT_METRICS.attempts]: 1,
      [READ_RECEIPT_METRICS.failures]: 0,
      [READ_RECEIPT_METRICS.timeouts]: 1,
      [READ_RECEIPT_METRICS.dropped]: 0,
    });
  });

  it("bounds shutdown drain and consumes a rejection that arrives after close", async () => {
    vi.useFakeTimers();
    const metrics = new ReadReceiptMetrics();
    const providerAttempt = deferred<void>();
    const dispatcher = new ReadReceiptDispatcher({
      attemptTimeoutMs: 1_000,
      concurrency: 1,
      maxPending: 0,
      metrics,
      shutdownDrainMs: 20,
    });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    try {
      expect(dispatcher.dispatch(() => providerAttempt.promise)).toBe(true);
      const closing = dispatcher.close();
      let closed = false;
      void closing.then(() => {
        closed = true;
      });

      await vi.advanceTimersByTimeAsync(19);
      expect(closed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await closing;
      expect(closed).toBe(true);

      providerAttempt.reject(new Error("late provider rejection"));
      await flushPromises();
      await vi.advanceTimersByTimeAsync(0);

      expect(unhandled).not.toHaveBeenCalled();
      expect(metrics.snapshot()).toEqual({
        [READ_RECEIPT_METRICS.attempts]: 1,
        [READ_RECEIPT_METRICS.failures]: 1,
        [READ_RECEIPT_METRICS.timeouts]: 0,
        [READ_RECEIPT_METRICS.dropped]: 0,
      });
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("exposes only the four label-free aggregate metric names", () => {
    const metrics = new ReadReceiptMetrics();

    expect(Object.keys(metrics.snapshot()).sort()).toEqual(
      [
        "spectrum_read_receipt_attempts_total",
        "spectrum_read_receipt_dropped_total",
        "spectrum_read_receipt_failures_total",
        "spectrum_read_receipt_timeouts_total",
      ].sort(),
    );
  });

  it("contains failures from an injected metrics adapter", async () => {
    const dispatcher = new ReadReceiptDispatcher({
      metrics: {
        increment() {
          throw new Error("metrics backend unavailable");
        },
      },
    });

    expect(() => dispatcher.dispatch(async () => undefined)).not.toThrow();
    await expect(dispatcher.close()).resolves.toBeUndefined();
  });
});
