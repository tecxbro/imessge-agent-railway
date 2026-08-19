import {
  READ_RECEIPT_METRICS,
  ReadReceiptMetrics,
  type ReadReceiptMetricName,
  type ReadReceiptMetricsPort,
} from "../observability/read-receipt-metrics.js";

export type ReadReceiptAttempt = () => Promise<void> | void;

export const DEFAULT_READ_RECEIPT_DELAY_MS = 350;
export const DEFAULT_TYPING_START_DELAY_MS = 150;

export interface ReadReceiptDispatcherPort {
  dispatch(attempt: ReadReceiptAttempt): boolean;
  close(): Promise<void>;
}

export interface ReadReceiptDispatcherOptions {
  concurrency?: number;
  maxPending?: number;
  attemptTimeoutMs?: number;
  shutdownDrainMs?: number;
  metrics?: ReadReceiptMetricsPort;
}

export const DEFAULT_READ_RECEIPT_DISPATCHER_OPTIONS = {
  concurrency: 4,
  maxPending: 100,
  attemptTimeoutMs: 3_000,
  shutdownDrainMs: 1_000,
} as const;

interface ResolvedReadReceiptDispatcherOptions {
  concurrency: number;
  maxPending: number;
  attemptTimeoutMs: number;
  shutdownDrainMs: number;
}

type AttemptOutcome = "completed" | "failed" | "timed-out";

function requirePositiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function requireNonNegativeInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

/**
 * Runs best-effort provider read receipts outside the Spectrum receive loop.
 * Dispatch never returns provider work to the caller, and all rejection paths
 * are converted into aggregate metrics inside this class.
 */
export class ReadReceiptDispatcher implements ReadReceiptDispatcherPort {
  readonly #options: ResolvedReadReceiptDispatcherOptions;
  readonly #metrics: ReadReceiptMetricsPort;
  readonly #pending: ReadReceiptAttempt[] = [];
  #active = 0;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #resolveClose: (() => void) | undefined;
  #closeTimer: ReturnType<typeof setTimeout> | undefined;

  public constructor(options: ReadReceiptDispatcherOptions = {}) {
    this.#options = {
      concurrency: requirePositiveInteger(
        "concurrency",
        options.concurrency ??
          DEFAULT_READ_RECEIPT_DISPATCHER_OPTIONS.concurrency,
      ),
      maxPending: requireNonNegativeInteger(
        "maxPending",
        options.maxPending ?? DEFAULT_READ_RECEIPT_DISPATCHER_OPTIONS.maxPending,
      ),
      attemptTimeoutMs: requirePositiveInteger(
        "attemptTimeoutMs",
        options.attemptTimeoutMs ??
          DEFAULT_READ_RECEIPT_DISPATCHER_OPTIONS.attemptTimeoutMs,
      ),
      shutdownDrainMs: requirePositiveInteger(
        "shutdownDrainMs",
        options.shutdownDrainMs ??
          DEFAULT_READ_RECEIPT_DISPATCHER_OPTIONS.shutdownDrainMs,
      ),
    };
    this.#metrics = options.metrics ?? new ReadReceiptMetrics();
  }

  public dispatch(attempt: ReadReceiptAttempt): boolean {
    if (this.#closed) {
      this.#increment(READ_RECEIPT_METRICS.dropped);
      return false;
    }

    if (this.#active < this.#options.concurrency) {
      this.#start(attempt);
      return true;
    }

    if (this.#pending.length >= this.#options.maxPending) {
      this.#increment(READ_RECEIPT_METRICS.dropped);
      return false;
    }

    this.#pending.push(attempt);
    return true;
  }

  public close(): Promise<void> {
    if (this.#closePromise !== undefined) {
      return this.#closePromise;
    }

    this.#closed = true;
    if (this.#active === 0 && this.#pending.length === 0) {
      this.#closePromise = Promise.resolve();
      return this.#closePromise;
    }

    this.#closePromise = new Promise((resolve) => {
      this.#resolveClose = resolve;
      this.#closeTimer = setTimeout(() => {
        const dropped = this.#pending.splice(0, this.#pending.length).length;
        for (let index = 0; index < dropped; index += 1) {
          this.#increment(READ_RECEIPT_METRICS.dropped);
        }
        this.#completeClose();
      }, this.#options.shutdownDrainMs);
    });

    return this.#closePromise;
  }

  #start(attempt: ReadReceiptAttempt): void {
    this.#active += 1;
    this.#increment(READ_RECEIPT_METRICS.attempts);

    void this.#runAttempt(attempt).then(() => {
      this.#active -= 1;
      const next = this.#pending.shift();
      if (next !== undefined) {
        this.#start(next);
      }
      if (this.#active === 0 && this.#pending.length === 0) {
        this.#completeClose();
      }
    });
  }

  async #runAttempt(attempt: ReadReceiptAttempt): Promise<void> {
    let providerAttempt: Promise<void>;
    try {
      providerAttempt = Promise.resolve(attempt());
    } catch (error) {
      providerAttempt = Promise.reject(error);
    }

    const settledAttempt = providerAttempt.then<AttemptOutcome, AttemptOutcome>(
      () => "completed",
      () => "failed",
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<AttemptOutcome>((resolve) => {
      timeout = setTimeout(
        () => resolve("timed-out"),
        this.#options.attemptTimeoutMs,
      );
      timeout.unref?.();
    });

    const outcome = await Promise.race([settledAttempt, timedOut]);
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }

    if (outcome === "failed") {
      this.#increment(READ_RECEIPT_METRICS.failures);
    } else if (outcome === "timed-out") {
      this.#increment(READ_RECEIPT_METRICS.timeouts);
    }
  }

  #increment(metric: ReadReceiptMetricName): void {
    try {
      this.#metrics.increment(metric);
    } catch {
      // Best-effort telemetry must not reconnect or stop the provider stream.
    }
  }

  #completeClose(): void {
    if (this.#resolveClose === undefined) {
      return;
    }

    if (this.#closeTimer !== undefined) {
      clearTimeout(this.#closeTimer);
      this.#closeTimer = undefined;
    }
    const resolve = this.#resolveClose;
    this.#resolveClose = undefined;
    resolve();
  }
}
