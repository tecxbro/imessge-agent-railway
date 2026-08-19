import { type AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { ChatGptSetupController } from "../../src/agent/codex-app-server-auth.js";
import {
  ReadinessRegistry,
  SpectrumReadiness,
  type ReadinessComponent,
} from "../../src/http/readiness.js";
import {
  createDeploymentIdentityController,
  type DeploymentIdentityController,
  type DeploymentIdentityStatus,
} from "../../src/runtime/deployment-identity.js";
import { startHealthServer, type HealthServer } from "../../src/http/server.js";
import type { PhotonSetupController } from "../../src/transport/photon-setup.js";

let health: HealthServer | undefined;

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
  await health?.close();
  health = undefined;
});

function deploymentIdentity(
  initialStatus: DeploymentIdentityStatus = {
    state: "configured",
    maskedPhoneNumber: "••••••4567",
  },
): DeploymentIdentityController {
  let status = initialStatus;
  return {
    initialize: async () => status,
    status: () => ({ ...status }),
    configureOwner: async () => {
      status = { state: "configured", maskedPhoneNumber: "••••••0123" };
      return status;
    },
    readOwnerPhoneNumber: async () =>
      status.state === "configured" ? "+15551234567" : undefined,
    onConfigured: () => () => undefined,
  };
}

function publicMutation(base: string): RequestInit {
  return {
    method: "POST",
    headers: {
      origin: base,
      "content-type": "application/json",
    },
    body: "{}",
  };
}

