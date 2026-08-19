import { describe, expect, it, vi } from "vitest";

import { ActivationCoordinator } from "../../src/runtime/activation-coordinator.js";
import type {
  ActivationSnapshot,
  RecoverySchedule,
  RecoveryScheduler,
} from "../../src/runtime/activation-state.js";
import type {
  SpectrumRunCompletion,
  SpectrumRunFactory,
  SpectrumRunHandle,
  SpectrumStopReason,
} from "../../src/runtime/spectrum-run-handle.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function fakeRun(runId: string): {
  handle: SpectrumRunHandle;
  completion: ReturnType<typeof deferred<SpectrumRunCompletion>>;
  stop: ReturnType<typeof vi.fn<(reason: SpectrumStopReason) => Promise<void>>>;
} {
  const completion = deferred<SpectrumRunCompletion>();
  const stop = vi.fn(async (_reason: SpectrumStopReason) => undefined);
  return {
    handle: { runId, done: completion.promise, stop },
    completion,
    stop,
  };
}

class FakeRecoveryScheduler implements RecoveryScheduler {
  readonly recoveries: RecoverySchedule[] = [];
  readonly schedule = vi.fn((recovery: RecoverySchedule) => {
    this.recoveries.push(recovery);
  });
  readonly cancel = vi.fn(() => undefined);
}

function harness(
  factory: SpectrumRunFactory,
  recoveryBackoffMs: readonly number[] = [10, 20],
): {
  coordinator: ActivationCoordinator;
  snapshots: ActivationSnapshot[];
  recovery: FakeRecoveryScheduler;
} {
  const snapshots: ActivationSnapshot[] = [];
  const recovery = new FakeRecoveryScheduler();
  return {
    coordinator: new ActivationCoordinator({
      spectrumRunFactory: factory,
      readinessSink: {
        publish: (snapshot) => snapshots.push(snapshot),
      },
      recoveryScheduler: recovery,
      recoveryBackoffMs,
    }),
    snapshots,
    recovery,
  };
}

async function satisfyPrerequisites(
  coordinator: ActivationCoordinator,
): Promise<void> {
  await coordinator.dispatch({ type: "StartupCompleted" });
  await coordinator.dispatch({
    type: "OwnerSnapshotChanged",
    snapshot: { configured: true },
  });
  await coordinator.dispatch({
    type: "PhotonSnapshotChanged",
    snapshot: { connected: true, ownerRevisionCurrent: true },
  });
  await coordinator.dispatch({
    type: "CodexSnapshotChanged",
    snapshot: { auth: "ready", capabilities: "available" },
  });
  await coordinator.idle();
}

describe("ActivationCoordinator", () => {
  it("stops the only run when Codex auth becomes missing", async () => {
    const run = fakeRun("run-1");
    const start = vi.fn(async () => run.handle);
    const { coordinator } = harness({ start });

    await satisfyPrerequisites(coordinator);
    expect(coordinator.snapshot()).toMatchObject({
      state: "active",
      ready: true,
      spectrum: "active",
    });

    await coordinator.dispatch({
      type: "CodexSnapshotChanged",
      snapshot: { auth: "missing", capabilities: "available" },
    });

    expect(start).toHaveBeenCalledOnce();
    expect(run.stop).toHaveBeenCalledOnce();
    expect(run.stop).toHaveBeenCalledWith("prerequisite_lost");
    expect(coordinator.snapshot()).toMatchObject({
      state: "blocked",
      ready: false,
      codexAuth: "missing",
      spectrum: "stopped",
      runId: null,
    });
  });

  it("makes repeated identical snapshot events no-ops", async () => {
    const run = fakeRun("run-1");
    const start = vi.fn(async () => run.handle);
    const { coordinator, snapshots } = harness({ start });
    await satisfyPrerequisites(coordinator);
    const publicationCount = snapshots.length;

    await coordinator.dispatch({ type: "StartupCompleted" });
    await coordinator.dispatch({
      type: "OwnerSnapshotChanged",
      snapshot: { configured: true },
    });
    await coordinator.dispatch({
      type: "PhotonSnapshotChanged",
      snapshot: { connected: true, ownerRevisionCurrent: true },
    });
    await coordinator.dispatch({
      type: "CodexSnapshotChanged",
      snapshot: { auth: "ready", capabilities: "available" },
    });

    expect(start).toHaveBeenCalledOnce();
    expect(run.stop).not.toHaveBeenCalled();
    expect(snapshots).toHaveLength(publicationCount);
    expect(coordinator.snapshot().state).toBe("active");
  });

  it("enters degraded and bounds outer recovery after restart exhaustion", async () => {
    const first = fakeRun("run-1");
    const second = fakeRun("run-2");
    const start = vi
      .fn<() => Promise<SpectrumRunHandle>>()
      .mockResolvedValueOnce(first.handle)
      .mockResolvedValueOnce(second.handle);
    const { coordinator, recovery } = harness({ start }, [25]);
    await satisfyPrerequisites(coordinator);

    first.completion.resolve({ reason: "restart_exhausted" });
    await coordinator.idle();
    expect(coordinator.snapshot()).toMatchObject({
      state: "degraded",
      ready: false,
      spectrum: "degraded",
      runId: null,
      recoveryAttempt: 1,
      recoveryScheduled: true,
    });
    expect(recovery.schedule).toHaveBeenCalledOnce();
    expect(recovery.recoveries[0]).toMatchObject({ attempt: 1, delayMs: 25 });

    recovery.recoveries[0]?.fire();
    await coordinator.idle();
    expect(start).toHaveBeenCalledTimes(2);
    expect(coordinator.snapshot()).toMatchObject({
      state: "active",
      runId: "run-2",
    });

    second.completion.resolve({ reason: "restart_exhausted" });
    await coordinator.idle();
    expect(coordinator.snapshot()).toMatchObject({
      state: "degraded",
      runId: null,
      recoveryScheduled: false,
    });
    expect(recovery.schedule).toHaveBeenCalledOnce();

    await coordinator.dispatch({
      type: "SpectrumExited",
      startId: 2,
      runId: "run-2",
      reason: "restart_exhausted",
    });
    expect(recovery.schedule).toHaveBeenCalledOnce();
  });
});
