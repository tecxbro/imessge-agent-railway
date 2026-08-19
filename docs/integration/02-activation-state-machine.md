# Activation state machine integration manifest

This branch adds an isolated, idempotent owner for the Spectrum runtime. It is
not wired into `src/index.ts`, `src/runtime/production-bootstrap.ts`, or the
readiness implementation.

## Exported classes and interfaces

- `ActivationCoordinator` and `ActivationCoordinatorOptions` in
  `src/runtime/activation-coordinator.ts`.
- `ActivationState`, `ActivationBlocker`, `ActivationSnapshot`,
  `ActivationEvent`, the individual event interfaces, and the owner, Photon,
  and Codex snapshot interfaces in `src/runtime/activation-state.ts`.
- `ActivationReadinessSink`, `RecoveryScheduler`, and `RecoverySchedule` in
  `src/runtime/activation-state.ts`.
- `SpectrumRunFactory`, `SpectrumRunHandle`, `SpectrumRunCompletion`,
  `SpectrumRunExitReason`, and `SpectrumStopReason` in
  `src/runtime/spectrum-run-handle.ts`.

The coordinator exposes `dispatch(event)`, `snapshot()`, and `idle()`. All
events are ordered through one serialized operation chain. A provider start is
allowed to remain pending so prerequisite and shutdown events can still enter
that chain; its result returns through `SpectrumStarted` or `SpectrumExited`.

## Required production wiring

The integration worktree must:

1. Adapt the existing supervised Spectrum receive loop to a
   `SpectrumRunFactory`. Each start must return one uniquely identified handle;
   `done` must resolve as `exited` or `restart_exhausted`, and `stop` must abort
   and await that run's cleanup.
2. Construct one coordinator per deployment and feed it `StartupCompleted`,
   owner identity, Photon connection/owner-revision, Codex auth/capability, and
   shutdown events. Setup controllers must publish their persisted snapshots,
   not optimistic browser state.
3. Supply a bounded timer adapter for `RecoveryScheduler`. A canceled timer may
   still race its callback; the coordinator rejects it by recovery ID.
4. Dispatch `ShutdownRequested` and await the returned operation before closing
   provider dependencies.

No production wiring is included on this leaf branch.

## Database changes

None. The state machine is process-local coordination over injected,
authoritative snapshots. No migration or schema fragment is added.

## Queue changes

None. The state machine neither publishes jobs nor changes queue contracts.

## Readiness changes

No integration-owned readiness file is changed. Production must adapt
`ActivationReadinessSink.publish(snapshot)` to its readiness registry. The
snapshot supplies `ready`, activation `state`, blockers, Spectrum status,
owned `runId`, bounded recovery state, and redacted prerequisite booleans. It
contains no owner phone, provider credential, Codex credential, or raw error.

`ready` is true only while the coordinator owns an active Spectrum handle and
all startup, owner, Photon, Codex, and shutdown predicates allow the run.

## Exact tests added

`test/unit/activation-coordinator.test.ts`:

- stops the only run when Codex auth becomes missing (the regression asserts
  one start, one stop, `ready: false`, `codexAuth: missing`, and Spectrum
  stopped);
- makes repeated identical snapshot events no-ops; and
- enters degraded state and bounds outer recovery after restart exhaustion.

`test/chaos/activation-coordinator-races.test.ts`:

- stops a run that finishes starting after capability loss and awaits that
  stop before another start;
- ignores a recovery event queued during stopping and ignores stale completion
  from the older run ID;
- cancels recovery backoff during shutdown and ignores its late timer; and
- never restarts an active run after shutdown.

Both suites use fake ports only. The chaos suite is the integration-style race
coverage for the full coordinator boundary; no production provider or database
is invoked.
