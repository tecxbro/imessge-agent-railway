import {
  ReadinessRegistry,
  SpectrumReadiness,
  type ReadinessState,
} from "./http/readiness.js";
import type { ChatGptSetupController } from "./agent/codex-app-server-auth.js";
import { startHealthServer, type HealthServer } from "./http/server.js";
import type { ModelSettingsController } from "./http/server.js";
import type { DeploymentPageOptions } from "./http/deployment-page.js";
import type {
  DeploymentIdentityController,
  DeploymentIdentityStatus,
} from "./runtime/deployment-identity.js";
import type { PhotonSetupController } from "./transport/photon-setup.js";
import {
  GracefulShutdown,
  installShutdownSignals,
  type ShutdownResult,
} from "./runtime/graceful-shutdown.js";
import { ActivationCoordinator } from "./runtime/activation-coordinator.js";
import type {
  CodexActivationSnapshot,
  PhotonActivationSnapshot,
  RecoverySchedule,
} from "./runtime/activation-state.js";
import type { SpectrumRunHandle } from "./runtime/spectrum-run-handle.js";

export interface CodexStartupState {
  auth: Extract<ReadinessState, "ok" | "missing" | "failed">;
  capabilities: Extract<ReadinessState, "ok" | "unknown" | "failed">;
  authCode?: "CODEX_AUTH_MISSING" | "CODEX_AUTH_EXPIRED";
  capabilityCode?: "CODEX_CAPABILITY_FAILED";
}

export interface AgentServiceBootstrap {
  prepareConfiguration(): Promise<void>;
  prepareStorage(): Promise<void>;
  connectDatabase(): Promise<void>;
  applyMigrations(): Promise<void>;
  initializeDeploymentIdentity?(): Promise<{
    status: DeploymentIdentityStatus;
    migrationRequired: boolean;
  }>;
  startQueue(): Promise<void>;
  checkCodex(): Promise<CodexStartupState>;
  configureSupermemory(): Promise<
    Extract<ReadinessState, "ok" | "disabled" | "degraded" | "failed">
  >;
  startSpectrum?(input: {
    signal: AbortSignal;
    readiness: SpectrumReadiness;
  }): Promise<void>;
  startSpectrumRun?(): Promise<SpectrumRunHandle>;
  onCodexActivationChanged?(
    listener: (snapshot: CodexActivationSnapshot) => void | Promise<void>,
  ): () => void;
  onPhotonActivationChanged?(
    listener: (snapshot: PhotonActivationSnapshot) => void | Promise<void>,
  ): () => void;
  stopSpectrum?(): Promise<void>;
  stopCodex?(): Promise<void>;
  checkpointOutbound?(): Promise<void>;
  stopQueue?(): Promise<void>;
  closeDatabase?(): Promise<void>;
}

export interface RunningAgentService {
  readiness: ReadinessRegistry;
  spectrumReadiness: SpectrumReadiness;
  health: HealthServer;
  shutdown(reason?: NodeJS.Signals | "test"): Promise<ShutdownResult>;
}

export interface StartAgentServiceOptions {
  port: number;
  host?: string;
  bootstrap: AgentServiceBootstrap;
  deploymentIdentity?: DeploymentIdentityController;
  deploymentPage?: Omit<DeploymentPageOptions, "runtimeMode">;
  photonSetup?: PhotonSetupController;
  chatgptSetup?: ChatGptSetupController;
  modelSettings?: ModelSettingsController;
  installSignalHandlers?: boolean;
  onStartupFailure?: (code: string) => void;
}

class StartupStageError extends Error {
  public constructor(public readonly code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "StartupStageError";
  }
}

async function runStartupStage(
  code: string,
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    throw new StartupStageError(code, { cause: error });
  }
}

/**
 * Owns provider-neutral boot and shutdown ordering.
 *
 * HTTP starts first so `/healthz` remains available while private dependencies
 * initialize. Spectrum starts only after Codex authentication and capability
 * checks pass. Shutdown hooks are registered in reverse dependency order so
 * intake and active work stop before queues, PostgreSQL, and HTTP close.
 */
