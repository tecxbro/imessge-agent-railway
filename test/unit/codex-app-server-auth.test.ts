import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CodexAppServerAuth,
  type CodexAppServerConnection,
} from "../../src/agent/codex-app-server-auth.js";

class FakeConnection implements CodexAppServerConnection {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly notifications: Array<{ method: string; params: unknown }> = [];
  readonly #notificationListeners = new Set<
    (notification: { method: string; params: unknown }) => void
  >();
  readonly #closedListeners = new Set<() => void>();
  connected = false;
  closed = false;
  planType = "plus";
  modelPages: Record<string, unknown> = {
    first: {
      data: [
        {
          id: "gpt-5.6-luna",
          model: "gpt-5.6-luna",
          displayName: "GPT-5.6 Luna",
          supportedReasoningEfforts: [
            { reasoningEffort: "medium", description: "Default" },
            { reasoningEffort: "high", description: "More reasoning" },
          ],
          defaultReasoningEffort: "medium",
          isDefault: true,
        },
      ],
      nextCursor: null,
    },
  };
  loginId = "3ea32ef5-f9b0-4d0e-b59c-d9838db91f92";
  completeDuringLoginStart = false;

  public constructor(private readonly codexHome: string) {}

  public async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "initialize") {
      return {
        userAgent: "fixture",
        codexHome: this.codexHome,
        platformFamily: "unix",
        platformOs: "linux",
      };
    }
    if (method === "account/read") {
      return {
        account: this.connected
          ? { type: "chatgpt", email: "private@example.com", planType: this.planType }
          : null,
        requiresOpenaiAuth: true,
      };
    }
    if (method === "model/list") {
      const cursor =
        typeof params === "object" && params !== null && "cursor" in params
          ? String(params.cursor)
          : "first";
      return this.modelPages[cursor];
    }
    if (method === "account/login/start") {
      if (this.completeDuringLoginStart) {
        this.emit("account/login/completed", {
          loginId: this.loginId,
          success: true,
          error: null,
          onboardingEntrypoint: null,
        });
      }
      return {
        type: "chatgptDeviceCode",
        loginId: this.loginId,
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-1234",
      };
    }
    throw new Error("unexpected fixture request");
  }

  public notify(method: string, params: unknown): void {
    this.notifications.push({ method, params });
  }

  public onNotification(
    listener: (notification: { method: string; params: unknown }) => void,
  ): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }

  public onClosed(listener: () => void): () => void {
    this.#closedListeners.add(listener);
    return () => this.#closedListeners.delete(listener);
  }

  public async close(): Promise<void> {
    this.closed = true;
    this.disconnect();
  }

  public disconnect(): void {
    for (const listener of this.#closedListeners) {
      listener();
    }
  }

  public emit(method: string, params: unknown): void {
    for (const listener of this.#notificationListeners) {
      listener({ method, params });
    }
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function temporaryCodexHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codex-app-server-auth-"));
  temporaryDirectories.push(directory);
  await chmod(directory, 0o700);
  return directory;
}

