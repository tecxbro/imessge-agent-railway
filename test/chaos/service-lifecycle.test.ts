import { type AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatGptSetupController } from "../../src/agent/codex-app-server-auth.js";
import type {
  DeploymentIdentityController,
  DeploymentIdentityStatus,
} from "../../src/runtime/deployment-identity.js";
import {
  startAgentService,
  type AgentServiceBootstrap,
  type RunningAgentService,
} from "../../src/index.js";
import { runSpectrumMessageLoop } from "../../src/transport/message-loop.js";
import type {
  PhotonSetupController,
  PhotonSetupStatus,
} from "../../src/transport/photon-setup.js";

const runningServices: RunningAgentService[] = [];
const chatGptCapabilityMethods = {
  capabilities: () => ({
    state: "unavailable" as const,
    planType: null,
    models: [],
    refreshedAt: null,
  }),
  refreshCapabilities: async () => ({
    state: "unavailable" as const,
    planType: null,
    models: [],
    refreshedAt: null,
  }),
  onCapabilitiesChanged: () => () => undefined,
};
afterEach(async () => {
  await Promise.all(
    runningServices.splice(0).map(async (service) => service.shutdown("test")),
  );
});

async function fetchReadiness(service: RunningAgentService): Promise<{
  status: number;
  body: {
    ready: boolean;
    status: "ready" | "not_ready";
  };
}> {
  const address = service.health.server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${address.port}/readyz`);
  return {
    status: response.status,
    body: (await response.json()) as {
      ready: boolean;
      status: "ready" | "not_ready";
    },
  };
}

describe("composed service lifecycle recovery", () => {
  it("boots in dependency order and gracefully checkpoints before durable resources close", async () => {
    const events: string[] = [];
    const stage = (name: string) => async (): Promise<void> => {
      events.push(name);
    };
    const bootstrap: AgentServiceBootstrap = {
      prepareConfiguration: stage("start:configuration"),
      prepareStorage: stage("start:storage"),
      connectDatabase: stage("start:database"),
      applyMigrations: stage("start:migrations"),
      startQueue: stage("start:queue"),
      checkCodex: async () => {
        events.push("start:codex");
        return { auth: "ok", capabilities: "ok" };
      },
      configureSupermemory: async () => {
        events.push("start:supermemory");
        return "disabled";
      },
      startSpectrum: async ({ signal, readiness }) => {
        events.push("start:spectrum");
        signal.addEventListener(
          "abort",
          () => events.push("stop:abort-active-work"),
          { once: true },
        );
        readiness.markConnected();
      },
      stopSpectrum: stage("stop:spectrum"),
      stopCodex: stage("stop:codex"),
      checkpointOutbound: stage("stop:outbound-checkpoint"),
      stopQueue: stage("stop:queue"),
      closeDatabase: stage("stop:database"),
    };

    const service = await startAgentService({
      port: 0,
      host: "127.0.0.1",
      bootstrap,
      installSignalHandlers: false,
    });
    runningServices.push(service);

    expect(events).toEqual([
      "start:configuration",
      "start:storage",
      "start:database",
      "start:migrations",
      "start:queue",
      "start:codex",
      "start:supermemory",
      "start:spectrum",
    ]);
    await expect(fetchReadiness(service)).resolves.toMatchObject({
      status: 200,
      body: { ready: true, status: "ready" },
    });

    await expect(service.shutdown("SIGTERM")).resolves.toEqual({
      clean: true,
      failures: [],
    });
    expect(events.slice(8)).toEqual([
      "stop:abort-active-work",
      "stop:spectrum",
      "stop:codex",
      "stop:outbound-checkpoint",
      "stop:queue",
      "stop:database",
    ]);
    expect(service.readiness.snapshot(service.spectrumReadiness.snapshot())).toMatchObject(
      {
        ready: false,
        shuttingDown: true,
      },
    );
    expect(service.health.server.listening).toBe(false);
  });

  it("surfaces a Spectrum disconnect without leaking the provider error", async () => {
    const startupFailure = vi.fn<(code: string) => void>();
    const stopQueue = vi.fn(async () => undefined);
    const closeDatabase = vi.fn(async () => undefined);
    const providerError =
      "Spectrum rejected project secret photon-super-secret for +15555550123";
    async function* disconnectedStream(): AsyncGenerator<never, void, unknown> {
      throw new Error(providerError);
    }

    const service = await startAgentService({
      port: 0,
      host: "127.0.0.1",
      installSignalHandlers: false,
      onStartupFailure: startupFailure,
      bootstrap: {
        prepareConfiguration: async () => undefined,
        prepareStorage: async () => undefined,
        connectDatabase: async () => undefined,
        applyMigrations: async () => undefined,
        startQueue: async () => undefined,
        checkCodex: async () => ({ auth: "ok", capabilities: "ok" }),
        configureSupermemory: async () => "disabled",
        startSpectrum: async ({ signal, readiness }) =>
          runSpectrumMessageLoop({
            authorizeAndIngest: {
              authorizeAndIngest: async () => "accepted",
            },
            messages: disconnectedStream,
            readiness,
            restartPolicy: {
              maxRestarts: 0,
              initialDelayMs: 1,
              maximumDelayMs: 1,
            },
            signal,
          }),
        stopQueue,
        closeDatabase,
      },
    });
    runningServices.push(service);

    expect(startupFailure).toHaveBeenCalledWith("SPECTRUM_START_FAILED");
    const readiness = await fetchReadiness(service);
    expect(readiness.status).toBe(503);
    expect(readiness.body).toMatchObject({ status: "not_ready", ready: false });
    const internalReadiness = service.readiness.snapshot(
      service.spectrumReadiness.snapshot(),
    );
    expect(internalReadiness).toMatchObject({
      components: {
        spectrum: {
          code: "SPECTRUM_STREAM_RESTART_EXHAUSTED",
          state: "degraded",
        },
      },
    });
    expect(internalReadiness.actions).toEqual([
      expect.stringContaining("Photon connectivity"),
    ]);
    expect(JSON.stringify(readiness.body)).not.toContain("photon-super-secret");
    expect(JSON.stringify(readiness.body)).not.toContain("+15555550123");

    await service.shutdown("test");
    expect(stopQueue).toHaveBeenCalledOnce();
    expect(closeDatabase).toHaveBeenCalledOnce();
  });

  it("pauses Spectrum startup and gives operator remediation when Codex auth expires", async () => {
    const startSpectrum = vi.fn(async () => undefined);
    const service = await startAgentService({
      port: 0,
      host: "127.0.0.1",
      installSignalHandlers: false,
      bootstrap: {
        prepareConfiguration: async () => undefined,
        prepareStorage: async () => undefined,
        connectDatabase: async () => undefined,
        applyMigrations: async () => undefined,
        startQueue: async () => undefined,
        checkCodex: async () => ({
          auth: "failed",
          capabilities: "unknown",
          authCode: "CODEX_AUTH_EXPIRED",
        }),
        configureSupermemory: async () => "disabled",
        startSpectrum,
      },
    });
    runningServices.push(service);

    expect(startSpectrum).not.toHaveBeenCalled();
    const address = service.health.server.address() as AddressInfo;
    const live = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    expect(live.status).toBe(200);
    const readiness = await fetchReadiness(service);
    expect(readiness.status).toBe(503);
    expect(readiness.body).toMatchObject({ status: "not_ready", ready: false });
    const internalReadiness = service.readiness.snapshot(
      service.spectrumReadiness.snapshot(),
    );
    expect(internalReadiness).toMatchObject({
      components: {
        codexAuth: { code: "CODEX_AUTH_EXPIRED", state: "failed" },
        codexCapabilities: { state: "unknown" },
        spectrum: { state: "missing" },
      },
    });
    expect(internalReadiness.actions).toEqual([
      expect.stringContaining("reconnect ChatGPT"),
    ]);
  });

  it("keeps intake and readiness closed until owner setup and disposes its listener", async () => {
    let identityStatus: DeploymentIdentityStatus = {
      state: "not_configured",
    };
    let configuredListener: (() => void | Promise<void>) | undefined;
    let listenerDisposed = false;
    const deploymentIdentity: DeploymentIdentityController = {
      initialize: async () => identityStatus,
      status: () => ({ ...identityStatus }),
      configureOwner: async () => {
        identityStatus = {
          state: "configured",
          maskedPhoneNumber: "••••••0123",
        };
        await configuredListener?.();
        return identityStatus;
      },
      readOwnerPhoneNumber: async () =>
        identityStatus.state === "configured" ? "+14155550123" : undefined,
      onConfigured(listener) {
        configuredListener = listener;
        return () => {
          listenerDisposed = true;
          configuredListener = undefined;
        };
      },
    };
    const photonSetup = {
      status: () => ({ state: "connected" as const }),
      start: async () => ({ state: "connected" as const }),
    } satisfies PhotonSetupController;
    const startSpectrum = vi.fn(async ({ readiness }) => {
      readiness.markConnected();
    });
    const service = await startAgentService({
      port: 0,
      host: "127.0.0.1",
      installSignalHandlers: false,
      deploymentIdentity,
      photonSetup,
      bootstrap: {
        prepareConfiguration: async () => undefined,
        prepareStorage: async () => undefined,
        connectDatabase: async () => undefined,
        applyMigrations: async () => undefined,
        initializeDeploymentIdentity: async () => ({
          status: identityStatus,
          migrationRequired: false,
        }),
        startQueue: async () => undefined,
        checkCodex: async () => ({ auth: "ok", capabilities: "ok" }),
        configureSupermemory: async () => "disabled",
        startSpectrum,
      },
    });
    runningServices.push(service);

    expect(startSpectrum).not.toHaveBeenCalled();
    await expect(fetchReadiness(service)).resolves.toMatchObject({
      status: 503,
      body: { ready: false },
    });
    expect(
      service.readiness.snapshot(service.spectrumReadiness.snapshot()),
    ).toMatchObject({
      components: {
        ownerIdentity: {
          state: "missing",
          code: "OWNER_IDENTITY_NOT_CONFIGURED",
        },
        spectrum: { state: "missing" },
      },
    });
    const address = service.health.server.address() as AddressInfo;
    const live = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    expect(live.status).toBe(200);

    await deploymentIdentity.configureOwner("+14155550123");
    expect(startSpectrum).toHaveBeenCalledOnce();
    await expect(fetchReadiness(service)).resolves.toMatchObject({
      status: 200,
      body: { ready: true },
    });

    await service.shutdown("test");
    expect(listenerDisposed).toBe(true);
  });

  it("keeps intake off until Photon and ChatGPT are both connected, then unlocks exactly once", async () => {
    let photonStatus: PhotonSetupStatus = { state: "not_connected" };
    let photonListener: (() => void | Promise<void>) | undefined;
    const photonSetup = {
      status: () => photonStatus,
      start: async () => photonStatus,
      onConnected: (listener) => {
        photonListener = () => listener({
          photonDeviceBearerToken: "fixture-token",
          photonProjectId: "fixture-project",
          spectrumProjectSecret: "fixture-secret",
          ownerPhoneNumber: "+16285550100",
          assignedIMessageNumber: "+16285550123",
        });
        return () => {
          photonListener = undefined;
        };
      },
    } satisfies PhotonSetupController;

    let chatGptConnected = false;
    let chatGptListener: (() => void | Promise<void>) | undefined;
    const chatgptSetup = {
      ...chatGptCapabilityMethods,
      initialize: async () => ({ state: "not_connected" as const }),
      status: () =>
        chatGptConnected
          ? ({ state: "connected" } as const)
          : ({ state: "not_connected" } as const),
      start: async () => ({ state: "not_connected" as const }),
      onConnected: (listener) => {
        chatGptListener = listener;
        return () => {
          chatGptListener = undefined;
        };
      },
      close: async () => undefined,
    } satisfies ChatGptSetupController;

    const startSpectrum = vi.fn(async ({ readiness }) => {
      readiness.markConnected();
    });
    const checkCodex = vi.fn(async () =>
      chatGptConnected
        ? ({ auth: "ok", capabilities: "ok" } as const)
        : ({
            auth: "missing",
            capabilities: "unknown",
            authCode: "CODEX_AUTH_MISSING",
          } as const),
    );
    const service = await startAgentService({
      port: 0,
      host: "127.0.0.1",
      installSignalHandlers: false,
      photonSetup,
      chatgptSetup,
      bootstrap: {
        prepareConfiguration: async () => undefined,
        prepareStorage: async () => undefined,
        connectDatabase: async () => undefined,
        applyMigrations: async () => undefined,
        startQueue: async () => undefined,
        checkCodex,
        configureSupermemory: async () => "disabled",
        startSpectrum,
      },
    });
    runningServices.push(service);

    expect(startSpectrum).not.toHaveBeenCalled();
    await expect(fetchReadiness(service)).resolves.toMatchObject({
      status: 503,
      body: { ready: false },
    });

    photonStatus = {
      state: "connected",
      assignedPhoneNumber: "+16285550123",
    };
    await photonListener?.();
    expect(startSpectrum).not.toHaveBeenCalled();

    chatGptConnected = true;
    await chatGptListener?.();
    expect(checkCodex).toHaveBeenCalledTimes(2);
    expect(startSpectrum).toHaveBeenCalledOnce();
    await expect(fetchReadiness(service)).resolves.toMatchObject({
      status: 200,
      body: {
        ready: true,
        status: "ready",
      },
    });
    expect(
      service.readiness.snapshot(service.spectrumReadiness.snapshot()),
    ).toMatchObject({
      components: {
        codexAuth: { state: "ok" },
        codexCapabilities: { state: "ok" },
        spectrum: { state: "ok" },
      },
    });

    await chatGptListener?.();
    await photonListener?.();
    expect(startSpectrum).toHaveBeenCalledOnce();
  });

  it("preserves ChatGPT completion that arrives before optional startup stages finish", async () => {
    let connected = false;
    let completion: (() => void | Promise<void>) | undefined;
    const chatgptSetup = {
      ...chatGptCapabilityMethods,
      initialize: async () => ({ state: "not_connected" as const }),
      status: () =>
        connected
          ? ({ state: "connected" } as const)
          : ({ state: "not_connected" } as const),
      start: async () => ({ state: "not_connected" as const }),
      onConnected: (listener) => {
        completion = listener;
        return () => {
          completion = undefined;
        };
      },
      close: async () => undefined,
    } satisfies ChatGptSetupController;
    const photonSetup = {
      status: () => ({ state: "connected" as const }),
      start: async () => ({ state: "connected" as const }),
    } satisfies PhotonSetupController;
    const checkCodex = vi.fn(async () =>
      connected
        ? ({ auth: "ok", capabilities: "ok" } as const)
        : ({
            auth: "missing",
            capabilities: "unknown",
            authCode: "CODEX_AUTH_MISSING",
          } as const),
    );
    const startSpectrum = vi.fn(async ({ readiness }) => {
      readiness.markConnected();
    });

    const service = await startAgentService({
      port: 0,
      host: "127.0.0.1",
      installSignalHandlers: false,
      photonSetup,
      chatgptSetup,
      bootstrap: {
        prepareConfiguration: async () => undefined,
        prepareStorage: async () => undefined,
        connectDatabase: async () => undefined,
        applyMigrations: async () => undefined,
        startQueue: async () => undefined,
        checkCodex,
        configureSupermemory: async () => {
          connected = true;
          await completion?.();
          return "disabled";
        },
        startSpectrum,
      },
    });
    runningServices.push(service);

    expect(checkCodex).toHaveBeenCalledTimes(2);
    expect(startSpectrum).toHaveBeenCalledOnce();
    await expect(fetchReadiness(service)).resolves.toMatchObject({
      status: 200,
      body: { ready: true },
    });
  });

  it("leaves catalog subscription and reconciliation to ModelSettingsService", async () => {
    let capabilitiesListener:
      | Parameters<ChatGptSetupController["onCapabilitiesChanged"]>[0]
      | undefined;
    let listenerDisposed = false;
    const availableCapabilities = () => ({
      state: "available" as const,
      planType: "plus",
      models: [],
      refreshedAt: new Date(),
    });
    const publishCatalogChange = async (): Promise<void> => {
      await capabilitiesListener?.({
        ...availableCapabilities(),
        state: "refreshing",
      });
      await capabilitiesListener?.(availableCapabilities());
    };
    let refreshCount = 0;
    const refreshCapabilities = vi.fn(async () => {
      refreshCount += 1;
      if (refreshCount > 4) {
        throw new Error("readiness probe feedback loop");
      }
      await publishCatalogChange();
      return availableCapabilities();
    });
    const chatgptSetup = {
      initialize: async () => ({ state: "connected" as const }),
      status: () => ({ state: "connected" as const }),
      start: async () => ({ state: "connected" as const }),
      capabilities: availableCapabilities,
      refreshCapabilities,
      onConnected: () => () => undefined,
      onCapabilitiesChanged: (listener) => {
        capabilitiesListener = listener;
        return () => {
          listenerDisposed = true;
          capabilitiesListener = undefined;
        };
      },
      close: async () => undefined,
    } satisfies ChatGptSetupController;
    const checkCodex = vi.fn(async () => {
      await chatgptSetup.refreshCapabilities();
      return { auth: "ok", capabilities: "ok" } as const;
    });
    const startSpectrum = vi.fn(async ({ readiness }) => {
      readiness.markConnected();
    });
    const service = await startAgentService({
      port: 0,
      host: "127.0.0.1",
      installSignalHandlers: false,
      chatgptSetup,
      bootstrap: {
        prepareConfiguration: async () => undefined,
        prepareStorage: async () => undefined,
        connectDatabase: async () => undefined,
        applyMigrations: async () => undefined,
        startQueue: async () => undefined,
        checkCodex,
        configureSupermemory: async () => "disabled",
        startSpectrum,
      },
    });
    runningServices.push(service);

    expect(checkCodex).toHaveBeenCalledOnce();
    expect(refreshCapabilities).toHaveBeenCalledOnce();
    expect(startSpectrum).toHaveBeenCalledOnce();

    await publishCatalogChange();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(checkCodex).toHaveBeenCalledOnce();
    expect(refreshCapabilities).toHaveBeenCalledOnce();
    expect(startSpectrum).toHaveBeenCalledOnce();
    await expect(fetchReadiness(service)).resolves.toMatchObject({
      status: 200,
      body: { ready: true },
    });

    await service.shutdown("test");
    expect(listenerDisposed).toBe(false);
  });
});