export async function startAgentService(
  options: StartAgentServiceOptions,
): Promise<RunningAgentService> {
  const readiness = new ReadinessRegistry();
  const spectrumReadiness = new SpectrumReadiness();
  const shutdown = new GracefulShutdown(readiness);
  const health = await startHealthServer({
    port: options.port,
    ...(options.host === undefined ? {} : { host: options.host }),
    readiness,
    spectrum: spectrumReadiness,
    ...(options.deploymentIdentity === undefined
      ? {}
      : { deploymentIdentity: options.deploymentIdentity }),
    deploymentPage: {
      ...(options.deploymentPage ?? {
        authMode: "chatgpt",
        supermemoryConfigured: false,
      }),
      runtimeMode: "agent",
    },
    ...(options.photonSetup === undefined
      ? {}
      : { photonSetup: options.photonSetup }),
    ...(options.chatgptSetup === undefined
      ? {}
      : { chatgptSetup: options.chatgptSetup }),
    ...(options.modelSettings === undefined
      ? {}
      : { modelSettings: options.modelSettings }),
  });

  shutdown.register({
    name: "health-http",
    priority: 60,
    timeoutMs: 10_000,
    stop: () => health.close(),
  });

  let recoveryTimer: NodeJS.Timeout | undefined;
  const recoveryScheduler = {
    schedule(recovery: RecoverySchedule): void {
      if (recoveryTimer !== undefined) clearTimeout(recoveryTimer);
      recoveryTimer = setTimeout(recovery.fire, recovery.delayMs);
    },
    cancel(): void {
      if (recoveryTimer !== undefined) clearTimeout(recoveryTimer);
      recoveryTimer = undefined;
    },
  };

  const startLegacySpectrum = async (): Promise<SpectrumRunHandle> => {
    if (options.bootstrap.startSpectrum === undefined) {
      throw new Error("No Spectrum run factory is configured.");
    }
    const controller = new AbortController();
    const abortForShutdown = () => controller.abort(shutdown.signal.reason);
    shutdown.signal.addEventListener("abort", abortForShutdown, { once: true });
    const runId = `legacy-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await options.bootstrap.startSpectrum({
      signal: controller.signal,
      readiness: spectrumReadiness,
    });
    let finish!: (completion: { reason: "exited" }) => void;
    const done = new Promise<{ reason: "exited" }>((resolve) => {
      finish = resolve;
    });
    return {
      runId,
      done,
      async stop() {
        controller.abort();
        await options.bootstrap.stopSpectrum?.();
        shutdown.signal.removeEventListener("abort", abortForShutdown);
        finish({ reason: "exited" });
      },
    };
  };

  const activation = new ActivationCoordinator({
    spectrumRunFactory: {
      start: async () =>
        options.bootstrap.startSpectrumRun === undefined
          ? await startLegacySpectrum()
          : await options.bootstrap.startSpectrumRun(),
    },
    recoveryScheduler,
    readinessSink: {
      publish(snapshot) {
        if (snapshot.spectrum === "active") {
          spectrumReadiness.markConnected();
        } else if (snapshot.spectrum === "starting") {
          spectrumReadiness.markStarting();
        } else if (snapshot.spectrum === "degraded") {
          spectrumReadiness.markDegraded(
            "SPECTRUM_STREAM_RESTART_EXHAUSTED",
            snapshot.recoveryAttempt,
          );
          if (snapshot.recoveryAttempt === 1) {
            options.onStartupFailure?.("SPECTRUM_START_FAILED");
          }
        } else {
          spectrumReadiness.markStopped();
        }
      },
    },
  });

  const refreshCodexReadiness = async (): Promise<CodexActivationSnapshot> => {
    readiness.mark("codexAuth", "starting");
    readiness.mark("codexCapabilities", "starting");
    let codex: CodexStartupState;
    try {
      codex = await options.bootstrap.checkCodex();
    } catch {
      readiness.mark("codexAuth", "failed", "CODEX_AUTH_EXPIRED");
      readiness.mark(
        "codexCapabilities",
        "failed",
        "CODEX_CAPABILITY_FAILED",
      );
      options.onStartupFailure?.("CODEX_CHECK_FAILED");
      const snapshot: CodexActivationSnapshot = {
        auth: "failed",
        capabilities: "unavailable",
      };
      await activation.dispatch({ type: "CodexSnapshotChanged", snapshot });
      return snapshot;
    }
    readiness.mark("codexAuth", codex.auth, codex.authCode);
    readiness.mark(
      "codexCapabilities",
      codex.capabilities,
      codex.capabilityCode,
    );
    const snapshot: CodexActivationSnapshot = {
      auth:
        codex.auth === "ok"
          ? "ready"
          : codex.auth === "missing"
            ? "missing"
            : "failed",
      capabilities:
        codex.capabilities === "ok" ? "available" : "unavailable",
    };
    await activation.dispatch({ type: "CodexSnapshotChanged", snapshot });
    return snapshot;
  };

  const disposeIdentityListener = options.deploymentIdentity?.onConfigured(
    async () => {
      readiness.mark("ownerIdentity", "ok");
      await activation.dispatch({
        type: "OwnerSnapshotChanged",
        snapshot: { configured: true },
      });
    },
  );
  if (disposeIdentityListener !== undefined) {
    shutdown.register({
      name: "deployment-identity-listener",
      priority: 5,
      timeoutMs: 1_000,
      stop: async () => {
        disposeIdentityListener();
      },
    });
  }
  const disposePhotonListener =
    options.bootstrap.onPhotonActivationChanged?.(async (snapshot) => {
      await activation.dispatch({ type: "PhotonSnapshotChanged", snapshot });
    }) ??
    options.photonSetup?.onConnected?.(async () => {
      await activation.dispatch({
        type: "PhotonSnapshotChanged",
        snapshot: { connected: true, ownerRevisionCurrent: true },
      });
    });
  options.chatgptSetup?.onConnected(async () => {
    await refreshCodexReadiness();
  });
  const disposeCodexListener = options.bootstrap.onCodexActivationChanged?.(
    async (snapshot) => {
      await activation.dispatch({ type: "CodexSnapshotChanged", snapshot });
    },
  );
  for (const [name, dispose] of [
    ["photon-activation-listener", disposePhotonListener],
    ["codex-activation-listener", disposeCodexListener],
  ] as const) {
    if (dispose === undefined) continue;
    shutdown.register({
      name,
      priority: 5,
      timeoutMs: 1_000,
      stop: async () => dispose(),
    });
  }

  try {
    readiness.mark("configuration", "starting");
    await runStartupStage(
      "CONFIGURATION_INVALID",
      options.bootstrap.prepareConfiguration,
    );
    readiness.mark("configuration", "ok");

    readiness.mark("disk", "starting");
    readiness.mark("workspace", "starting");
    await runStartupStage(
      "PERSISTENT_STORAGE_INVALID",
      options.bootstrap.prepareStorage,
    );
    readiness.mark("disk", "ok");
    readiness.mark("workspace", "ok");
    if (options.bootstrap.stopCodex !== undefined) {
      shutdown.register({
        name: "codex",
        priority: 20,
        timeoutMs: 15_000,
        stop: options.bootstrap.stopCodex,
      });
    }

    readiness.mark("database", "starting");
    await runStartupStage(
      "DATABASE_UNAVAILABLE",
      options.bootstrap.connectDatabase,
    );
    readiness.mark("database", "ok");
    if (options.bootstrap.closeDatabase !== undefined) {
      shutdown.register({
        name: "database",
        priority: 50,
        timeoutMs: 15_000,
        stop: options.bootstrap.closeDatabase,
      });
    }

    readiness.mark("migrations", "starting");
    await runStartupStage(
      "MIGRATIONS_PENDING",
      options.bootstrap.applyMigrations,
    );
    readiness.mark("migrations", "ok");

    readiness.mark("ownerIdentity", "starting");
    if (options.bootstrap.initializeDeploymentIdentity === undefined) {
      readiness.mark("ownerIdentity", "ok");
    } else {
      let identityInitialization: Awaited<
        ReturnType<
          NonNullable<
            AgentServiceBootstrap["initializeDeploymentIdentity"]
          >
        >
      >;
      try {
        identityInitialization =
          await options.bootstrap.initializeDeploymentIdentity();
      } catch (error) {
        throw new StartupStageError("OWNER_IDENTITY_STORAGE_FAILED", {
          cause: error,
        });
      }
      if (identityInitialization.migrationRequired) {
        readiness.mark(
          "ownerIdentity",
          "failed",
          "OWNER_IDENTITY_MIGRATION_REQUIRED",
        );
      } else if (identityInitialization.status.state === "configured") {
        readiness.mark("ownerIdentity", "ok");
      } else if (
        identityInitialization.status.state === "not_configured"
      ) {
        readiness.mark(
          "ownerIdentity",
          "missing",
          "OWNER_IDENTITY_NOT_CONFIGURED",
        );
      } else if (identityInitialization.status.state === "failed") {
        readiness.mark(
          "ownerIdentity",
          "failed",
          identityInitialization.status.code,
        );
      }
    }

    await activation.dispatch({
      type: "OwnerSnapshotChanged",
      snapshot: {
        configured:
          options.deploymentIdentity === undefined ||
          options.deploymentIdentity.status().state === "configured",
      },
    });

    readiness.mark("queue", "starting");
    await runStartupStage("QUEUE_UNAVAILABLE", options.bootstrap.startQueue);
    readiness.mark("queue", "ok");
    if (options.bootstrap.stopQueue !== undefined) {
      shutdown.register({
        name: "queue",
        priority: 40,
        timeoutMs: 30_000,
        stop: options.bootstrap.stopQueue,
      });
    }
    if (options.bootstrap.checkpointOutbound !== undefined) {
      shutdown.register({
        name: "outbound-checkpoint",
        priority: 30,
        timeoutMs: 25_000,
        stop: options.bootstrap.checkpointOutbound,
      });
    }
    await refreshCodexReadiness();
    await activation.dispatch({
      type: "PhotonSnapshotChanged",
      snapshot: {
        connected:
          options.photonSetup === undefined ||
          options.photonSetup.status().state === "connected",
        ownerRevisionCurrent:
          options.photonSetup === undefined ||
          options.photonSetup.status().state === "connected",
      },
    });
    shutdown.register({
      name: "spectrum-activation",
      priority: 10,
      timeoutMs: 10_000,
      stop: async () => {
        await activation.dispatch({ type: "ShutdownRequested" });
        await activation.idle();
      },
    });

    const memoryState = await options.bootstrap.configureSupermemory();
    readiness.mark(
      "supermemory",
      memoryState,
      memoryState === "failed" ? "SUPERMEMORY_CONFIGURATION_INVALID" : undefined,
    );
    await activation.dispatch({ type: "StartupCompleted" });
    await activation.idle();
  } catch (error) {
    const code =
      error instanceof StartupStageError ? error.code : "STARTUP_FAILED";
    if (code === "CONFIGURATION_INVALID") {
      readiness.mark("configuration", "failed", code);
    } else if (code === "PERSISTENT_STORAGE_INVALID") {
      readiness.mark("disk", "failed", code);
      readiness.mark("workspace", "failed", code);
    } else if (code === "DATABASE_UNAVAILABLE") {
      readiness.mark("database", "failed", code);
    } else if (code === "MIGRATIONS_PENDING") {
      readiness.mark("migrations", "failed", code);
    } else if (code === "OWNER_IDENTITY_STORAGE_FAILED") {
      readiness.mark("ownerIdentity", "failed", code);
    } else if (code === "QUEUE_UNAVAILABLE") {
      readiness.mark("queue", "failed", code);
    } else if (code === "SPECTRUM_START_FAILED") {
      spectrumReadiness.markDegraded("SPECTRUM_STREAM_DISCONNECTED", 1);
    }
    options.onStartupFailure?.(code);
  }

  if (options.installSignalHandlers ?? true) {
    installShutdownSignals({ shutdown });
  }

  return {
    readiness,
    spectrumReadiness,
    health,
    shutdown: (reason) => shutdown.shutdown(reason),
  };
}
