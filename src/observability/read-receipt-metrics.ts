export const READ_RECEIPT_METRICS = {
  attempts: "spectrum_read_receipt_attempts_total",
  failures: "spectrum_read_receipt_failures_total",
  timeouts: "spectrum_read_receipt_timeouts_total",
  dropped: "spectrum_read_receipt_dropped_total",
} as const;

export type ReadReceiptMetricName =
  (typeof READ_RECEIPT_METRICS)[keyof typeof READ_RECEIPT_METRICS];

export type ReadReceiptMetricsSnapshot = Readonly<
  Record<ReadReceiptMetricName, number>
>;

/**
 * A deliberately label-free metrics boundary. Read-receipt telemetry records
 * only aggregate outcomes, so provider identifiers and message content cannot
 * be attached by callers.
 */
export interface ReadReceiptMetricsPort {
  increment(metric: ReadReceiptMetricName): void;
}

export class ReadReceiptMetrics implements ReadReceiptMetricsPort {
  readonly #counts: Record<ReadReceiptMetricName, number> = {
    [READ_RECEIPT_METRICS.attempts]: 0,
    [READ_RECEIPT_METRICS.failures]: 0,
    [READ_RECEIPT_METRICS.timeouts]: 0,
    [READ_RECEIPT_METRICS.dropped]: 0,
  };

  public increment(metric: ReadReceiptMetricName): void {
    this.#counts[metric] += 1;
  }

  public snapshot(): ReadReceiptMetricsSnapshot {
    return { ...this.#counts };
  }
}
