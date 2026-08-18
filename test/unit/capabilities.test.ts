import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_MODEL_SELECTION } from "../../src/agent/model-selection.js";
import {
  probeCodexCapabilities,
  type CapabilityPairRunner,
} from "../../src/config/capabilities.js";

const temporaryDirectories: string[] = [];
const currentUidOption =
  process.getuid === undefined ? {} : { currentUid: process.getuid() };

async function temporaryCodexHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-capability-test-"));
  temporaryDirectories.push(directory);
  await chmod(directory, 0o700);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("Codex startup capability report", () => {
  it("reports missing ChatGPT enrollment without invoking a model", async () => {
    const codexHome = await temporaryCodexHome();
    let probes = 0;
    const runner: CapabilityPairRunner = {
      async probe() {
        probes += 1;
        return { supported: true };
      },
    };
    const report = await probeCodexCapabilities({
      codexHome,
      authMode: "chatgpt",
      selection: DEFAULT_MODEL_SELECTION,
      runner,
      ...currentUidOption,
    });
    expect(report.ready).toBe(false);
    expect(report.components).toMatchObject({
      disk: "ok",
      auth: "missing",
      models: "unknown",
    });
    expect(report.remediation.join(" ")).toContain("npm run codex:login");
    expect(probes).toBe(0);
  });

  it("requires private auth-file permissions in ChatGPT mode", async () => {
    const codexHome = await temporaryCodexHome();
    await writeFile(join(codexHome, "auth.json"), "fixture", { mode: 0o644 });
    const report = await probeCodexCapabilities({
      codexHome,
      authMode: "chatgpt",
      selection: DEFAULT_MODEL_SELECTION,
      runner: { async probe() { return { supported: true }; } },
      ...currentUidOption,
    });
    expect(report.components.auth).toBe("failed");
    expect(report.remediation.join(" ")).toContain("0600");
  });

  it("probes only the one active pair in API-key mode", async () => {
    const calls: unknown[] = [];
    const report = await probeCodexCapabilities({
      codexHome: "/private/codex-home",
      authMode: "api_key",
      openAiApiKey: "test-key",
      selection: DEFAULT_MODEL_SELECTION,
      runner: {
        async probe(input) {
          calls.push(input);
          return { supported: true };
        },
      },
      fileSystem: {
        async mkdir() {},
        async chmod() {},
        async stat() {
          return {
            mode: 0o700,
            uid: 501,
            isDirectory: () => true,
            isFile: () => false,
          };
        },
      },
      currentUid: 501,
    });
    expect(report.ready).toBe(true);
    expect(calls).toEqual([
      { model: "gpt-5.6-luna", effort: "high" },
    ]);
    expect(report.selection).toMatchObject({
      modelId: "gpt-5.6-luna",
      reasoningEffort: "high",
      state: "ok",
    });
  });

  it("fails readiness without probing when no account model is available", async () => {
    const codexHome = await temporaryCodexHome();
    await writeFile(join(codexHome, "auth.json"), "fixture", { mode: 0o600 });
    let probes = 0;
    const report = await probeCodexCapabilities({
      codexHome,
      authMode: "chatgpt",
      selection: null,
      runner: {
        async probe() {
          probes += 1;
          return { supported: true };
        },
      },
      ...currentUidOption,
    });
    expect(report.ready).toBe(false);
    expect(report.components.models).toBe("failed");
    expect(report.selection).toBeNull();
    expect(probes).toBe(0);
  });

  it("does not retry another effort when the active pair is unsupported", async () => {
    const codexHome = await temporaryCodexHome();
    await writeFile(join(codexHome, "auth.json"), "fixture", { mode: 0o600 });
    const calls: string[] = [];
    const report = await probeCodexCapabilities({
      codexHome,
      authMode: "chatgpt",
      selection: DEFAULT_MODEL_SELECTION,
      runner: {
        async probe({ effort }) {
          calls.push(effort);
          return { supported: false, failure: "effort" };
        },
      },
      ...currentUidOption,
    });
    expect(report.ready).toBe(false);
    expect(calls).toEqual(["high"]);
    expect(report.remediation.join(" ")).toContain("high");
  });

  it("marks readiness false when cached ChatGPT auth is expired", async () => {
    const codexHome = await temporaryCodexHome();
    await writeFile(join(codexHome, "auth.json"), "expired", { mode: 0o600 });
    const report = await probeCodexCapabilities({
      codexHome,
      authMode: "chatgpt",
      selection: DEFAULT_MODEL_SELECTION,
      runner: {
        async probe() {
          return { supported: false, failure: "auth" };
        },
      },
      ...currentUidOption,
    });
    expect(report.ready).toBe(false);
    expect(report.components.auth).toBe("failed");
    expect(report.remediation.join(" ")).toContain("Re-enroll ChatGPT");
  });
});
