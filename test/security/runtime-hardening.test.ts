import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildCodexChildEnvironment } from "../../src/agent/child-environment.js";
import { createLogger } from "../../src/observability/logger.js";
import {
  PermissionEscalationError,
  enforcePermissionGrant,
  maximumPermissionForRole,
  resolvePermissionProfile,
} from "../../src/security/permissions.js";
import { OperationalRateLimits } from "../../src/security/rate-limits.js";
import { redactLogValue, redactSensitiveString } from "../../src/security/redaction.js";
import {
  assertCodexChildEnvironmentBoundary,
  auditStartupSecretBoundaries,
  buildCodexShellEnvironmentPolicy,
} from "../../src/security/secret-boundaries.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("permission, environment, secret, redaction, and abuse boundaries", () => {
  it("rejects model-requested permission broadening instead of downgrading or asking Codex", () => {
    expect(() => enforcePermissionGrant("workspace-write", "read")).toThrow(
      PermissionEscalationError,
    );
    expect(() => enforcePermissionGrant("network-read", "read")).toThrow(
      PermissionEscalationError,
    );
    expect(maximumPermissionForRole("collaborator", "workspace-write")).toBe(
      "read",
    );
    expect(maximumPermissionForRole("owner", "workspace-write")).toBe(
      "workspace-write",
    );
    expect(resolvePermissionProfile("approval-required")).toEqual({
      sandboxMode: "read-only",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      approvalPolicy: "never",
      consequentialActions: "propose-only",
    });
  });

  it("leaves protected server secrets unavailable to Codex and model-spawned shell commands", () => {
    const codexHome = resolve("test/.controlled-codex-home");
    const protectedValues = [
      "postgresql://agent:password@db/private",
      "spectrum-private-secret",
      "memory-private-secret",
      "encryption-private-secret",
    ];
    const child = buildCodexChildEnvironment({
      parentEnvironment: {
        PATH: "/usr/bin:/bin",
        HOME: "/service-home",
        DATABASE_URL: protectedValues[0],
        SPECTRUM_PROJECT_SECRET: protectedValues[1],
        SUPERMEMORY_API_KEY: protectedValues[2],
        APP_ENCRYPTION_KEY: protectedValues[3],
        AWS_SECRET_ACCESS_KEY: "cloud-private-secret",
      },
      codexHome,
      authMode: "chatgpt",
    });
    const shellPolicy = buildCodexShellEnvironmentPolicy(
      child,
      resolve("test/fixture-repository"),
    );

    expect(child["HOME"]).toBe(codexHome);
    expect(Object.keys(child).sort()).toEqual(["CODEX_HOME", "HOME", "PATH"]);
    expect(shellPolicy.inherit).toBe("none");
    expect(shellPolicy.experimental_use_profile).toBe(false);
    expect(shellPolicy.set).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: resolve("test/fixture-repository"),
    });
    const serialized = JSON.stringify({ child, shellPolicy });
    for (const secret of [...protectedValues, "cloud-private-secret"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("requires an exact task-variable allowlist and keeps API credentials out of the model shell", () => {
    const codexHome = resolve("test/.controlled-codex-home");
    expect(() =>
      buildCodexChildEnvironment({
        parentEnvironment: { PATH: "/usr/bin" },
        codexHome,
        authMode: "chatgpt",
        safeTaskEnvironment: { AGENT_TASK_SMUGGLED_SECRET: "secret" },
      }),
    ).toThrow(/explicit child-environment allowlist/);

    const child = buildCodexChildEnvironment({
      parentEnvironment: { PATH: "/usr/bin" },
      codexHome,
      authMode: "api_key",
      openAiApiKey: "explicit-api-key",
    });
    expect(child["OPENAI_API_KEY"]).toBe("explicit-api-key");
    expect(
      buildCodexShellEnvironmentPolicy(child, resolve("test/workspace")).set,
    ).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("audits path separation, ownership modes, symlinks, and protected values before startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "startup-boundary-"));
    temporaryDirectories.push(root);
    const codexHome = join(root, "codex-home");
    const workspaceRoot = join(root, "workspaces");
    await mkdir(codexHome);
    await mkdir(workspaceRoot);
    await chmod(codexHome, 0o700);
    await writeFile(join(codexHome, "auth.json"), "{}", { mode: 0o600 });
    const child = {
      PATH: "/usr/bin:/bin",
      HOME: codexHome,
      CODEX_HOME: codexHome,
    };
    await expect(
      auditStartupSecretBoundaries({
        codexHome,
        workspaceRoot,
        authMode: "chatgpt",
        childEnvironment: child,
        protectedValues: ["a-protected-service-value"],
      }),
    ).resolves.toMatchObject({
      ok: true,
      authFile: "private",
      childEnvironment: "allowlisted",
    });

    await chmod(codexHome, 0o755);
    await expect(
      auditStartupSecretBoundaries({
        codexHome,
        workspaceRoot,
        authMode: "chatgpt",
        childEnvironment: child,
      }),
    ).rejects.toThrow(/group\/other/);

    const link = join(root, "codex-link");
    await symlink(workspaceRoot, link);
    await expect(
      auditStartupSecretBoundaries({
        codexHome: link,
        workspaceRoot: join(root, "other-workspaces"),
        authMode: "chatgpt",
        childEnvironment: { ...child, HOME: link, CODEX_HOME: link },
      }),
    ).rejects.toThrow(/symlink/);
  });

  it("rejects protected literals even when hidden under arbitrary environment keys", () => {
    const secret = "literal-service-secret-value";
    expect(() =>
      assertCodexChildEnvironmentBoundary(
        {
          PATH: "/usr/bin",
          HOME: "/private/codex",
          CODEX_HOME: "/private/codex",
          AGENT_TASK_LABEL: `prefix-${secret}`,
        },
        {
          authMode: "chatgpt",
          allowedTaskKeys: ["AGENT_TASK_LABEL"],
          protectedValues: [secret],
        },
      ),
    ).toThrow(/protected service secret/);
  });

  it("redacts owner handles and provider codes from real logger output", () => {
    const protectedCredential = "provider-credential-with-unknown-format";
    const photonDeviceCode = "PHOTON-DEVICE-CODE-PRIVATE";
    const chatGptDeviceCode = "CHATGPT-DEVICE-CODE-PRIVATE";
    const verificationUrl = "https://private.example/device?code=secret";
    const redacted = redactLogValue(
      {
        safeLookingField: `provider said ${protectedCredential}`,
        sender: "owner@example.com",
        text: "private request",
        nested: { databaseUrl: "postgresql://user:pass@db/private" },
      },
      { protectedValues: [protectedCredential] },
    );
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain(protectedCredential);
    expect(serialized).not.toContain("owner@example.com");
    expect(serialized).not.toContain("private request");
    expect(serialized).not.toContain("user:pass");
    expect(redactSensitiveString(`id:${protectedCredential}`, [protectedCredential]))
      .not.toContain(protectedCredential);

    const output: string[] = [];
    const logger = createLogger(
      {
        base: null,
        protectedValues: [protectedCredential],
      },
      { write: (chunk: string) => (output.push(chunk), true) },
    );
    logger.error(
      {
        providerDetail: protectedCredential,
        photonDeviceCode,
        chatGptDeviceCode,
        verificationUrl,
      },
      "owner@example.com provider failure",
    );
    const logOutput = output.join("");
    for (const privateValue of [
      protectedCredential,
      photonDeviceCode,
      chatGptDeviceCode,
      verificationUrl,
      "owner@example.com",
    ]) {
      expect(logOutput).not.toContain(privateValue);
    }
  });

  it("enforces independent per-owner message and task windows", () => {
    const limits = new OperationalRateLimits({
      messagesPerOwner: { limit: 2, windowMs: 1_000 },
      tasksPerOwner: { limit: 1, windowMs: 10_000 },
    });
    const start = new Date("2026-08-14T12:00:00Z");
    expect(limits.consumeMessage("owner-a", start).allowed).toBe(true);
    expect(limits.consumeMessage("owner-a", start).allowed).toBe(true);
    expect(limits.consumeMessage("owner-a", start).allowed).toBe(false);
    expect(limits.consumeMessage("owner-b", start).allowed).toBe(true);
    expect(limits.consumeTask("owner-a", start).allowed).toBe(true);
    expect(limits.consumeTask("owner-a", start).allowed).toBe(false);
    expect(
      limits.consumeMessage("owner-a", new Date(start.getTime() + 1_001)).allowed,
    ).toBe(true);
  });
});
