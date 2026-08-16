import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { CONTRACT_VERSION } from "../../src/contracts/version.js";

interface PackageManifest {
  name: string;
  engines: { node: string };
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

const manifest = JSON.parse(
  readFileSync(resolve("package.json"), "utf8"),
) as PackageManifest;

describe("repository foundation", () => {
  it("identifies the frozen shared contract version", () => {
    expect(CONTRACT_VERSION).toBe("contracts-v1");
  });

  it("pins every direct dependency and keeps Codex CLI/SDK versions aligned", () => {
    const versions = [
      ...Object.values(manifest.dependencies),
      ...Object.values(manifest.devDependencies),
    ];

    expect(manifest.name).toBe("imessage-codex-agent");
    expect(manifest.engines.node).toBe("^22.12.0 || >=24.0.0");
    expect(versions.every((version) => /^\d+\.\d+\.\d+$/u.test(version))).toBe(
      true,
    );
    expect(manifest.dependencies["@openai/codex"]).toBe(
      manifest.dependencies["@openai/codex-sdk"],
    );
  });

  it("keeps webhook adapters out of the gRPC-oriented foundation", () => {
    expect(manifest.dependencies["@spectrum-ts/express"]).toBeUndefined();
    expect(manifest.dependencies["@spectrum-ts/webhook"]).toBeUndefined();
  });
});
