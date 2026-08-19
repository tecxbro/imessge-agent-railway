import { describe, expect, it, vi } from "vitest";

import { ActivationCoordinator } from "../../src/runtime/activation-coordinator.js";
import type {
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

function fakeRun(
  runId: string,
  stopImplementation: (reason: SpectrumStopReason) => Promise<void> = async () =>
    undefined,
): {
  handle: SpectrumRunHandle;
  completion: ReturnType<typeof deferred<SpectrumRunCompletion>>;
  stop: ReturnType<typeof vi.fn<(reason: SpectrumStopReason) => Promise<void>>>;
} {
  const completion = deferred<SpectrumRunCompletion>();
  const stop = vi.fn(stopImplementation);
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

function coordinatorHarness(factory: SpectrumRunFactory): {
  coordinator: ActivationCoordinator;
  recovery: FakeRecoveryScheduler;
} {
  const recovery = new FakeRecoveryScheduler();
  return {
    coordinator: new ActivationCoordinator({
      spectrumRunFactory: factory,
      readinessSink: { publish: () => undefined },
      recoveryScheduler: recovery,
      recoveryBackoffMs: [5, 10],
    }),
    recovery,
  };
}

async function provideValidSnapshots(
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
}

describe("ActivationCoordinator races", () => {
  it("stops a run that finishes starting after capability loss before restarting", async () => {
    const firstStart = deferred<SpectrumRunHandle>();
    const firstStop = deferred<void>();
    const first = fakeRun("run-1", async () => await firstStop.promise);
    const second = fakeRun("run-2");
    const start = vi
      .fn<() => Promise<SpectrumRunHandle>>()
      .mockReturnValueOnce(firstStart.promise)
      .mockResolvedValueOnce(second.handle);
    const { coordinator } = coordinatorHarness({ start });
    await provideValidSnapshots(coordinator);
    expect(coordinator.snapshot().state).toBe("starting");

    await coordinator.dispatch({
      type: "CodexSnapshotChanged",
      snapshot: { auth: "ready", capabilities: "unavailable" },
    });
    expect(coordinator.snapshot().state).toBe("stopping");

    firstStart.resolve(first.handle);
    await vi.waitFor(() => {
      expect(first.stop).toHaveBeenCalledWith("prerequisite_lost");
    });
    const restored = coordinator.dispatch({
      type: "CodexSnapshotChanged",
      snapshot: { auth: "ready", capabilities: "available" },
    });
    expect(start).toHaveBeenCalledOnce();

    firstStop.resolve(undefined);
    await restored;
    await coordinator.idle();
    expect(start).toHaveBeenCalledTimes(2);
    expect(coordinator.snapshot()).toMatchObject({
      state: "active",
      ready: true,
      runId: "run-2",
    });
  });

  it("ignores a recovery event during stopping and a stale older run completion", async () => {
    const firstStop = deferred<void>();
    const first = fakeRun("run-1", async () => await firstStop.promise);
    const second = fakeRun("run-2");
    const start = vi
      .fn<() => Promise<SpectrumRunHandle>>()
      .mockResolvedValueOnce(first.handle)
      .mockResolvedValueOnce(second.handle);
    const { coordinator, recovery } = coordinatorHarness({ start });
    await provideValidSnapshots(coordinator);
    await coordinator.idle();

    const blocked = coordinator.dispatch({
      type: "CodexSnapshotChanged",
      snapshot: { auth: "missing", capabilities: "available" },
    });
    await vi.waitFor(() => expect(first.stop).toHaveBeenCalledOnce());
    const staleRecovery = coordinator.dispatch({
      type: "RecoveryTimerFired",
      recoveryId: 77,
    });
    const restored = coordinator.dispatch({
      type: "CodexSnapshotChanged",
      snapshot: { auth: "ready", capabilities: "available" },
    });

    firstStop.resolve(undefined);
    await Promise.all([blocked, staleRecovery, restored]);
    await coordinator.idle();
    expect(start).toHaveBeenCalledTimes(2);
    expect(coordinator.snapshot()).toMatchObject({
      state: "active",
      runId: "run-2",
    });

    first.completion.resolve({ reason: "restart_exhausted" });
    await coordinator.idle();
    expect(recovery.schedule).not.toHaveBeenCalled();
    expect(coordinator.snapshot()).toMatchObject({
      state: "active",
      runId: "run-2",
    });
  });

  it("cancels recovery backoff during shutdown and ignores its late timer", async () => {
    const run = fakeRun("run-1");
    const start = vi.fn(async () => run.handle);
    const { coordinator, recovery } = coordinatorHarness({ start });
    await provideValidSnapshots(coordinator);
    await coordinator.idle();

    run.completion.resolve({ reason: "restart_exhausted" });
    await coordinator.idle();
    const lateRecovery = recovery.recoveries[0];
    expect(lateRecovery).toBeDefined();
    expect(coordinator.snapshot()).toMatchObject({
      state: "degraded",
      recoveryScheduled: true,
    });

    await coordinator.dispatch({ type: "ShutdownRequested" });
    expect(recovery.cancel).toHaveBeenCalledOnce();
    expect(coordinator.snapshot()).toMatchObject({
      state: "stopped",
      ready: false,
      recoveryScheduled: false,
      shuttingDown: true,
    });

    lateRecovery?.fire();
    await coordinator.idle();
    expect(start).toHaveBeenCalledOnce();
    expect(coordinator.snapshot().state).toBe("stopped");
  });

  it("never restarts an active run after shutdown", async () => {
    const run = fakeRun("run-1");
    const start = vi.fn(async () => run.handle);
    const { coordinator, recovery } = coordinatorHarness({ start });
    await provideValidSnapshots(coordinator);
    await coordinator.idle();

    await coordinator.dispatch({ type: "ShutdownRequested" });
    expect(run.stop).toHaveBeenCalledWith("shutdown");
    expect(coordinator.snapshot().state).toBe("stopped");

    run.completion.resolve({ reason: "restart_exhausted" });
    await coordinator.dispatch({
      type: "PhotonSnapshotChanged",
      snapshot: { connected: false, ownerRevisionCurrent: false },
    });
    await coordinator.dispatch({
      type: "PhotonSnapshotChanged",
      snapshot: { connected: true, ownerRevisionCurrent: true },
    });
    await coordinator.idle();

    expect(start).toHaveBeenCalledOnce();
    expect(recovery.schedule).not.toHaveBeenCalled();
    expect(coordinator.snapshot()).toMatchObject({
      state: "stopped",
      ready: false,
      runId: null,
    });
  });
});
