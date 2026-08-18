import { readFile } from "node:fs/promises";
import { type AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatGptSetupController } from "../../src/agent/codex-app-server-auth.js";
import { ReadinessRegistry } from "../../src/http/readiness.js";
import { startHealthServer, type HealthServer } from "../../src/http/server.js";
import type { ModelSettingsController } from "../../src/http/server.js";
import type { DeploymentIdentityController } from "../../src/runtime/deployment-identity.js";
import type { PhotonSetupController } from "../../src/transport/photon-setup.js";

let health: HealthServer | undefined;

afterEach(async () => {
  await health?.close();
  health = undefined;
  vi.restoreAllMocks();
});

function configuredIdentity(): DeploymentIdentityController {
  return {
    initialize: async () => ({
      state: "configured",
      maskedPhoneNumber: "••••••0123",
    }),
    status: () => ({
      state: "configured",
      maskedPhoneNumber: "••••••0123",
    }),
    configureOwner: async () => ({
      state: "configured",
      maskedPhoneNumber: "••••••8750",
    }),
    readOwnerPhoneNumber: async () => "+14155550123",
    onConfigured: () => () => undefined,
  };
}

function photonSetup(): PhotonSetupController {
  return {
    status: () => ({
      state: "connected",
      assignedPhoneNumber: "+16285550123",
    }),
    start: async () => ({
      state: "connected",
      assignedPhoneNumber: "+16285550123",
    }),
  };
}

function chatGptSetup(): ChatGptSetupController {
  return {
    capabilities: () => ({
      state: "unavailable",
      planType: null,
      models: [],
      refreshedAt: null,
    }),
    refreshCapabilities: async () => ({
      state: "unavailable",
      planType: null,
      models: [],
      refreshedAt: null,
    }),
    onCapabilitiesChanged: () => () => undefined,
    initialize: async () => ({ state: "not_connected" }),
    status: () => ({ state: "not_connected" }),
    start: async () => ({
      state: "awaiting_authorization",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "CHATGPT-DEVICE-CODE",
    }),
    onConnected: () => () => undefined,
    close: async () => undefined,
  };
}

