import { type AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { ChatGptSetupController } from "../../src/agent/codex-app-server-auth.js";
import {
  ReadinessRegistry,
  SpectrumReadiness,
  type ReadinessComponent,
} from "../../src/http/readiness.js";
import { startHealthServer, type HealthServer } from "../../src/http/server.js";
import type { PhotonSetupController } from "../../src/transport/photon-setup.js";

let health: HealthServer | undefined;

afterEach(async () => {
  await health?.close();
  health = undefined;
});

function markCriticalComponentsReady(readiness: ReadinessRegistry): void {
  for (const component of [
    "configuration",
    "database",
    "migrations",
    "queue",
    "codexAuth",
    "codexCapabilities",
    "disk",
    "workspace",
  ] satisfies ReadinessComponent[]) {
    readiness.mark(component, "ok");
  }
  readiness.mark("supermemory", "disabled");
}

describe("health and readiness endpoints", () => {
  it("keeps liveness healthy while setup is incomplete", async () => {
    const readiness = new ReadinessRegistry();
    const spectrum = new SpectrumReadiness();
    readiness.mark("codexAuth", "missing", "CODEX_AUTH_MISSING");
    health = await startHealthServer({
      port: 0,
      host: "127.0.0.1",
      readiness,
      spectrum,
    });
    const address = health.server.address() as AddressInfo;

    const root = await fetch(`http://127.0.0.1:${address.port}/`, {
      redirect: "manual",
    });
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe("/agent/dashboard");

    const deployment = await fetch(
      `http://127.0.0.1:${address.port}/agent/dashboard`,
    );
    expect(deployment.status).toBe(200);
    expect(deployment.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(deployment.headers.get("x-frame-options")).toBe("DENY");
    const deploymentPage = await deployment.text();
    expect(deploymentPage).toContain("iMessage Agent");
    expect(deploymentPage).toContain("Photon");
    expect(deploymentPage).toContain("Not connected");
    expect(deploymentPage).toContain("Authenticate with Photon");
    expect(deploymentPage).toContain("Photon PolySans");
    expect(deploymentPage).toContain('src="/agent/photon-logo.png"');
    expect(deploymentPage).toContain('href="https://photon.codes"');
    expect(deploymentPage).toContain("Build with Photon");
    expect(deploymentPage).toContain('<footer class="site-footer">');
    expect(deploymentPage).toContain("Ship messaging apps with Spectrum");
    expect(deploymentPage).toContain(
      'href="https://photon.codes/docs/spectrum-ts/introduction"',
    );
    expect(deploymentPage).toContain(
      'href="https://photon.codes/contact"',
    );
    expect(deploymentPage).toContain("--bg: #fbfbfa");
    expect(deploymentPage).not.toContain("gradient");
    expect(deploymentPage).not.toContain("photon-green");
    expect(deploymentPage).not.toContain("backdrop-filter");
    expect(deploymentPage).not.toContain("photon-cta");
    expect(deploymentPage).not.toContain("Supermemory");
    expect(deploymentPage).not.toContain("photon-super-secret");

    const logo = await fetch(
      `http://127.0.0.1:${address.port}/agent/photon-logo.png`,
    );
    expect(logo.status).toBe(200);
    expect(logo.headers.get("content-type")).toContain("image/png");
    const logoBytes = new Uint8Array(await logo.arrayBuffer());
    expect(logoBytes).toHaveLength(44_504);
    expect([...logoBytes.slice(0, 8)]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);

    const live = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    expect(live.status).toBe(200);
    await expect(live.json()).resolves.toEqual({ status: "ok" });

    const ready = await fetch(`http://127.0.0.1:${address.port}/readyz`);
    expect(ready.status).toBe(503);
    const body = (await ready.json()) as {
      actions: string[];
      ready: boolean;
      components: Record<string, { state: string }>;
    };
    expect(body.ready).toBe(false);
    expect(body.components["codexAuth"]?.state).toBe("missing");
    expect(body.actions).toEqual([
      expect.stringContaining("agent dashboard"),
    ]);
  });

  it("reports ready only when every critical component is ready", () => {
    const readiness = new ReadinessRegistry();
    const spectrum = new SpectrumReadiness();
    markCriticalComponentsReady(readiness);
    spectrum.markConnected();

    expect(readiness.snapshot(spectrum.snapshot())).toMatchObject({
      ready: true,
      status: "ready",
      components: { supermemory: { state: "disabled" } },
    });

    readiness.beginShutdown();
    expect(readiness.snapshot(spectrum.snapshot())).toMatchObject({
      ready: false,
      status: "not_ready",
      shuttingDown: true,
    });
  });

  it("shows the persisted Photon connection and assigned iMessage number", async () => {
    const readiness = new ReadinessRegistry();
    const spectrum = new SpectrumReadiness();
    markCriticalComponentsReady(readiness);
    spectrum.markConnected();
    const photonSetup = {
      status: () => ({
        state: "connected" as const,
        assignedPhoneNumber: "+16285550123",
      }),
      start: async () => ({
        state: "connected" as const,
        assignedPhoneNumber: "+16285550123",
      }),
    } satisfies PhotonSetupController;
    health = await startHealthServer({
      port: 0,
      host: "127.0.0.1",
      readiness,
      spectrum,
      deploymentPage: {
        authMode: "api_key",
        runtimeMode: "agent",
        supermemoryConfigured: false,
      },
      photonSetup,
    });
    const address = health.server.address() as AddressInfo;

    const response = await fetch(
      `http://127.0.0.1:${address.port}/agent/dashboard`,
    );
    const page = await response.text();
    expect(page).toContain("✓ Photon connected");
    expect(page).toContain("Your number:");
    expect(page).toContain("+16285550123");
    expect(page).not.toContain("Supermemory");
  });

  it("shows ChatGPT device login after Photon connects", async () => {
    const readiness = new ReadinessRegistry();
    const spectrum = new SpectrumReadiness();
    readiness.mark("disk", "ok");
    const photonSetup = {
      status: () => ({
        state: "connected" as const,
        assignedPhoneNumber: "+16285550123",
      }),
      start: async () => ({ state: "connected" as const }),
    } satisfies PhotonSetupController;
    let chatGptStatus = {
      state: "not_connected" as const,
    } as ReturnType<ChatGptSetupController["status"]>;
    const chatgptSetup = {
      initialize: async () => chatGptStatus,
      status: () => chatGptStatus,
      start: async () => {
        chatGptStatus = {
          state: "awaiting_authorization",
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "ABCD-1234",
        };
        return chatGptStatus;
      },
      onConnected: () => () => undefined,
      close: async () => undefined,
    } satisfies ChatGptSetupController;
    health = await startHealthServer({
      port: 0,
      host: "127.0.0.1",
      readiness,
      spectrum,
      deploymentPage: {
        authMode: "chatgpt",
        runtimeMode: "agent",
        supermemoryConfigured: false,
      },
      photonSetup,
      chatgptSetup,
    });
    const address = health.server.address() as AddressInfo;

    const dashboard = await fetch(
      `http://127.0.0.1:${address.port}/agent/dashboard`,
    );
    const initialPage = await dashboard.text();
    expect(initialPage).toContain("ChatGPT");
    expect(initialPage).toContain("Not connected");
    expect(initialPage).toContain("Connect ChatGPT");

    const start = await fetch(
      `http://127.0.0.1:${address.port}/api/setup/chatgpt/start`,
      {
        method: "POST",
        headers: { "x-agent-setup": "dashboard" },
      },
    );
    expect(start.status).toBe(202);
    await expect(start.json()).resolves.toEqual(chatGptStatus);

    const devicePage = await fetch(
      `http://127.0.0.1:${address.port}/agent/dashboard`,
    );
    const deviceHtml = await devicePage.text();
    expect(deviceHtml).toContain("https://auth.openai.com/codex/device");
    expect(deviceHtml).toContain("ABCD-1234");
    expect(deviceHtml).toContain('data-auth-link="chatgpt"');
    expect(deviceHtml).not.toContain("auth.json");
  });

  it("does not offer ChatGPT reconnection after Codex validates persisted auth", async () => {
    const readiness = new ReadinessRegistry();
    const spectrum = new SpectrumReadiness();
    readiness.mark("codexAuth", "ok");
    readiness.mark("codexCapabilities", "starting");
    const photonSetup = {
      status: () => ({
        state: "connected" as const,
        assignedPhoneNumber: "+16285550123",
      }),
      start: async () => ({ state: "connected" as const }),
    } satisfies PhotonSetupController;
    const chatgptSetup = {
      initialize: async () => ({
        state: "failed" as const,
        code: "CHATGPT_APP_SERVER_UNAVAILABLE" as const,
      }),
      status: () => ({
        state: "failed" as const,
        code: "CHATGPT_APP_SERVER_UNAVAILABLE" as const,
      }),
      start: async () => ({ state: "not_connected" as const }),
      onConnected: () => () => undefined,
      close: async () => undefined,
    } satisfies ChatGptSetupController;
    health = await startHealthServer({
      port: 0,
      host: "127.0.0.1",
      readiness,
      spectrum,
      deploymentPage: {
        authMode: "chatgpt",
        runtimeMode: "agent",
        supermemoryConfigured: false,
      },
      photonSetup,
      chatgptSetup,
    });
    const address = health.server.address() as AddressInfo;

    const response = await fetch(
      `http://127.0.0.1:${address.port}/agent/dashboard`,
    );
    const page = await response.text();
    expect(page).toContain("ChatGPT");
    expect(page).toContain("✓ Connected");
    expect(page).not.toContain("Connect ChatGPT");
    expect(page).not.toContain("ChatGPT setup could not finish");
    expect(page).toContain("Getting ready");
    expect(page).toContain('role="progressbar"');
    expect(page).toContain('aria-label="Codex is getting ready"');
    expect(page).toContain("@keyframes codex-progress");
    expect(page).toContain("prefers-reduced-motion: reduce");
  });

  it("renders the final agent-ready dashboard only after both setups and Codex are ready", async () => {
    const readiness = new ReadinessRegistry();
    const spectrum = new SpectrumReadiness();
    markCriticalComponentsReady(readiness);
    spectrum.markConnected();
    const photonSetup = {
      status: () => ({
        state: "connected" as const,
        assignedPhoneNumber: "+16285550123",
      }),
      start: async () => ({ state: "connected" as const }),
    } satisfies PhotonSetupController;
    const chatgptSetup = {
      initialize: async () => ({ state: "connected" as const }),
      status: () => ({ state: "connected" as const }),
      start: async () => ({ state: "connected" as const }),
      onConnected: () => () => undefined,
      close: async () => undefined,
    } satisfies ChatGptSetupController;
    health = await startHealthServer({
      port: 0,
      host: "127.0.0.1",
      readiness,
      spectrum,
      deploymentPage: {
        authMode: "chatgpt",
        runtimeMode: "agent",
        supermemoryConfigured: false,
      },
      photonSetup,
      chatgptSetup,
    });
    const address = health.server.address() as AddressInfo;

    const response = await fetch(
      `http://127.0.0.1:${address.port}/agent/dashboard`,
    );
    const page = await response.text();
    expect(page).toContain("Your iMessage Agent");
    expect(page).toContain("✓ Photon connected");
    expect(page).toContain("✓ ChatGPT connected");
    expect(page).toContain("✓ Codex ready");
    expect(page).toContain("Your number:");
    expect(page).toContain("+16285550123");
    expect(page).toContain("Your agent is ready.");
    expect(page).toContain("Text it to get started.");
    expect(page).not.toContain('role="progressbar"');

    const script = await fetch(
      `http://127.0.0.1:${address.port}/agent/dashboard.js`,
    );
    const javascript = await script.text();
    expect(javascript).toContain('fetch("/readyz"');
    expect(javascript).toContain("dataset.ready");
  });

  it("uses green Codex authentication as authoritative when App Server status is stale", async () => {
    const readiness = new ReadinessRegistry();
    const spectrum = new SpectrumReadiness();
    markCriticalComponentsReady(readiness);
    spectrum.markConnected();
    const photonSetup = {
      status: () => ({
        state: "connected" as const,
        assignedPhoneNumber: "+16285550123",
      }),
      start: async () => ({ state: "connected" as const }),
    } satisfies PhotonSetupController;
    const chatgptSetup = {
      initialize: async () => ({
        state: "failed" as const,
        code: "CHATGPT_APP_SERVER_UNAVAILABLE" as const,
      }),
      status: () => ({
        state: "failed" as const,
        code: "CHATGPT_APP_SERVER_UNAVAILABLE" as const,
      }),
      start: async () => ({
        state: "failed" as const,
        code: "CHATGPT_APP_SERVER_UNAVAILABLE" as const,
      }),
      onConnected: () => () => undefined,
      close: async () => undefined,
    } satisfies ChatGptSetupController;
    health = await startHealthServer({
      port: 0,
      host: "127.0.0.1",
      readiness,
      spectrum,
      deploymentPage: {
        authMode: "chatgpt",
        runtimeMode: "agent",
        supermemoryConfigured: false,
      },
      photonSetup,
      chatgptSetup,
    });
    const address = health.server.address() as AddressInfo;

    const response = await fetch(
      `http://127.0.0.1:${address.port}/agent/dashboard`,
    );
    const page = await response.text();
    expect(page).toContain("✓ ChatGPT connected");
    expect(page).toContain("Your agent is ready.");
    expect(page).not.toContain("CHATGPT_APP_SERVER_UNAVAILABLE");
  });

  it("exposes the Photon setup start and status API without credentials", async () => {
    const readiness = new ReadinessRegistry();
    const spectrum = new SpectrumReadiness();
    let status = {
      state: "not_connected" as const,
    } as ReturnType<PhotonSetupController["status"]>;
    const photonSetup = {
      status: () => status,
      start: async () => {
        status = {
          state: "awaiting_authorization",
          userCode: "ABCD-EFGH",
          verificationUrl: "https://app.photon.codes/device",
          expiresAt: "2026-08-16T03:00:00.000Z",
        };
        return status;
      },
    } satisfies PhotonSetupController;
    health = await startHealthServer({
      port: 0,
      host: "127.0.0.1",
      readiness,
      spectrum,
      photonSetup,
    });
    const address = health.server.address() as AddressInfo;

    const start = await fetch(
      `http://127.0.0.1:${address.port}/api/setup/photon/start`,
      { method: "POST" },
    );
    expect(start.status).toBe(202);
    await expect(start.json()).resolves.toMatchObject({
      state: "awaiting_authorization",
      userCode: "ABCD-EFGH",
    });

    const current = await fetch(
      `http://127.0.0.1:${address.port}/api/setup/photon/status`,
    );
    await expect(current.json()).resolves.toEqual(status);

    const dashboard = await fetch(
      `http://127.0.0.1:${address.port}/agent/dashboard`,
    );
    const page = await dashboard.text();
    expect(page).toContain("https://app.photon.codes/device");
    expect(page).toContain('data-auth-link="photon"');
  });

  it("exposes only the narrow setup methods and no command endpoint", async () => {
    const readiness = new ReadinessRegistry();
    const spectrum = new SpectrumReadiness();
    health = await startHealthServer({
      port: 0,
      host: "127.0.0.1",
      readiness,
      spectrum,
    });
    const address = health.server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    const requests = [
      fetch(`${base}/api/setup/photon/start`),
      fetch(`${base}/api/setup/photon/status`, { method: "POST" }),
      fetch(`${base}/api/setup/chatgpt/start`),
      fetch(`${base}/api/setup/chatgpt/status`, { method: "POST" }),
      ...["shell", "exec", "command", "terminal"].flatMap((name) => [
        fetch(`${base}/api/${name}`),
        fetch(`${base}/api/${name}`, { method: "POST" }),
      ]),
    ];

    for (const response of await Promise.all(requests)) {
      expect(response.status).toBe(404);
    }
  });

  it("rejects raw error text at the readiness boundary", () => {
    const readiness = new ReadinessRegistry();
    expect(() =>
      readiness.mark(
        "database",
        "failed",
        "connection failed for postgresql://user:secret@example.test/db",
      ),
    ).toThrow(/bounded uppercase identifiers/);
  });
});