function markCriticalComponentsReady(readiness: ReadinessRegistry): void {
  for (const component of [
    "configuration",
    "database",
    "migrations",
    "ownerIdentity",
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
      deploymentIdentity: deploymentIdentity({ state: "not_configured" }),
      spectrum,
    });
    const address = health.server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;

    const root = await fetch(`http://127.0.0.1:${address.port}/`, {
      redirect: "manual",
    });
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe("/agent/dashboard");

    const deployment = await fetch(`${base}/agent/dashboard`);
    expect(deployment.status).toBe(200);
    expect(deployment.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(deployment.headers.get("x-frame-options")).toBe("DENY");
    const deploymentPage = await deployment.text();
    expect(deploymentPage).toContain("iMessage Agent");
    expect(deploymentPage).toContain("Your phone number");
    expect(deploymentPage).toContain("Not configured");
    expect(deploymentPage).toContain("Save and continue");
    expect(deploymentPage).not.toContain("Authenticate with Photon");
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

    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(503);
    await expect(ready.json()).resolves.toMatchObject({
      status: "not_ready",
      ready: false,
      components: {
        codexAuth: { state: "missing", code: "CODEX_AUTH_MISSING" },
      },
      actions: [expect.stringContaining("agent dashboard")],
    });
  });

  it("validates and persists dashboard owner setup while returning only a masked number", async () => {
    const readiness = new ReadinessRegistry();
    const spectrum = new SpectrumReadiness();
    let storedPhoneNumber: string | undefined;
    const identity = createDeploymentIdentityController();
    identity.bindRepository({
      async replaceOwnerPhoneNumber(phoneNumber) {
        storedPhoneNumber = phoneNumber;
      },
      async readOwnerPhoneNumber() {
        return storedPhoneNumber;
      },
    });
    await identity.initialize();
    health = await startHealthServer({
      port: 0,
      host: "127.0.0.1",
      readiness,
      deploymentIdentity: identity,
      spectrum,
    });
    const address = health.server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;

    const initial = await fetch(`${base}/api/setup/owner/status`);
    await expect(initial.json()).resolves.toEqual({
      state: "not_configured",
    });

    const extra = await fetch(`${base}/api/setup/owner`, {
      ...publicMutation(base),
      body: JSON.stringify({
        phoneNumber: "+14155550123",
        unexpected: true,
      }),
    });
    expect(extra.status).toBe(400);
    await expect(extra.json()).resolves.toEqual({ error: "INVALID_REQUEST" });

    const extraDashboardField = await fetch(`${base}/api/setup/owner`, {
      ...publicMutation(base),
      body: JSON.stringify({
        countryCode: "US",
        phoneNumber: "4155550123",
        unexpected: true,
      }),
    });
    expect(extraDashboardField.status).toBe(400);
    await expect(extraDashboardField.json()).resolves.toEqual({
      error: "INVALID_REQUEST",
    });

    const invalid = await fetch(`${base}/api/setup/owner`, {
      ...publicMutation(base),
      body: JSON.stringify({ phoneNumber: "415-555-0123" }),
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({
      error: "OWNER_PHONE_NUMBER_INVALID",
    });

    const mismatchedCountry = await fetch(`${base}/api/setup/owner`, {
      ...publicMutation(base),
      body: JSON.stringify({
        countryCode: "GB",
        phoneNumber: "+33 1 42 68 53 00",
      }),
    });
    expect(mismatchedCountry.status).toBe(400);
    await expect(mismatchedCountry.json()).resolves.toEqual({
      error: "OWNER_PHONE_NUMBER_INVALID",
    });

    const configured = await fetch(`${base}/api/setup/owner`, {
      ...publicMutation(base),
      body: JSON.stringify({
        countryCode: "GB",
        phoneNumber: "020 7183 8750",
      }),
    });
    const configuredBody = await configured.text();
    expect(configured.status).toBe(200);
    expect(JSON.parse(configuredBody)).toEqual({
      state: "configured",
      maskedPhoneNumber: "••••••8750",
    });
    expect(configuredBody).not.toContain("+442071838750");
    expect(storedPhoneNumber).toBe("+442071838750");

    const status = await fetch(`${base}/api/setup/owner/status`);
    const statusBody = await status.text();
    expect(JSON.parse(statusBody)).toEqual({
      state: "configured",
      maskedPhoneNumber: "••••••8750",
    });
    expect(statusBody).not.toContain("+442071838750");

    const dashboard = await fetch(`${base}/agent/dashboard`);
    const html = await dashboard.text();
    expect(html).toContain("••••••8750");
    expect(html).not.toContain("+442071838750");
  });

  it("retains the legacy exact E.164 owner request", async () => {
    const readiness = new ReadinessRegistry();
    const spectrum = new SpectrumReadiness();
    let storedPhoneNumber: string | undefined;
    const identity = createDeploymentIdentityController();
    identity.bindRepository({
      async replaceOwnerPhoneNumber(phoneNumber) {
        storedPhoneNumber = phoneNumber;
      },
      async readOwnerPhoneNumber() {
        return storedPhoneNumber;
      },
    });
    await identity.initialize();
    health = await startHealthServer({
      port: 0,
      host: "127.0.0.1",
      readiness,
      deploymentIdentity: identity,
      spectrum,
    });
    const address = health.server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;

    const configured = await fetch(`${base}/api/setup/owner`, {
      ...publicMutation(base),
      body: JSON.stringify({ phoneNumber: "+14155550123" }),
    });

    expect(configured.status).toBe(200);
    await expect(configured.json()).resolves.toEqual({
      state: "configured",
      maskedPhoneNumber: "••••••0123",
    });
    expect(storedPhoneNumber).toBe("+14155550123");
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
        assignedPhoneNumber: "+1 628 555 0123",
      }),
      start: async () => ({
        state: "connected" as const,
        assignedPhoneNumber: "+1 628 555 0123",
      }),
    } satisfies PhotonSetupController;
    health = await startHealthServer({
      port: 0,
      host: "127.0.0.1",
      readiness,
      deploymentIdentity: deploymentIdentity(),
      spectrum,
      deploymentPage: {
        authMode: "api_key",
        runtimeMode: "agent",
        supermemoryConfigured: false,
      },
      photonSetup,
    });
    const address = health.server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${base}/agent/dashboard`);
    const page = await response.text();
    expect(page).toContain("✓ Photon connected");
    expect(page).toContain("Your number:");
    expect(page).toContain("+1 628 555 0123");
    expect(page).toContain('href="sms:+16285550123"');
    expect(page).not.toContain("Supermemory");

    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toMatchObject({
      status: "ready",
      ready: true,
    });
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
      ...chatGptCapabilityMethods,
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
      deploymentIdentity: deploymentIdentity(),
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
    const base = `http://127.0.0.1:${address.port}`;

    const dashboard = await fetch(`${base}/agent/dashboard`);
    const initialPage = await dashboard.text();
    expect(initialPage).toContain("ChatGPT");
    expect(initialPage).toContain("Not connected");
    expect(initialPage).toContain("Connect ChatGPT");

    const start = await fetch(
      `${base}/api/setup/chatgpt/start`,
      publicMutation(base),
    );
    expect(start.status).toBe(202);
    await expect(start.json()).resolves.toEqual(chatGptStatus);

    const devicePage = await fetch(`${base}/agent/dashboard`);
    const deviceHtml = await devicePage.text();
    expect(deviceHtml).toContain("https://auth.openai.com/codex/device");
    expect(deviceHtml).toContain("ABCD-1234");
    expect(deviceHtml).toContain('data-auth-link="chatgpt"');
    expect(deviceHtml).toContain('id="chatgpt-device-code"');
    expect(deviceHtml).toContain(
      'data-copy-target="chatgpt-device-code"',
    );
    expect(deviceHtml).toContain('data-copy-status="chatgpt-copy-status"');
    expect(deviceHtml).toContain("Copy code");
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
      ...chatGptCapabilityMethods,
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
      deploymentIdentity: deploymentIdentity(),
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
    const base = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${base}/agent/dashboard`);
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
      ...chatGptCapabilityMethods,
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
      deploymentIdentity: deploymentIdentity(),
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
    const base = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${base}/agent/dashboard`);
    const page = await response.text();
    expect(page).toContain("Your iMessage Agent");
    expect(page).toContain("✓ Photon connected");
    expect(page).toContain("✓ ChatGPT connected");
    expect(page).toContain("✓ Codex ready");
    expect(page).toContain("Your number:");
    expect(page).toContain("+16285550123");
    expect(page).toContain('<span class="agent-or">or</span>');
    expect(page).toContain('href="sms:+16285550123"');
    expect(page).toContain("Text agent");
    expect(page).toContain("Your agent is ready.");
    expect(page).toContain("Send “hi” to get started.");
    expect(page).not.toContain("Text it to get started.");
    expect(page).toContain("••••••4567");
    expect(page).not.toContain("+15551234567");
    expect(page).not.toContain('href="sms:+15551234567"');
    expect(page).toContain('<details id="advanced-settings"');
    expect(page).toContain("ChatGPT plan");
    expect(page).toContain('id="model-select"');
    expect(page).toContain('id="effort-select"');
    expect(page).toContain("Use Luna High");
    expect(page).not.toContain('role="progressbar"');

    const script = await fetch(`${base}/agent/dashboard.js`);
    const javascript = await script.text();
    expect(javascript).toContain('fetch("/readyz"');
    expect(javascript).toContain("dataset.ready");
  });

  it.each([undefined, "+16285550123x"])(
    "omits the messaging action when the assigned number is %s",
    async (assignedPhoneNumber) => {
      const readiness = new ReadinessRegistry();
      const spectrum = new SpectrumReadiness();
      markCriticalComponentsReady(readiness);
      spectrum.markConnected();
      const photonSetup = {
        status: () => ({
          state: "connected" as const,
          ...(assignedPhoneNumber === undefined
            ? {}
            : { assignedPhoneNumber }),
        }),
        start: async () => ({ state: "connected" as const }),
      } satisfies PhotonSetupController;
      health = await startHealthServer({
        port: 0,
        host: "127.0.0.1",
        readiness,
        deploymentIdentity: deploymentIdentity(),
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
      expect(page).toContain("Your agent is ready.");
      expect(page).not.toContain("Text agent");
      expect(page).not.toContain('class="agent-or"');
      expect(page).not.toContain('href="sms:');
    },
  );

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
      ...chatGptCapabilityMethods,
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
      deploymentIdentity: deploymentIdentity(),
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
    const base = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${base}/agent/dashboard`);
    const page = await response.text();
    expect(page).toContain("✓ ChatGPT connected");
    expect(page).toContain("Your agent is ready.");
    expect(page).not.toContain("CHATGPT_APP_SERVER_UNAVAILABLE");
  });

  it("preserves Photon setup start and public status behavior", async () => {
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
      deploymentIdentity: deploymentIdentity(),
      spectrum,
      photonSetup,
    });
    const address = health.server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;

    const start = await fetch(
      `${base}/api/setup/photon/start`,
      publicMutation(base),
    );
    expect(start.status).toBe(202);
    await expect(start.json()).resolves.toMatchObject({
      state: "awaiting_authorization",
      userCode: "ABCD-EFGH",
    });

    const current = await fetch(`${base}/api/setup/photon/status`);
    await expect(current.json()).resolves.toEqual(status);

    const dashboard = await fetch(`${base}/agent/dashboard`);
    const page = await dashboard.text();
    expect(page).toContain("https://app.photon.codes/device");
    expect(page).toContain('data-auth-link="photon"');
    expect(page).toContain('id="photon-device-code"');
    expect(page).toContain('data-copy-target="photon-device-code"');
    expect(page).toContain('data-copy-status="photon-copy-status"');
    expect(page).toContain("Copy code");
  });

  it("exposes only the narrow setup methods and no command endpoint", async () => {
    const readiness = new ReadinessRegistry();
    const spectrum = new SpectrumReadiness();
    health = await startHealthServer({
      port: 0,
      host: "127.0.0.1",
      readiness,
      deploymentIdentity: deploymentIdentity(),
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
