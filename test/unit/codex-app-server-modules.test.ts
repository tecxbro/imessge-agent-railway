import { constants } from "node:fs";
import {
  access,
  mkdtemp,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CHATGPT_SETUP_ERROR_CODES,
  CodexAppServerAuth,
  type CodexAppServerConnection,
} from "../../src/agent/codex-app-server-auth.js";
import { validateAndRestrictCodexAuthFile } from "../../src/agent/codex-auth-file.js";
import { ChatGptAuthStateMachine } from "../../src/agent/chatgpt-auth-state-machine.js";
import { loadCodexAccountCapabilities } from "../../src/agent/codex-app-server/capability-source.js";
import { resolvePinnedCodexExecutable } from "../../src/agent/codex-app-server/executable.js";
import {
  deviceLoginSchema,
  responseEnvelopeSchema,
} from "../../src/agent/codex-app-server/protocol.js";
import { StdioCodexAppServerConnection } from "../../src/agent/codex-app-server/transport.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function temporaryCodexHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-app-modules-"));
  temporaryDirectories.push(directory);
  return directory;
}

function connectionWithRequest(
  request: CodexAppServerConnection["request"],
): CodexAppServerConnection {
  return {
    request,
    notify() {},
    onNotification() {
      return () => undefined;
    },
    onClosed() {
      return () => undefined;
    },
    async close() {},
  };
}

describe("Codex App Server compatibility facade", () => {
  it("preserves the public error-code list and initialize handshake", async () => {
    const codexHome = await temporaryCodexHome();
    const resolvedHome = await realpath(codexHome);
    const requests: Array<{ method: string; params: unknown }> = [];
    const notifications: Array<{ method: string; params: unknown }> = [];
    const connection: CodexAppServerConnection = {
      async request(method, params) {
        requests.push({ method, params });
        if (method === "initialize") {
          return { codexHome: resolvedHome };
        }
        if (method === "account/read") {
          return { account: null, requiresOpenaiAuth: true };
        }
        throw new Error(`Unexpected request: ${method}`);
      },
      notify(method, params) {
        notifications.push({ method, params });
      },
      onNotification() {
        return () => undefined;
      },
      onClosed() {
        return () => undefined;
      },
      async close() {},
    };
    const auth = new CodexAppServerAuth({
      codexHome,
      parentEnvironment: { PATH: process.env["PATH"] },
      connectionFactory: async () => connection,
    });

    expect(CHATGPT_SETUP_ERROR_CODES).toEqual([
      "CHATGPT_SETUP_UNAVAILABLE",
      "CHATGPT_APP_SERVER_UNAVAILABLE",
      "CHATGPT_LOGIN_START_FAILED",
      "CHATGPT_LOGIN_FAILED",
      "CHATGPT_CREDENTIAL_SAVE_FAILED",
    ]);
    await expect(auth.initialize()).resolves.toEqual({
      state: "not_connected",
    });
    expect(requests).toEqual([
      {
        method: "initialize",
        params: {
          clientInfo: {
            name: "imessage_codex_agent",
            title: "iMessage Codex Agent",
            version: "0.1.0",
          },
        },
      },
      { method: "account/read", params: { refreshToken: false } },
    ]);
    expect(notifications).toEqual([{ method: "initialized", params: {} }]);
    await auth.close();
  });
});