async function startTestServer(input: {
  identity?: DeploymentIdentityController;
  photon?: PhotonSetupController;
  chatgpt?: ChatGptSetupController;
  modelSettings?: ModelSettingsController;
} = {}): Promise<string> {
  const readiness = new ReadinessRegistry();
  readiness.mark("disk", "ok");
  readiness.mark("codexAuth", "missing", "CODEX_AUTH_MISSING");
  health = await startHealthServer({
    port: 0,
    host: "127.0.0.1",
    readiness,
    deploymentIdentity: input.identity ?? configuredIdentity(),
    photonSetup: input.photon ?? photonSetup(),
    chatgptSetup: input.chatgpt ?? chatGptSetup(),
    ...(input.modelSettings === undefined
      ? {}
      : { modelSettings: input.modelSettings }),
    deploymentPage: {
      authMode: "chatgpt",
      runtimeMode: "agent",
      supermemoryConfigured: false,
    },
  });
  const address = health.server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function mutation(base: string, body: string): RequestInit {
  return {
    method: "POST",
    headers: {
      origin: base,
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
    },
    body,
  };
}

describe("public dashboard HTTP boundary", () => {
  it("serves dashboard, setup status, and detailed readiness without a password", async () => {
    const base = await startTestServer();

    const dashboard = await fetch(`${base}/agent/dashboard`);
    const html = await dashboard.text();
    expect(dashboard.status).toBe(200);
    expect(html).toContain("Change phone number");
    expect(html).toContain("Not in the U.S.?");
    expect(html).toContain("United Kingdom (+44)");
    expect(html).toContain("••••••0123");
    expect(html).toContain("Photon");
    expect(html).toContain("ChatGPT");
    expect(html).not.toContain("Agent password");
    expect(html).not.toContain("csrf");

    const ownerStatus = await fetch(`${base}/api/setup/owner/status`);
    await expect(ownerStatus.json()).resolves.toEqual({
      state: "configured",
      maskedPhoneNumber: "••••••0123",
    });
    const photonStatus = await fetch(`${base}/api/setup/photon/status`);
    await expect(photonStatus.json()).resolves.toEqual({
      state: "connected",
      assignedPhoneNumber: "+16285550123",
    });

    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(503);
    await expect(ready.json()).resolves.toMatchObject({
      ready: false,
      components: {
        codexAuth: { state: "missing", code: "CODEX_AUTH_MISSING" },
      },
    });

    expect((await fetch(`${base}/api/operator/session`)).status).toBe(404);
    expect((await fetch(`${base}/agent/operator-login.js`)).status).toBe(404);
  });

  it("blocks drive-by cross-origin mutations without treating origin as authentication", async () => {
    const identity = configuredIdentity();
    const configureOwner = vi.spyOn(identity, "configureOwner");
    const photon = photonSetup();
    const startPhoton = vi.spyOn(photon, "start");
    const chatgpt = chatGptSetup();
    const startChatGpt = vi.spyOn(chatgpt, "start");
    const base = await startTestServer({ identity, photon, chatgpt });
    const targets = [
      { path: "/api/setup/owner", body: '{"phoneNumber":"+442071838750"}' },
      { path: "/api/setup/photon/start", body: "{}" },
      { path: "/api/setup/chatgpt/start", body: "{}" },
      {
        path: "/api/settings/model",
        body: '{"modelId":"gpt-5.6-luna","reasoningEffort":"high"}',
        method: "PUT",
      },
    ];

    for (const target of targets) {
      const denials = await Promise.all([
        fetch(`${base}${target.path}`, {
          method: target.method ?? "POST",
          headers: { "content-type": "application/json" },
          body: target.body,
        }),
        fetch(`${base}${target.path}`, {
          ...mutation(base, target.body),
          method: target.method ?? "POST",
          headers: {
            origin: "https://attacker.example",
            "content-type": "application/json",
          },
        }),
        fetch(`${base}${target.path}`, {
          ...mutation(base, target.body),
          method: target.method ?? "POST",
          headers: {
            origin: base,
            "content-type": "application/json",
            "sec-fetch-site": "cross-site",
          },
        }),
      ]);
      for (const response of denials) {
        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toEqual({ error: "FORBIDDEN" });
      }
    }

    expect(configureOwner).not.toHaveBeenCalled();
    expect(startPhoton).not.toHaveBeenCalled();
    expect(startChatGpt).not.toHaveBeenCalled();
  });

  it("allows same-origin dashboard setup and keeps raw owner input out of responses", async () => {
    const base = await startTestServer();

    const owner = await fetch(
      `${base}/api/setup/owner`,
      mutation(
        base,
        '{"countryCode":"GB","phoneNumber":"020 7183 8750"}',
      ),
    );
    const ownerBody = await owner.text();
    expect(owner.status).toBe(200);
    expect(ownerBody).toContain("••••••8750");
    expect(ownerBody).not.toContain("+442071838750");
    expect(ownerBody).not.toContain("020 7183 8750");

    const photon = await fetch(
      `${base}/api/setup/photon/start`,
      mutation(base, "{}"),
    );
    expect(photon.status).toBe(200);
    const chatgpt = await fetch(
      `${base}/api/setup/chatgpt/start`,
      mutation(base, "{}"),
    );
    expect(chatgpt.status).toBe(202);
    await expect(chatgpt.json()).resolves.toMatchObject({
      state: "awaiting_authorization",
      userCode: "CHATGPT-DEVICE-CODE",
    });
  });

  it("contains no active password configuration or session route", async () => {
    const [deploymentConfig, example, bootstrap, server] = await Promise.all([
      readFile(new URL("../../railway.json", import.meta.url), "utf8"),
      readFile(new URL("../../.env.example", import.meta.url), "utf8"),
      readFile(
        new URL("../../src/runtime/production-bootstrap.ts", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../../src/http/server.ts", import.meta.url), "utf8"),
    ]);

    for (const source of [deploymentConfig, example, bootstrap]) {
      expect(source).not.toContain("AGENT_PASSWORD");
      expect(source).not.toContain("DASHBOARD_SETUP_SECRET");
    }
    expect(server).not.toContain("/api/operator/session");
    expect(server).not.toContain("operator-login");
  });
});
