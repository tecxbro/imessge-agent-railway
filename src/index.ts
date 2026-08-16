import {
  ReadinessRegistry,
  SpectrumReadiness,
  type ReadinessState,
} from "./http/readiness.js";
import type { ChatGptSetupController } from "./agent/codex-app-server-auth.js";
import { startHealthServer, type HealthServer } from "./http/server.js";
import type { DeploymentPageOptions } from "./http/deployment-page.js";
import type { PhotonSetupController } from "./transport/photon-setup.js";
import {
  GracefulShutdown,
  installShutdownSignals,
  type ShutdownResult,
} from "./runtime/graceful-shutdown.js";

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
  startQueue(): Promise<void>;
  checkCodex(): Promise<CodexStartupState>;
  configureSupermemory(): Promise<
    Extract<ReadinessState, "ok" | "disabled" | "degraded" | "failed">
  >;
  startSpectrum(input: {
    signal: AbortSignal;
    readiness: SpectrumReadiness;
  }): Promise<void>;
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
  deploymentPage?: Omit<DeploymentPageOptions, "runtimeMode">;
  photonSetup?: PhotonSetupController;
  chatgptSetup?: ChatGptSetupController;
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
  });

  shutdown.register({
    name: "health-http",
    priority: 60,
    timeoutMs: 10_000,
    stop: () => health.close(),
  });

  let startupStagesReady = false;
  let codexChecked = false;
  let codexReady = false;
  let spectrumStarted = false;
  let unlockAgain = false;
  let forceCodexProbe = false;
  let unlockPromise: Promise<void> | undefined;

  const photonConnected = (): boolean =>
    options.photonSetup === undefined ||
    options.photonSetup.status().state === "connected";

  const refreshCodexReadiness = async (): Promise<boolean> => {
    codexChecked = true;
    readiness.mark("codexAuth", "starting");
    readiness.mark("codexCapabilities", "starting");
    let codex: CodexStartupState;
    try {
      codex = await options.bootstrap.checkCodex();
    } catch {
      codexReady = false;
      readiness.mark("codexAuth", "failed", "CODEX_AUTH_EXPIRED");
      readiness.mark(
        "codexCapabilities",
        "failed",
        "CODEX_CAPABILITY_FAILED",
      );
      options.onStartupFailure?.("CODEX_CHECK_FAILED");
      spectrumReadiness.markStopped();
      return false;
    }
    readiness.mark("codexAuth", codex.auth, codex.authCode);
    readiness.mark(
      "codexCapabilities",
      codex.capabilities,
      codex.capabilityCode,
    );
    codexReady = codex.auth === "ok" && codex.capabilities === "ok";
    return codexReady;
  };

  const tryUnlockAgent = async (forceProbe: boolean): Promise<void> => {
    if (!startupStagesReady || shutdown.signal.aborted || spectrumStarted) {
      return;
    }

    if (forceProbe || !codexChecked) {
      if (!(await refreshCodexReadiness())) {
        return;
      }
    }

    if (!codexReady || !photonConnected() || shutdown.signal.aborted) {
      spectrumReadiness.markStopped();
      return;
    }

    spectrumStarted = true;
    spectrumReadiness.markStarting();
    try {
      await options.bootstrap.startSpectrum({
        signal: shutdown.signal,
        readiness: spectrumReadiness,
      });
    } catch {
      spectrumStarted = false;
      spectrumReadiness.markDegraded("SPECTRUM_STREAM_DISCONNECTED", 1);
      options.onStartupFailure?.("SPECTRUM_START_FAILED");
    }
  };

  const requestUnlock = (forceProbe: boolean): Promise<void> => {
    unlockAgain = true;
    forceCodexProbe ||= forceProbe;
    unlockPromise ??= (async () => {
      while (unlockAgain && !shutdown.signal.aborted) {
        const probe = forceCodexProbe;
        unlockAgain = false;
        forceCodexProbe = false;
        await tryUnlockAgent(probe);
      }
    })().finally(() => {
      unlockPromise = undefined;
    });
    return unlockPromise;
  };

  options.photonSetup?.onConnected?.(() => requestUnlock(false));
  options.chatgptSetup?.onConnected(() => requestUnlock(true));

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
    if (options.bootstrap.stopSpectrum !== undefined) {
      shutdown.register({
        name: "spectrum",
        priority: 10,
        timeoutMs: 10_000,
        stop: options.bootstrap.stopSpectrum,
      });
    }

    const memoryState = await options.bootstrap.configureSupermemory();
    readiness.mark(
      "supermemory",
      memoryState,
      memoryState === "failed" ? "SUPERMEMORY_CONFIGURATION_INVALID" : undefined,
    );
    startupStagesReady = true;
    await requestUnlock(
      options.chatgptSetup?.status().state === "connected" && !codexReady,
    );
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
