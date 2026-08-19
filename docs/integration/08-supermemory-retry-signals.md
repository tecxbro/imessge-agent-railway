# Worktree 8: Supermemory retry signals

## Exported classes and interfaces

This leaf preserves the existing public surface of `src/memory/supermemory-client.ts`:

- Classes: `SupermemoryClient`, `MemoryProviderError`.
- Interfaces: `MemoryProfile`, `MemorySearchHit`, `CreatedMemory`,
  `ListedMemory`, `CreateMemoryInput`, `DeleteContainerResult`,
  `SupermemoryPort`, and `SupermemoryClientOptions`.
- Types: `MemoryMetadataValue`, `MemoryMetadata`, and
  `MemoryProviderErrorCode`.
- Function: `ownerContainerTag`.

No constructor or existing export changed. `maxReadRetries` still means the
number of retries after the first read attempt.

## Required production wiring

No production wiring is included or required for this leaf. Existing
`SupermemoryClient` construction and `SupermemoryPort` consumers remain valid.
Once this commit is merged, profile, search, and list reads automatically use
the application-owned retry policy. The owned SDK and every retried SDK call
set `maxRetries: 0`, so the SDK cannot add a nested retry loop.

The integration branch should retain its current client construction. It must
not add another retry wrapper around these reads.

## Database changes

None. No migration, schema fragment, repository, or persistence contract is
changed.

## Queue changes

None. No queue name, payload, publisher, boss, extension contract, or handler
is changed. Queue-level retry policy remains outside this leaf.

## Readiness changes

None. Supermemory readiness and degradation semantics are unchanged. This leaf
only changes per-call read retry, timeout, cancellation, and error
classification behavior.

## Exact tests added

`test/unit/supermemory-client.test.ts` now proves:

- the first profile attempt can time out and the second can succeed;
- retry attempts receive distinct signals and the second starts live;
- caller cancellation is non-retryable and prevents later attempts;
- aborting during jittered exponential backoff prevents the next attempt;
- `maxReadRetries: 2` produces exactly three attempts;
- attempt/backoff timers and the exact caller-abort listeners are cleaned up;
- profile, search, and list all use application retries;
- failed direct-response bodies are canceled before list retries;
- SDK and direct-fetch auth, permission, validation, and ordinary `4xx` errors
  are non-retryable;
- rate limits are separately classified and retryable;
- create, update, forget, and container deletion remain single-attempt writes;
- SDK request options use `maxRetries: 0`.

`test/integration/supermemory-retry-signals.test.ts` composes
`SupermemoryClient` with the real pinned SDK and a fake fetch port. Even when
the injected SDK is configured with retries enabled, the underlying requests
emit only retry count `0` for each application attempt, proving SDK and
application retry loops are not stacked.

All provider interactions in these tests use fake fetch/SDK ports; no live
Supermemory credentials or production wiring are exercised.
