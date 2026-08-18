import { type AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CodexModelOption } from "../../src/agent/codex-account-capabilities.js";
import { ReadinessRegistry } from "../../src/http/readiness.js";
import {
  ModelSettingsApiError,
  startHealthServer,
  type HealthServer,
  type ModelSettingsApiSnapshot,
  type ModelSettingsController,
} from "../../src/http/server.js";

let health: HealthServer | undefined;

afterEach(async () => {
  await health?.close();
  health = undefined;
});

const models: CodexModelOption[] = [
  {
    id: "gpt-5.6-luna",
    model: "private-provider-name-must-not-leak",
    displayName: "GPT-5.6 Luna",
    supportedReasoningEfforts: [
      { reasoningEffort: "medium", description: "Default" },
      { reasoningEffort: "high", description: "More reasoning" },
    ],
    defaultReasoningEffort: "medium",
    isDefault: true,
  },
  {
    id: "gpt-5.6-terra",
    model: "gpt-5.6-terra",
    displayName: "GPT-5.6 Terra",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Fast" },
    ],
    defaultReasoningEffort: "low",
    isDefault: false,
  },
];

function snapshot(): ModelSettingsApiSnapshot {
  return {
    planType: "plus",
    preferred: {
      modelId: "gpt-5.6-luna",
      reasoningEffort: "high",
    },
    effective: {
      modelId: "gpt-5.6-terra",
      reasoningEffort: "low",
    },
    selectionState: "fallback",
    modelCatalogRefreshedAt: new Date("2026-08-17T20:00:00Z"),
    availableModels: models,
  };
}

async function start(controller?: ModelSettingsController): Promise<string> {
  health = await startHealthServer({
    port: 0,
    host: "127.0.0.1",
    readiness: new ReadinessRegistry(),
    ...(controller === undefined ? {} : { modelSettings: controller }),
  });
  const address = health.server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function controller(): ModelSettingsController {
  return {
    read: vi.fn(async () => ({
      ...snapshot(),
      email: "private@example.com",
    })),
    update: vi.fn(async () => snapshot()),
  };
}

function sameOriginPut(base: string, body: unknown): RequestInit {
  return {
    method: "PUT",
    headers: {
      origin: base,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

describe("deployment model-settings HTTP API", () => {
  it("returns only the account-visible picker contract with private no-store headers", async () => {
    const base = await start(controller());
    const response = await fetch(`${base}/api/settings/model`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(JSON.parse(body)).toEqual({
      planType: "plus",
      preferred: {
        modelId: "gpt-5.6-luna",
        reasoningEffort: "high",
      },
      effective: {
        modelId: "gpt-5.6-terra",
        reasoningEffort: "low",
      },
      selectionState: "fallback",
      availableModels: [
        {
          id: "gpt-5.6-luna",
          displayName: "GPT-5.6 Luna",
          supportedReasoningEfforts: [
            { reasoningEffort: "medium", description: "Default" },
            { reasoningEffort: "high", description: "More reasoning" },
          ],
          defaultReasoningEffort: "medium",
        },
        {
          id: "gpt-5.6-terra",
          displayName: "GPT-5.6 Terra",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Fast" },
          ],
          defaultReasoningEffort: "low",
        },
      ],
    });
    expect(body).not.toContain("private@example.com");
    expect(body).not.toContain("private-provider-name-must-not-leak");
    expect(body).not.toContain("isDefault");
  });

  it("accepts only an exact supported two-field selection from the same origin", async () => {
    const settings = controller();
    const base = await start(settings);
    const response = await fetch(
      `${base}/api/settings/model`,
      sameOriginPut(base, {
        modelId: "gpt-5.6-luna",
        reasoningEffort: "high",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(settings.update).toHaveBeenCalledWith({
      modelId: "gpt-5.6-luna",
      reasoningEffort: "high",
    });

    for (const body of [
      { modelId: "gpt-5.6-luna" },
      {
        modelId: "gpt-5.6-luna",
        reasoningEffort: "high",
        planType: "enterprise",
      },
      { modelId: "bad model", reasoningEffort: "high" },
      { modelId: "gpt-5.6-luna", reasoningEffort: "ultra" },
    ]) {
      const invalid = await fetch(
        `${base}/api/settings/model`,
        sameOriginPut(base, body),
      );
      expect(invalid.status).toBe(400);
      await expect(invalid.json()).resolves.toEqual({
        error: "INVALID_MODEL_SETTINGS",
      });
    }
    expect(settings.update).toHaveBeenCalledTimes(1);
  });

  it("blocks cross-origin writes before the controller is called", async () => {
    const settings = controller();
    const base = await start(settings);
    const response = await fetch(`${base}/api/settings/model`, {
      ...sameOriginPut(base, {
        modelId: "gpt-5.6-luna",
        reasoningEffort: "high",
      }),
      headers: {
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
        "content-type": "application/json",
      },
    });

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "FORBIDDEN" });
    expect(settings.update).not.toHaveBeenCalled();
  });

  it.each([
    ["MODEL_SELECTION_STALE", 409],
    ["MODEL_PAIR_UNAVAILABLE", 409],
    ["MODEL_SETTINGS_UNAVAILABLE", 503],
  ] as const)("maps %s to its stable API status", async (code, status) => {
    const settings = controller();
    vi.mocked(settings.update).mockRejectedValue(new ModelSettingsApiError(code));
    const base = await start(settings);
    const response = await fetch(
      `${base}/api/settings/model`,
      sameOriginPut(base, {
        modelId: "gpt-5.6-luna",
        reasoningEffort: "high",
      }),
    );

    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ error: code });
  });

  it("returns unavailable when no account-capability controller is composed", async () => {
    const base = await start();
    const response = await fetch(`${base}/api/settings/model`);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "MODEL_SETTINGS_UNAVAILABLE",
    });
  });
});
