import { readdirSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildSpectrumCloudOptions,
  resolveSpectrumCloudCredentials,
  spectrumCredentialsFromEnvironment,
} from "../../../src/transport/spectrum.js";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return extname(entry.name) === ".ts" ? [path] : [];
  });
}

describe("Spectrum Cloud bootstrap", () => {
  it("uses explicit project credentials and the cloud iMessage provider", () => {
    const credentials = {
      projectId: "project-id",
      projectSecret: "project-secret",
    };
    const options = buildSpectrumCloudOptions(credentials);

    expect(options.projectId).toBe(credentials.projectId);
    expect(options.projectSecret).toBe(credentials.projectSecret);
    expect(options.providers).toHaveLength(1);
    expect(options.providers[0]).toMatchObject({
      __name: "imessage",
      __tag: "PlatformProviderConfig",
    });
  });

  it("maps only validated Spectrum environment fields", () => {
    expect(
      spectrumCredentialsFromEnvironment({
        SPECTRUM_PROJECT_ID: "project-id",
        SPECTRUM_PROJECT_SECRET: "project-secret",
      }),
    ).toEqual({
      projectId: "project-id",
      projectSecret: "project-secret",
    });
  });

  it("prefers persisted Photon credentials and preserves the legacy fallback", () => {
    const legacy = {
      SPECTRUM_PROJECT_ID: "legacy-project",
      SPECTRUM_PROJECT_SECRET: "legacy-secret",
    };
    expect(
      resolveSpectrumCloudCredentials(
        {
          photonProjectId: "persisted-project",
          spectrumProjectSecret: "persisted-secret",
        },
        legacy,
      ),
    ).toEqual({
      projectId: "persisted-project",
      projectSecret: "persisted-secret",
    });
    expect(resolveSpectrumCloudCredentials(undefined, legacy)).toEqual({
      projectId: "legacy-project",
      projectSecret: "legacy-secret",
    });
  });

  it("does not restore the Spectrum Express webhook adapter", () => {
    const offenders = sourceFiles(resolve("src")).filter((file) =>
      readFileSync(file, "utf8").includes("@spectrum-ts/express"),
    );

    expect(offenders).toEqual([]);
  });
});
