import type {
  ActivationBlocker,
  ActivationEvent,
  ActivationReadinessSink,
  ActivationSnapshot,
  ActivationState,
  CodexActivationSnapshot,
  OwnerActivationSnapshot,
  PhotonActivationSnapshot,
  RecoveryScheduler,
  SpectrumActivationStatus,
  SpectrumExitedEvent,
  SpectrumStartedEvent,
} from "./activation-state.js";
import type {
  SpectrumRunFactory,
  SpectrumRunHandle,
  SpectrumStopReason,
} from "./spectrum-run-handle.js";

const DEFAULT_RECOVERY_BACKOFF_MS = [1_000, 5_000, 15_000] as const;

export interface ActivationCoordinatorOptions {
  spectrumRunFactory: SpectrumRunFactory;
  readinessSink: ActivationReadinessSink;
  recoveryScheduler: RecoveryScheduler;
  recoveryBackoffMs?: readonly number[];
}

/**
 * Owns the single Spectrum run allowed for one deployment.
 *
 * Provider promises feed their results back through dispatch(), so snapshot
 * changes can be processed while a start is still pending. Every state change,
 * stop, and recovery decision is nevertheless ordered on one operation chain.
 */
export class ActivationCoordinator {
  readonly #spectrumRunFactory: SpectrumRunFactory;
  readonly #readinessSink: ActivationReadinessSink;
  readonly #recoveryScheduler: RecoveryScheduler;
  readonly #recoveryBackoffMs: readonly number[];