describe("Codex App Server protocol and transport modules", () => {
  it("validates response exclusivity and the bounded OpenAI device URL", () => {
    expect(
      responseEnvelopeSchema.safeParse({ id: 1, result: { ok: true } }).success,
    ).toBe(true);
    expect(
      responseEnvelopeSchema.safeParse({
        id: 1,
        result: {},
        error: { code: -1, message: "ambiguous" },
      }).success,
    ).toBe(false);
    expect(
      deviceLoginSchema.safeParse({
        type: "chatgptDeviceCode",
        loginId: "login-1",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-1234",
      }).success,
    ).toBe(true);
    expect(
      deviceLoginSchema.safeParse({
        type: "chatgptDeviceCode",
        loginId: "login-1",
        verificationUrl: "https://auth.openai.com.example.test/codex/device",
        userCode: "ABCD-1234",
      }).success,
    ).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "exchanges newline-delimited messages through the stdio transport",
    async () => {
      const codexHome = await temporaryCodexHome();
      const executablePath = join(codexHome, "fake-app-server");
      await writeFile(
        executablePath,
        `#!/usr/bin/env node
let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  const lines = buffered.split("\\n");
  buffered = lines.pop() ?? "";
  for (const line of lines) {
    if (line.length === 0) continue;
    const message = JSON.parse(line);
    if (message.method === "ping" && message.id !== undefined) {
      process.stdout.write(JSON.stringify({ id: message.id, result: { echo: message.params } }) + "\\n");
      process.stdout.write(JSON.stringify({ method: "fixture/notice", params: { ok: true } }) + "\\n");
    }
  }
});
process.on("SIGTERM", () => process.exit(0));
`,
        { mode: 0o700 },
      );
      const connection = await StdioCodexAppServerConnection.connect({
        codexHome,
        parentEnvironment: { PATH: process.env["PATH"] },
        executablePath,
        requestTimeoutMs: 1_000,
      });
      const notifications: Array<{ method: string; params: unknown }> = [];
      connection.onNotification((notification) => {
        notifications.push(notification);
      });

      await expect(connection.request("ping", { value: 7 })).resolves.toEqual({
        echo: { value: 7 },
      });
      await vi.waitFor(() =>
        expect(notifications).toEqual([
          { method: "fixture/notice", params: { ok: true } },
        ]),
      );
      await connection.close();
    },
  );

  it("resolves the executable shipped by the pinned Codex package", async () => {
    const executable = resolvePinnedCodexExecutable();

    expect(isAbsolute(executable)).toBe(true);
    expect(basename(executable)).toBe(
      process.platform === "win32" ? "codex.exe" : "codex",
    );
    await expect(access(executable, constants.X_OK)).resolves.toBeUndefined();
  });
});

describe("Codex account capability source", () => {
  it("paginates visible models and filters unsupported efforts", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const refreshedAt = new Date("2026-08-18T12:00:00.000Z");
    const connection = connectionWithRequest(async (method, params) => {
      requests.push({ method, params });
      if (method === "account/read") {
        return {
          account: { type: "chatgpt", email: null, planType: "business" },
          requiresOpenaiAuth: true,
        };
      }
      if (method === "model/list") {
        const cursor =
          typeof params === "object" && params !== null && "cursor" in params
            ? String(params.cursor)
            : null;
        if (cursor === null) {
          return {
            data: [
              {
                id: "gpt-5.6-sol",
                model: "gpt-5.6-sol",
                displayName: "GPT-5.6 Sol",
                supportedReasoningEfforts: [
                  { reasoningEffort: "high", description: "High" },
                  { reasoningEffort: "ultra", description: "Future" },
                ],
                defaultReasoningEffort: "high",
                isDefault: true,
              },
            ],
            nextCursor: "page-2",
          };
        }
        return {
          data: [
            {
              id: "gpt-5.6-luna",
              model: "gpt-5.6-luna",
              displayName: "GPT-5.6 Luna",
              supportedReasoningEfforts: [
                { reasoningEffort: "medium", description: "Medium" },
              ],
              defaultReasoningEffort: "medium",
              isDefault: false,
            },
          ],
          nextCursor: null,
        };
      }
      throw new Error(`Unexpected request: ${method}`);
    });

    await expect(
      loadCodexAccountCapabilities(connection, () => refreshedAt),
    ).resolves.toEqual({
      accountState: "connected",
      snapshot: {
        state: "available",
        planType: "business",
        models: [
          {
            id: "gpt-5.6-sol",
            model: "gpt-5.6-sol",
            displayName: "GPT-5.6 Sol",
            supportedReasoningEfforts: [
              { reasoningEffort: "high", description: "High" },
            ],
            defaultReasoningEffort: "high",
            isDefault: true,
          },
          {
            id: "gpt-5.6-luna",
            model: "gpt-5.6-luna",
            displayName: "GPT-5.6 Luna",
            supportedReasoningEfforts: [
              { reasoningEffort: "medium", description: "Medium" },
            ],
            defaultReasoningEffort: "medium",
            isDefault: false,
          },
        ],
        refreshedAt,
      },
    });
    expect(requests).toEqual([
      { method: "account/read", params: { refreshToken: false } },
      {
        method: "model/list",
        params: { limit: 100, includeHidden: false },
      },
      {
        method: "model/list",
        params: { limit: 100, includeHidden: false, cursor: "page-2" },
      },
    ]);
  });
});

describe("ChatGPT auth state and credential file modules", () => {
  it("drives the initialize state directly from a fake connection", async () => {
    const codexHome = await temporaryCodexHome();
    const resolvedHome = await realpath(codexHome);
    const machine = new ChatGptAuthStateMachine({
      codexHome,
      connectionFactory: async () =>
        connectionWithRequest(async (method) => {
          if (method === "initialize") {
            return { codexHome: resolvedHome };
          }
          if (method === "account/read") {
            return { account: null, requiresOpenaiAuth: true };
          }
          throw new Error(`Unexpected request: ${method}`);
        }),
    });

    await expect(machine.initialize()).resolves.toEqual({
      state: "not_connected",
    });
    await machine.close();
  });

  it("restricts the persisted auth file to owner-only access", async () => {
    const codexHome = await temporaryCodexHome();
    const authPath = join(codexHome, "auth.json");
    await writeFile(authPath, "fixture", { mode: 0o666 });

    await validateAndRestrictCodexAuthFile(codexHome);

    expect((await stat(authPath)).mode & 0o777).toBe(0o600);
  });
});
