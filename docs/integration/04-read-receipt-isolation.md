# Worktree 4: Read-receipt isolation

## Exported classes and interfaces

`src/transport/read-receipts.ts` exports:

- `ReadReceiptDispatcher`, a bounded best-effort dispatcher;
- `ReadReceiptDispatcherPort`, the injection boundary used by the Spectrum
  receive loop;
- `ReadReceiptDispatcherOptions`, covering concurrency, pending capacity,
  per-attempt timeout, shutdown drain, and the metrics port;
- `ReadReceiptAttempt`;
- `DEFAULT_READ_RECEIPT_DISPATCHER_OPTIONS`.

`src/observability/read-receipt-metrics.ts` exports:

- `ReadReceiptMetrics`, the label-free in-memory counter implementation;
- `ReadReceiptMetricsPort`;
- `ReadReceiptMetricName` and `ReadReceiptMetricsSnapshot`;
- `READ_RECEIPT_METRICS`, containing only these metric names:
  - `spectrum_read_receipt_attempts_total`
  - `spectrum_read_receipt_failures_total`
  - `spectrum_read_receipt_timeouts_total`
  - `spectrum_read_receipt_dropped_total`

`SpectrumMessageLoopOptions` retains all existing fields and adds the optional
`readReceiptDispatcher`. Existing `handleSpectrumMessage` and
`runSpectrumMessageLoop` callers remain source-compatible.

## Required production wiring

This leaf does not edit `src/runtime/production-bootstrap.ts` or any other
integration-owned file. `runSpectrumMessageLoop` creates and owns one default
dispatcher when none is injected, so the isolation behavior works without a
composition change. It closes either the owned or injected dispatcher in its
final cleanup.

Final integration may instantiate `ReadReceiptMetrics` and a configured
`ReadReceiptDispatcher` at the production composition boundary, then pass it
through `readReceiptDispatcher` if the aggregate counters need to be exported
to the service metrics backend. The metrics adapter must remain label-free and
must not accept provider message IDs, space IDs, phone numbers, sender values,
or message content.

Authorization and durable ingestion remain awaited. Only `accepted` and
`duplicate` dispositions schedule `message.read()`. Receipt rejection,
timeout, overflow, and shutdown are internal to the dispatcher and cannot
enter the stream-disconnect/restart path.

## Database changes

None. No migration, schema fragment, repository, or Drizzle metadata file is
added or changed.

## Queue changes

None. Read receipts use an in-process bounded dispatcher. No central or
extension queue contract is added or changed.

## Readiness changes

None. Spectrum readiness continues to describe only stream health. A receipt
failure, timeout, or drop does not degrade readiness and cannot increment the
stream `restartAttempt`.

## Exact tests added

`test/unit/read-receipts.test.ts`:

- `bounds active attempts and starts pending work as capacity opens`
- `increments only the dropped metric when the pending queue overflows`
- `times out an attempt without classifying it as a provider failure`
- `bounds shutdown drain and consumes a rejection that arrives after close`
- `exposes only the four label-free aggregate metric names`
- `contains failures from an injected metrics adapter`

`test/integration/read-receipt-isolation.test.ts`:

- `does not reject message handling when message.read rejects`
- `keeps the stream connected and processes the next message while a read is unresolved`
- `never schedules a receipt for an unauthorized message`
- `schedules a receipt for a duplicate message`
- `uses and closes an injected dispatcher during loop cleanup`

All tests use fake Spectrum values or injected ports. They do not call Photon
and are not protected live-provider evidence.
