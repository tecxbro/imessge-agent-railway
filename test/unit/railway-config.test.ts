import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

interface RailwayConfig {
  build: {
    builder: string;
    buildCommand: string;
  };
  deploy: {
    preDeployCommand: string[];
    startCommand: string;
    healthcheckPath: string;
    healthcheckTimeout: number;
    restartPolicyType: string;
    restartPolicyMaxRetries: number;
    overlapSeconds: number;
    drainingSeconds: number;
  };
}

const configUrl = new URL("../../railway.json", import.meta.url);

async function loadConfig(): Promise<RailwayConfig> {
  return JSON.parse(await readFile(configUrl, "utf8")) as RailwayConfig;
}

describe("Railway deployment configuration", () => {
  it("uses Railpack and the pinned clean production build", async () => {
    const config = await loadConfig();

    expect(config.build).toEqual({
      builder: "RAILPACK",
      buildCommand: "npm ci --include=dev && npm run build",
    });
  });

  it("migrates before start and keeps liveness separate from readiness", async () => {
    const config = await loadConfig();

    expect(config.deploy.preDeployCommand).toEqual(["npm run db:migrate"]);
    expect(config.deploy.startCommand).toBe("npm start");
    expect(config.deploy.healthcheckPath).toBe("/healthz");
    expect(config.deploy.healthcheckPath).not.toBe("/readyz");
    expect(config.deploy.healthcheckTimeout).toBe(100);
  });

  it("prevents overlapping consumers and bounds restart and shutdown", async () => {
    const config = await loadConfig();

    expect(config.deploy.restartPolicyType).toBe("ON_FAILURE");
    expect(config.deploy.restartPolicyMaxRetries).toBe(10);
    expect(config.deploy.overlapSeconds).toBe(0);
    expect(config.deploy.drainingSeconds).toBe(90);
  });
});
