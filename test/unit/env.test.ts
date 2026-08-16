import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  deploymentIdFromRailwayServiceId,
  EnvironmentValidationError,
  loadEnvironment,
  modelProfilesFromEnvironment,
} from "../../src/config/env.js";

function validEnvironment(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    SPECTRUM_PROJECT_ID: "spectrum-project",
    SPECTRUM_PROJECT_SECRET: "spectrum-secret",
    DATABASE_URL: "postgresql://agent:password@localhost:5432/agent",
    OWNER_PHONE_NUMBER: "+15551234567",
    DEPLOYMENT_ID: "00000000-0000-4000-8000-000000000001",
    APP_ENCRYPTION_KEY: "00".repeat(32),
    CODEX_HOME: "./.codex-agent",
    AGENT_WORKSPACE_ROOT: "./.agent-workspaces",
    CODEX_AUTH_MODE: "chatgpt",
    PATH: "/usr/bin:/bin",
    ...overrides,
  };
}

describe("loadEnvironment", () => {
  it("normalizes documented defaults, handles, paths, and model profiles", () => {
    const environment = loadEnvironment(validEnvironment());

    expect(environment.OWNER_PHONE_NUMBER).toBe("+15551234567");
    expect(environment.AGENT_OWNER_HANDLES).toEqual(["+15551234567"]);
    expect(environment.CODEX_HOME).toBe(resolve(".codex-agent"));
    expect(environment.AGENT_WORKSPACE_ROOT).toBe(
      resolve(".agent-workspaces"),
    );
    expect(environment.INBOUND_DEBOUNCE_MS).toBe(4_000);
    expect(environment.LOG_MESSAGE_CONTENT).toBe(false);
    expect(modelProfilesFromEnvironment(environment).deep).toEqual({
      model: "gpt-5.6-sol",
      effort: "max",
    });
  });

  it("reports all missing required variables in one actionable error", () => {
    let error: unknown;
    try {
      loadEnvironment({});
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(EnvironmentValidationError);
    const message = (error as Error).message;
    for (const variable of [
      "DATABASE_URL",
      "DEPLOYMENT_ID",
      "APP_ENCRYPTION_KEY",
      "CODEX_HOME",
      "AGENT_WORKSPACE_ROOT",
    ]) {
      expect(message).toContain(variable);
    }
    expect(message).toContain("Fix the listed variables and restart the service");
    expect(message).not.toContain("undefined");
  });

  it.each([
    ["database protocol", { DATABASE_URL: "https://database.example.com" }],
    ["owner phone", { OWNER_PHONE_NUMBER: "not-a-phone" }],
    ["encryption key", { APP_ENCRYPTION_KEY: "too-short" }],
    ["filesystem root", { CODEX_HOME: "/" }],
    ["path traversal", { AGENT_WORKSPACE_ROOT: "../outside" }],
    [
      "overlapping protected paths",
      { AGENT_WORKSPACE_ROOT: "./.codex-agent/workspaces" },
    ],
    ["duration", { MAX_TASK_RUNTIME_MS: "0" }],
    ["debounce", { INBOUND_DEBOUNCE_MS: "2500" }],
    ["model", { MODEL_MAIN: "not a model/name" }],
    ["effort", { MODEL_HARD_EFFORT: "ultra" }],
    ["boolean", { LOG_MESSAGE_CONTENT: "yes" }],
  ])("rejects malformed %s configuration", (_label, override) => {
    expect(() => loadEnvironment(validEnvironment(override))).toThrow(
      EnvironmentValidationError,
    );
  });

  it("requires an API key only in API-key authentication mode", () => {
    expect(() =>
      loadEnvironment(validEnvironment({ CODEX_AUTH_MODE: "api_key" })),
    ).toThrow(/OPENAI_API_KEY is required/);

    expect(
      loadEnvironment(
        validEnvironment({
          CODEX_AUTH_MODE: "api_key",
          OPENAI_API_KEY: "test-key",
        }),
      ).CODEX_AUTH_MODE,
    ).toBe("api_key");
  });

  it("allows initial boot without Spectrum credentials", () => {
    const environment = loadEnvironment(
      validEnvironment({
        SPECTRUM_PROJECT_ID: undefined,
        SPECTRUM_PROJECT_SECRET: undefined,
      }),
    );

    expect(environment.SPECTRUM_PROJECT_ID).toBeUndefined();
    expect(environment.SPECTRUM_PROJECT_SECRET).toBeUndefined();
  });

  it("uses AGENT_OWNER_HANDLES only as a backwards-compatible fallback", () => {
    const environment = loadEnvironment(
      validEnvironment({
        OWNER_PHONE_NUMBER: undefined,
        AGENT_OWNER_HANDLES: "+15557654321,Owner@Example.com",
      }),
    );

    expect(environment.AGENT_OWNER_HANDLES).toEqual([
      "+15557654321",
      "owner@example.com",
    ]);
  });

  it("requires a new owner phone number or the legacy owner fallback", () => {
    expect(() =>
      loadEnvironment(
        validEnvironment({
          OWNER_PHONE_NUMBER: undefined,
          AGENT_OWNER_HANDLES: undefined,
        }),
      ),
    ).toThrow(/OWNER_PHONE_NUMBER is required/);
  });

  it("requires legacy Spectrum credentials to be supplied as a pair", () => {
    expect(() =>
      loadEnvironment(
        validEnvironment({ SPECTRUM_PROJECT_SECRET: undefined }),
      ),
    ).toThrow(/must either both be set or both be omitted/);
  });

  it("derives a stable private deployment UUID from Railway's service ID", () => {
    const withoutDeploymentId = validEnvironment({
      DEPLOYMENT_ID: undefined,
      RAILWAY_SERVICE_ID: "6f6efdf3-32ff-454f-a8fe-9ab8792667cc",
      RAILWAY_VOLUME_MOUNT_PATH: "/var/data",
      CODEX_HOME: "/var/data/codex",
      AGENT_WORKSPACE_ROOT: "/var/data/workspaces",
    });

    const first = loadEnvironment(withoutDeploymentId).DEPLOYMENT_ID;
    const second = loadEnvironment({ ...withoutDeploymentId }).DEPLOYMENT_ID;

    expect(first).toBe(second);
    expect(first).toBe(
      deploymentIdFromRailwayServiceId(
        "6f6efdf3-32ff-454f-a8fe-9ab8792667cc",
      ),
    );
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(first).not.toContain("6f6efdf3");
  });

  it("derives different deployment UUIDs for different Railway services", () => {
    expect(deploymentIdFromRailwayServiceId("service-one")).not.toBe(
      deploymentIdFromRailwayServiceId("service-two"),
    );
  });

  it("preserves an explicit deployment UUID instead of replacing it on Railway", () => {
    expect(
      loadEnvironment(
        validEnvironment({
          RAILWAY_SERVICE_ID: "6f6efdf3-32ff-454f-a8fe-9ab8792667cc",
          RAILWAY_VOLUME_MOUNT_PATH: "/var/data",
          CODEX_HOME: "/var/data/codex",
          AGENT_WORKSPACE_ROOT: "/var/data/workspaces",
        }),
      ).DEPLOYMENT_ID,
    ).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("ignores Railway deployment IDs for installation identity", () => {
    expect(() =>
      loadEnvironment(
        validEnvironment({
          DEPLOYMENT_ID: undefined,
          RAILWAY_DEPLOYMENT_ID: "deployment-123",
          RAILWAY_VOLUME_MOUNT_PATH: "/var/data",
          CODEX_HOME: "/var/data/codex",
          AGENT_WORKSPACE_ROOT: "/var/data/workspaces",
        }),
      ),
    ).toThrow(/DEPLOYMENT_ID is required/u);
  });

  it("rejects malformed Railway service IDs used for derivation", () => {
    expect(() =>
      loadEnvironment(
        validEnvironment({
          DEPLOYMENT_ID: undefined,
          RAILWAY_SERVICE_ID: "service id with spaces",
          RAILWAY_VOLUME_MOUNT_PATH: "/var/data",
          CODEX_HOME: "/var/data/codex",
          AGENT_WORKSPACE_ROOT: "/var/data/workspaces",
        }),
      ),
    ).toThrow(/RAILWAY_SERVICE_ID is malformed/u);
  });

  it("requires the Railway volume and keeps protected paths beneath it", () => {
    expect(() =>
      loadEnvironment(
        validEnvironment({
          NODE_ENV: "production",
          RAILWAY_SERVICE_ID: "service-123",
        }),
      ),
    ).toThrow(/RAILWAY_VOLUME_MOUNT_PATH is required/u);

    expect(() =>
      loadEnvironment(
        validEnvironment({
          NODE_ENV: "production",
          RAILWAY_SERVICE_ID: "service-123",
          RAILWAY_VOLUME_MOUNT_PATH: "/var/data",
          CODEX_HOME: "/tmp/codex",
          AGENT_WORKSPACE_ROOT: "/var/data/workspaces",
        }),
      ),
    ).toThrow(/CODEX_HOME must be under RAILWAY_VOLUME_MOUNT_PATH/u);

    expect(() =>
      loadEnvironment(
        validEnvironment({
          NODE_ENV: "production",
          RAILWAY_SERVICE_ID: "service-123",
          RAILWAY_VOLUME_MOUNT_PATH: "/var/data",
          CODEX_HOME: "/var/data/codex",
          AGENT_WORKSPACE_ROOT: "/tmp/workspaces",
        }),
      ),
    ).toThrow(
      /AGENT_WORKSPACE_ROOT must be under RAILWAY_VOLUME_MOUNT_PATH/u,
    );
  });

  it("continues to support local development without Railway variables", () => {
    expect(loadEnvironment(validEnvironment()).DEPLOYMENT_ID).toBe(
      "00000000-0000-4000-8000-000000000001",
    );
  });
});