  #startupCompleted = false;
  #owner: OwnerActivationSnapshot = { configured: false };
  #photon: PhotonActivationSnapshot = {
    connected: false,
    ownerRevisionCurrent: false,
  };
  #codex: CodexActivationSnapshot = {
    auth: "missing",
    capabilities: "unavailable",
  };
  #shutdownRequested = false;
  #state: ActivationState = "initializing";
  #activeRun: SpectrumRunHandle | undefined;
  #pendingStartId: number | undefined;
  #nextStartId = 0;
  #scheduledRecoveryId: number | undefined;
  #nextRecoveryId = 0;
  #recoveryAttempt = 0;
  #operationChain: Promise<void> = Promise.resolve();
  #lastPublished: ActivationSnapshot | undefined;

  public constructor(options: ActivationCoordinatorOptions) {
    this.#spectrumRunFactory = options.spectrumRunFactory;
    this.#readinessSink = options.readinessSink;
    this.#recoveryScheduler = options.recoveryScheduler;
    this.#recoveryBackoffMs = [
      ...(options.recoveryBackoffMs ?? DEFAULT_RECOVERY_BACKOFF_MS),
    ];
    if (
      this.#recoveryBackoffMs.some(
        (delayMs) => !Number.isFinite(delayMs) || delayMs < 0,
      )
    ) {
      throw new Error("Recovery backoff delays must be finite and non-negative.");
    }
    this.#publishIfChanged();
  }

  public snapshot(): ActivationSnapshot {
    const blockers = this.#deriveBlockers();
    const shouldRun = blockers.length === 0 && !this.#shutdownRequested;
    return {
      state: this.#state,
      blockers,
      shouldRun,
      ready:
        this.#state === "active" &&
        shouldRun &&
        this.#activeRun !== undefined,
      startupCompleted: this.#startupCompleted,
      ownerConfigured: this.#owner.configured,
      photonConnected: this.#photon.connected,
      photonOwnerRevisionCurrent: this.#photon.ownerRevisionCurrent,
      codexAuth: this.#codex.auth,
      codexCapabilities: this.#codex.capabilities,
      spectrum: this.#spectrumStatus(),
      runId: this.#activeRun?.runId ?? null,
      recoveryAttempt: this.#recoveryAttempt,
      recoveryScheduled: this.#scheduledRecoveryId !== undefined,
      shuttingDown: this.#shutdownRequested,
    };
  }

  public dispatch(event: ActivationEvent): Promise<ActivationSnapshot> {
    const operation = async (): Promise<void> => await this.#process(event);
    const result = this.#operationChain.then(operation, operation);
    this.#operationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result.then(() => this.snapshot());
  }

  /** Waits for events already queued on the serialized operation chain. */
  public async idle(): Promise<void> {
    await Promise.resolve();
    let observed: Promise<void>;
    do {
      observed = this.#operationChain;
      await observed;
      await Promise.resolve();
    } while (observed !== this.#operationChain);
  }

  async #process(event: ActivationEvent): Promise<void> {
    switch (event.type) {
      case "StartupCompleted":
        if (this.#startupCompleted) return;
        this.#startupCompleted = true;
        break;
      case "OwnerSnapshotChanged":
        if (this.#owner.configured === event.snapshot.configured) return;
        this.#owner = { ...event.snapshot };
        break;
      case "PhotonSnapshotChanged":
        if (
          this.#photon.connected === event.snapshot.connected &&
          this.#photon.ownerRevisionCurrent ===
            event.snapshot.ownerRevisionCurrent
        ) {
          return;
        }
        this.#photon = { ...event.snapshot };
        break;
      case "CodexSnapshotChanged":
        if (
          this.#codex.auth === event.snapshot.auth &&
          this.#codex.capabilities === event.snapshot.capabilities
        ) {
          return;
        }
        this.#codex = { ...event.snapshot };
        break;
      case "SpectrumStarted":
        await this.#onSpectrumStarted(event);
        return;
      case "SpectrumExited":
        await this.#onSpectrumExited(event);
        return;
      case "RecoveryTimerFired":
        if (this.#scheduledRecoveryId !== event.recoveryId) return;
        this.#scheduledRecoveryId = undefined;
        await this.#reconcile();
        return;
      case "ShutdownRequested":
        if (this.#shutdownRequested) return;
        this.#shutdownRequested = true;
        break;
    }

    await this.#reconcile();
  }

  async #reconcile(): Promise<void> {
    const blockers = this.#deriveBlockers();

    if (this.#shutdownRequested) {
      this.#cancelRecovery(false);
      if (this.#activeRun !== undefined) {
        await this.#stopOwnedRun("shutdown", "shutting_down");
      }
      this.#setState(
        this.#pendingStartId === undefined ? "stopped" : "shutting_down",
      );
      return;
    }

    if (blockers.length > 0) {
      this.#cancelRecovery(true);
      if (this.#activeRun !== undefined) {
        await this.#stopOwnedRun("prerequisite_lost", "stopping");
      }
      this.#setState(
        this.#pendingStartId === undefined
          ? this.#startupCompleted
            ? "blocked"
            : "initializing"
          : "stopping",
      );
      return;
    }

    if (this.#activeRun !== undefined) {
      this.#setState("active");
      return;
    }
    if (this.#pendingStartId !== undefined) {
      this.#setState("starting");
      return;
    }
    if (this.#scheduledRecoveryId !== undefined) {
      this.#setState("degraded");
      return;
    }

    this.#startSpectrum();
  }

  #startSpectrum(): void {
    const startId = ++this.#nextStartId;
    this.#pendingStartId = startId;
    this.#setState("starting");

    let started: Promise<SpectrumRunHandle>;
    try {
      started = Promise.resolve(this.#spectrumRunFactory.start());
    } catch {
      started = Promise.reject(new Error("Spectrum start failed."));
    }

    void started
      .then(
        async (handle) =>
          await this.dispatch({ type: "SpectrumStarted", startId, handle }),
        async () =>
          await this.dispatch({
            type: "SpectrumExited",
            startId,
            reason: "start_failed",
          }),
      )
      .catch(() => undefined);
  }

  async #onSpectrumStarted(event: SpectrumStartedEvent): Promise<void> {
    if (
      this.#activeRun?.runId === event.handle.runId &&
      this.#pendingStartId !== event.startId
    ) {
      return;
    }
    if (this.#pendingStartId !== event.startId) {
      try {
        await event.handle.stop("stale_start");
      } catch {
        // A stale handle can never become coordinator-owned.
      }
      return;
    }

    this.#pendingStartId = undefined;
    this.#activeRun = event.handle;
    this.#observeRun(event.startId, event.handle);
    await this.#reconcile();
  }

  async #onSpectrumExited(event: SpectrumExitedEvent): Promise<void> {
    if (event.runId === undefined) {
      if (this.#pendingStartId !== event.startId) return;
      this.#pendingStartId = undefined;
    } else {
      if (this.#activeRun?.runId !== event.runId) return;
      this.#activeRun = undefined;
    }

    if (this.#shutdownRequested || this.#deriveBlockers().length > 0) {
      await this.#reconcile();
      return;
    }

    this.#scheduleRecovery();
  }

  #observeRun(startId: number, handle: SpectrumRunHandle): void {
    void handle.done
      .then(
        async (completion) =>
          await this.dispatch({
            type: "SpectrumExited",
            startId,
            runId: handle.runId,
            reason: completion.reason,
          }),
        async () =>
          await this.dispatch({
            type: "SpectrumExited",
            startId,
            runId: handle.runId,
            reason: "restart_exhausted",
          }),
      )
      .catch(() => undefined);
  }

  async #stopOwnedRun(
    reason: SpectrumStopReason,
    transitionState: "stopping" | "shutting_down",
  ): Promise<void> {
    const handle = this.#activeRun;
    if (handle === undefined) return;
    this.#setState(transitionState);
    try {
      await handle.stop(reason);
    } catch {
      // The coordinator relinquishes a failed handle and never exposes raw
      // provider failures through readiness. Production wiring may audit it.
    }
    if (this.#activeRun === handle) {
      this.#activeRun = undefined;
    }
  }

  #scheduleRecovery(): void {
    this.#state = "degraded";
    if (this.#recoveryAttempt >= this.#recoveryBackoffMs.length) {
      this.#publishIfChanged();
      return;
    }

    const recoveryId = ++this.#nextRecoveryId;
    const attempt = this.#recoveryAttempt + 1;
    const delayMs = this.#recoveryBackoffMs[this.#recoveryAttempt] as number;
    this.#recoveryAttempt = attempt;
    this.#scheduledRecoveryId = recoveryId;
    try {
      this.#recoveryScheduler.schedule({
        recoveryId,
        attempt,
        delayMs,
        fire: () => {
          void this.dispatch({ type: "RecoveryTimerFired", recoveryId }).catch(
            () => undefined,
          );
        },
      });
    } catch {
      this.#scheduledRecoveryId = undefined;
    }
    this.#publishIfChanged();
  }

  #cancelRecovery(resetAttempts: boolean): void {
    if (this.#scheduledRecoveryId !== undefined) {
      this.#scheduledRecoveryId = undefined;
      try {
        this.#recoveryScheduler.cancel();
      } catch {
        // Cancellation is idempotent; the recovery ID still rejects late fires.
      }
    }
    if (resetAttempts) this.#recoveryAttempt = 0;
  }

  #deriveBlockers(): ActivationBlocker[] {
    const blockers: ActivationBlocker[] = [];
    if (!this.#startupCompleted) blockers.push("startup_incomplete");
    if (!this.#owner.configured) blockers.push("owner_not_configured");
    if (!this.#photon.connected) {
      blockers.push("photon_not_connected");
    } else if (!this.#photon.ownerRevisionCurrent) {
      blockers.push("photon_owner_revision_stale");
    }
    if (this.#codex.auth === "missing") {
      blockers.push("codex_auth_missing");
    } else if (this.#codex.auth === "failed") {
      blockers.push("codex_auth_failed");
    } else if (this.#codex.capabilities !== "available") {
      blockers.push("codex_capabilities_unavailable");
    }
    return blockers;
  }

  #spectrumStatus(): SpectrumActivationStatus {
    switch (this.#state) {
      case "starting":
        return "starting";
      case "active":
        return "active";
      case "stopping":
      case "shutting_down":
        return "stopping";
      case "degraded":
        return "degraded";
      case "initializing":
      case "blocked":
      case "stopped":
        return "stopped";
    }
  }

  #setState(state: ActivationState): void {
    this.#state = state;
    this.#publishIfChanged();
  }

  #publishIfChanged(): void {
    const snapshot = this.snapshot();
    if (
      this.#lastPublished !== undefined &&
      JSON.stringify(this.#lastPublished) === JSON.stringify(snapshot)
    ) {
      return;
    }
    this.#lastPublished = snapshot;
    this.#readinessSink.publish(snapshot);
  }
}