describe("Codex App Server ChatGPT authentication", () => {
  it("performs the pinned App Server handshake and exposes only the device ceremony", async () => {
    const codexHome = await temporaryCodexHome();
    const connection = new FakeConnection(codexHome);
    const connected = vi.fn();
    const auth = new CodexAppServerAuth({
      codexHome,
      parentEnvironment: { PATH: process.env["PATH"] },
      connectionFactory: async () => connection,
    });
    auth.onConnected(connected);

    await expect(auth.initialize()).resolves.toEqual({
      state: "not_connected",
    });
    expect(connection.requests).toEqual([
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
    expect(connection.notifications).toEqual([
      { method: "initialized", params: {} },
    ]);

    await expect(auth.start()).resolves.toEqual({
      state: "awaiting_authorization",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-1234",
    });
    expect(connection.requests.at(-1)).toEqual({
      method: "account/login/start",
      params: { type: "chatgptDeviceCode" },
    });

    await writeFile(join(codexHome, "auth.json"), "fixture", { mode: 0o600 });
    connection.connected = true;
    connection.emit("account/login/completed", {
      loginId: "3ea32ef5-f9b0-4d0e-b59c-d9838db91f92",
      success: true,
      error: null,
      onboardingEntrypoint: null,
    });
    await vi.waitFor(() => expect(auth.status()).toEqual({ state: "connected" }));
    expect(connected).toHaveBeenCalledOnce();
    expect(auth.capabilities()).toMatchObject({
      state: "available",
      planType: "plus",
      models: [{ id: "gpt-5.6-luna" }],
    });
    await auth.close();
    expect(connection.closed).toBe(true);
  });

  it("restores connected status from account/read without starting another login", async () => {
    const codexHome = await temporaryCodexHome();
    const connection = new FakeConnection(codexHome);
    connection.connected = true;
    const auth = new CodexAppServerAuth({
      codexHome,
      parentEnvironment: { PATH: process.env["PATH"] },
      connectionFactory: async () => connection,
    });

    await expect(auth.initialize()).resolves.toEqual({ state: "connected" });
    expect(auth.capabilities().planType).toBe("plus");
    await expect(auth.start()).resolves.toEqual({ state: "connected" });
    expect(
      connection.requests.filter(
        (request) => request.method === "account/login/start",
      ),
    ).toHaveLength(0);
    await auth.close();
  });

  it("filters unsupported reasoning efforts without rejecting the account catalog", async () => {
    const codexHome = await temporaryCodexHome();
    const connection = new FakeConnection(codexHome);
    connection.connected = true;
    connection.modelPages = {
      first: {
        data: [
          {
            id: "gpt-5.6-sol",
            model: "gpt-5.6-sol",
            displayName: "GPT-5.6 Sol",
            supportedReasoningEfforts: [
              { reasoningEffort: "high", description: "High" },
              { reasoningEffort: "ultra", description: "Ultra" },
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
          {
            id: "gpt-5.6-terra",
            model: "gpt-5.6-terra",
            displayName: "GPT-5.6 Terra",
            supportedReasoningEfforts: [
              { reasoningEffort: "ultra", description: "Ultra" },
            ],
            defaultReasoningEffort: "ultra",
            isDefault: false,
          },
        ],
        nextCursor: null,
      },
    };
    const auth = new CodexAppServerAuth({
      codexHome,
      parentEnvironment: { PATH: process.env["PATH"] },
      connectionFactory: async () => connection,
    });

    await expect(auth.initialize()).resolves.toEqual({ state: "connected" });
    expect(auth.capabilities()).toMatchObject({
      state: "available",
      models: [
        {
          id: "gpt-5.6-sol",
          supportedReasoningEfforts: [
            { reasoningEffort: "high", description: "High" },
          ],
        },
        {
          id: "gpt-5.6-luna",
          supportedReasoningEfforts: [
            { reasoningEffort: "medium", description: "Medium" },
          ],
        },
      ],
    });
    await auth.close();
  });

  it("does not report a successful login as failed when catalog refresh fails", async () => {
    const codexHome = await temporaryCodexHome();
    const connection = new FakeConnection(codexHome);
    const auth = new CodexAppServerAuth({
      codexHome,
      parentEnvironment: { PATH: process.env["PATH"] },
      connectionFactory: async () => connection,
    });

    await auth.initialize();
    await auth.start();
    await writeFile(join(codexHome, "auth.json"), "fixture", { mode: 0o600 });
    connection.connected = true;
    connection.modelPages = {
      first: { data: "not-an-array", nextCursor: null },
    };
    connection.emit("account/login/completed", {
      loginId: connection.loginId,
      success: true,
      error: null,
      onboardingEntrypoint: null,
    });

    await vi.waitFor(() => expect(auth.status()).toEqual({ state: "connected" }));
    expect(auth.capabilities().state).toBe("unavailable");
    await auth.close();
  });

  it("keeps an authenticated ChatGPT account connected when its catalog is malformed", async () => {
    const codexHome = await temporaryCodexHome();
    const connection = new FakeConnection(codexHome);
    connection.connected = true;
    connection.modelPages = {
      first: { data: "not-an-array", nextCursor: null },
    };
    const auth = new CodexAppServerAuth({
      codexHome,
      parentEnvironment: { PATH: process.env["PATH"] },
      connectionFactory: async () => connection,
    });

    await expect(auth.initialize()).resolves.toEqual({ state: "connected" });
    expect(auth.capabilities()).toMatchObject({
      state: "unavailable",
      models: [],
    });
    await auth.close();
  });

  it("closes a connection that finishes opening during shutdown", async () => {
    const codexHome = await temporaryCodexHome();
    const connection = new FakeConnection(codexHome);
    let resolveConnection:
      | ((value: CodexAppServerConnection) => void)
      | undefined;
    const pendingConnection = new Promise<CodexAppServerConnection>(
      (resolvePending) => {
        resolveConnection = resolvePending;
      },
    );
    const auth = new CodexAppServerAuth({
      codexHome,
      parentEnvironment: { PATH: process.env["PATH"] },
      connectionFactory: async () => await pendingConnection,
    });

    const initialize = auth.initialize();
    await Promise.resolve();
    const closing = auth.close();
    resolveConnection?.(connection);

    await closing;
    await initialize;
    expect(connection.closed).toBe(true);
    expect(auth.status()).toEqual({
      state: "failed",
      code: "CHATGPT_APP_SERVER_UNAVAILABLE",
    });
  });

  it("correlates an immediate completion on a retry with the new login", async () => {
    const codexHome = await temporaryCodexHome();
    const connection = new FakeConnection(codexHome);
    const auth = new CodexAppServerAuth({
      codexHome,
      parentEnvironment: { PATH: process.env["PATH"] },
      connectionFactory: async () => connection,
    });
    await auth.initialize();
    await auth.start();
    connection.emit("account/login/completed", {
      loginId: connection.loginId,
      success: false,
      error: "fixture rejection",
      onboardingEntrypoint: null,
    });
    await vi.waitFor(() =>
      expect(auth.status()).toEqual({
        state: "failed",
        code: "CHATGPT_LOGIN_FAILED",
      }),
    );

    connection.loginId = "retry-login-id";
    connection.connected = true;
    connection.completeDuringLoginStart = true;
    await writeFile(join(codexHome, "auth.json"), "fixture", { mode: 0o600 });

    await expect(auth.start()).resolves.toEqual({ state: "connected" });
    await auth.close();
  });

  it("does not reopen App Server after shutdown begins", async () => {
    const codexHome = await temporaryCodexHome();
    const connection = new FakeConnection(codexHome);
    const connectionFactory = vi.fn(async () => connection);
    const auth = new CodexAppServerAuth({
      codexHome,
      parentEnvironment: { PATH: process.env["PATH"] },
      connectionFactory,
    });
    await auth.initialize();
    await auth.close();

    await expect(auth.initialize()).resolves.toEqual({
      state: "failed",
      code: "CHATGPT_APP_SERVER_UNAVAILABLE",
    });
    expect(connectionFactory).toHaveBeenCalledOnce();
  });

  it("refreshes plan and follows every visible model-list page on account/updated", async () => {
    const codexHome = await temporaryCodexHome();
    const connection = new FakeConnection(codexHome);
    connection.connected = true;
    connection.modelPages = {
      first: {
        data: [
          {
            id: "gpt-5.6-luna",
            model: "gpt-5.6-luna",
            displayName: "GPT-5.6 Luna",
            supportedReasoningEfforts: [
              { reasoningEffort: "high", description: "High" },
            ],
            defaultReasoningEffort: "high",
            isDefault: true,
          },
        ],
        nextCursor: "page-2",
      },
      "page-2": {
        data: [
          {
            id: "gpt-5.6-terra",
            model: "gpt-5.6-terra",
            displayName: "GPT-5.6 Terra",
            supportedReasoningEfforts: [
              { reasoningEffort: "medium", description: "Medium" },
            ],
            defaultReasoningEffort: "medium",
            isDefault: false,
          },
        ],
        nextCursor: null,
      },
    };
    const auth = new CodexAppServerAuth({
      codexHome,
      parentEnvironment: { PATH: process.env["PATH"] },
      connectionFactory: async () => connection,
    });
    await auth.initialize();

    connection.planType = "business";
    connection.emit("account/updated", {
      authMode: "chatgpt",
      planType: "business",
    });

    await vi.waitFor(() => {
      expect(auth.capabilities()).toMatchObject({
        state: "available",
        planType: "business",
        models: [
          { id: "gpt-5.6-luna" },
          { id: "gpt-5.6-terra" },
        ],
      });
    });
    expect(
      connection.requests.filter((request) => request.method === "model/list"),
    ).toContainEqual({
      method: "model/list",
      params: { limit: 100, includeHidden: false, cursor: "page-2" },
    });
    await auth.close();
  });

  it("reconnects App Server and refreshes account capabilities", async () => {
    const codexHome = await temporaryCodexHome();
    const first = new FakeConnection(codexHome);
    first.connected = true;
    const second = new FakeConnection(codexHome);
    second.connected = true;
    second.planType = "pro";
    const connections = [first, second];
    const connectionFactory = vi.fn(async () => {
      const connection = connections.shift();
      if (connection === undefined) {
        throw new Error("no fixture connection");
      }
      return connection;
    });
    const auth = new CodexAppServerAuth({
      codexHome,
      parentEnvironment: { PATH: process.env["PATH"] },
      connectionFactory,
    });
    await auth.initialize();

    first.disconnect();

    await vi.waitFor(() =>
      expect(auth.capabilities()).toMatchObject({
        state: "available",
        planType: "pro",
      }),
    );
    expect(connectionFactory).toHaveBeenCalledTimes(2);
    expect(second.requests.map((request) => request.method)).toEqual([
      "initialize",
      "account/read",
      "model/list",
    ]);
    await auth.close();
  });

  it("fails closed on malformed catalog responses and clears capabilities on logout", async () => {
    const codexHome = await temporaryCodexHome();
    const connection = new FakeConnection(codexHome);
    connection.connected = true;
    const auth = new CodexAppServerAuth({
      codexHome,
      parentEnvironment: { PATH: process.env["PATH"] },
      connectionFactory: async () => connection,
    });
    await auth.initialize();
    expect(auth.capabilities().state).toBe("available");

    connection.modelPages = { first: { data: "not-an-array", nextCursor: null } };
    await expect(auth.refreshCapabilities()).resolves.toMatchObject({
      state: "unavailable",
      planType: null,
      models: [],
    });

    connection.connected = false;
    connection.modelPages = {
      first: { data: [], nextCursor: null },
    };
    connection.emit("account/updated", { authMode: null, planType: null });
    await vi.waitFor(() =>
      expect(auth.capabilities()).toMatchObject({
        state: "unavailable",
        planType: null,
        models: [],
      }),
    );
    expect(auth.status()).toEqual({ state: "not_connected" });
    await auth.close();
  });
});
