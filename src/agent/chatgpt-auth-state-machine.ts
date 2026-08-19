import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import {
  cloneCapabilitiesSnapshot,
  type CapabilitiesListener,
  type CodexAccountCapabilitiesSnapshot,
} from "./codex-account-capabilities.js";
import { validateAndRestrictCodexAuthFile } from "./codex-auth-file.js";
import {
  loadCodexAccountCapabilities,
  type CodexAccountState,
} from "./codex-app-server/capability-source.js";
import {
  accountUpdatedSchema,
  CodexAppServerProtocolError,
  deviceLoginSchema,
  initializeResponseSchema,
  loginCompletedSchema,
  type AppServerNotification,
  type LoginCompleted,
} from "./codex-app-server/protocol.js";
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionFactory,
} from "./codex-app-server/transport.js";

export const CHATGPT_SETUP_ERROR_CODES = [
  "CHATGPT_SETUP_UNAVAILABLE",
  "CHATGPT_APP_SERVER_UNAVAILABLE",
  "CHATGPT_LOGIN_START_FAILED",
  "CHATGPT_LOGIN_FAILED",
  "CHATGPT_CREDENTIAL_SAVE_FAILED",
] as const;

export type ChatGptSetupErrorCode =
  (typeof CHATGPT_SETUP_ERROR_CODES)[number];

export type ChatGptSetupStatus =
  | { state: "not_connected" }
  | { state: "starting" }
  | {
      state: "awaiting_authorization";
      verificationUrl: string;
      userCode: string;
    }
  | { state: "connected" }
  | { state: "failed"; code: ChatGptSetupErrorCode };

export type ConnectedListener = () => void | Promise<void>;

export interface ChatGptSetupController {
  initialize(): Promise<ChatGptSetupStatus>;
  start(): Promise<ChatGptSetupStatus>;
  status(): ChatGptSetupStatus;
  capabilities(): CodexAccountCapabilitiesSnapshot;
  refreshCapabilities(): Promise<CodexAccountCapabilitiesSnapshot>;
  onCapabilitiesChanged(listener: CapabilitiesListener): () => void;
  onConnected(listener: ConnectedListener): () => void;
  close(): Promise<void>;
}

export interface ChatGptAuthStateMachineOptions {
  codexHome: string;
  connectionFactory: CodexAppServerConnectionFactory;
}

export class ChatGptAuthStateMachine implements ChatGptSetupController {
  readonly #codexHome: string;
  readonly #connectionFactory: CodexAppServerConnectionFactory;
  readonly #connectedListeners = new Set<ConnectedListener>();
  readonly #capabilitiesListeners = new Set<CapabilitiesListener>();
  #connection: CodexAppServerConnection | undefined;
  #connecting: Promise<CodexAppServerConnection> | undefined;
  #starting: Promise<ChatGptSetupStatus> | undefined;
  #capabilitiesRefresh:
    | Promise<CodexAccountCapabilitiesSnapshot>
    | undefined;
  #status: ChatGptSetupStatus = { state: "not_connected" };
  #capabilitiesSnapshot: CodexAccountCapabilitiesSnapshot = {
    state: "unavailable",
    planType: null,
    models: [],
    refreshedAt: null,
  };
  #accountState: CodexAccountState = "unknown";
  #loginId: string | undefined;
  readonly #earlyCompletions = new Map<string, LoginCompleted>();
  #closing = false;

  public constructor(options: ChatGptAuthStateMachineOptions) {
    this.#codexHome = resolve(options.codexHome);
    this.#connectionFactory = options.connectionFactory;
  }

  public status(): ChatGptSetupStatus {
    return { ...this.#status };
  }

  public onConnected(listener: ConnectedListener): () => void {
    this.#connectedListeners.add(listener);
    return () => this.#connectedListeners.delete(listener);
  }

  public capabilities(): CodexAccountCapabilitiesSnapshot {
    return cloneCapabilitiesSnapshot(this.#capabilitiesSnapshot);
  }

  public onCapabilitiesChanged(listener: CapabilitiesListener): () => void {
    this.#capabilitiesListeners.add(listener);
    return () => this.#capabilitiesListeners.delete(listener);
  }

  public async refreshCapabilities(): Promise<CodexAccountCapabilitiesSnapshot> {
    if (this.#capabilitiesRefresh !== undefined) {
      return await this.#capabilitiesRefresh;
    }
    this.#capabilitiesRefresh = this.#refreshCapabilities();
    try {
      return await this.#capabilitiesRefresh;
    } finally {
      this.#capabilitiesRefresh = undefined;
    }
  }

  public async initialize(): Promise<ChatGptSetupStatus> {
    try {
      await this.#ensureConnection();
      await this.refreshCapabilities();
      this.#status =
        this.#accountState === "connected"
          ? { state: "connected" }
          : this.#accountState === "not_connected"
            ? { state: "not_connected" }
            : {
                state: "failed",
                code: "CHATGPT_APP_SERVER_UNAVAILABLE",
              };
    } catch {
      this.#status = {
        state: "failed",
        code: "CHATGPT_APP_SERVER_UNAVAILABLE",
      };
    }
    return this.status();
  }

  public async start(): Promise<ChatGptSetupStatus> {
    if (
      this.#status.state === "connected" ||
      this.#status.state === "awaiting_authorization" ||
      this.#status.state === "starting"
    ) {
      return this.status();
    }
    if (this.#starting !== undefined) {
      return await this.#starting;
    }
    this.#starting = this.#startDeviceLogin();
    try {
      return await this.#starting;
    } finally {
      this.#starting = undefined;
    }
  }

  public async close(): Promise<void> {
    this.#closing = true;
    this.#loginId = undefined;
    this.#earlyCompletions.clear();
    await this.#replaceCapabilities({
      state: "unavailable",
      planType: null,
      models: [],
      refreshedAt: null,
    });
    const connection = this.#connection;
    const connecting = this.#connecting;
    this.#connection = undefined;
    await connection?.close();
    if (connecting !== undefined) {
      await connecting.then((pending) => pending.close()).catch(() => undefined);
    }
    this.#connecting = undefined;
  }

  async #startDeviceLogin(): Promise<ChatGptSetupStatus> {
    this.#loginId = undefined;
    this.#earlyCompletions.clear();
    this.#status = { state: "starting" };
    try {
      const connection = await this.#ensureConnection();
      const login = deviceLoginSchema.parse(
        await connection.request("account/login/start", {
          type: "chatgptDeviceCode",
        }),
      );
      if (this.status().state !== "starting") {
        return this.status();
      }
      this.#loginId = login.loginId;
      this.#status = {
        state: "awaiting_authorization",
        verificationUrl: login.verificationUrl,
        userCode: login.userCode,
      };
      const earlyCompletion = this.#earlyCompletions.get(login.loginId);
      this.#earlyCompletions.clear();
      if (earlyCompletion !== undefined) {
        await this.#completeLogin(earlyCompletion);
      }
    } catch {
      this.#loginId = undefined;
      this.#earlyCompletions.clear();
      this.#status = {
        state: "failed",
        code: "CHATGPT_LOGIN_START_FAILED",
      };
    }
    return this.status();
  }

  async #ensureConnection(): Promise<CodexAppServerConnection> {
    if (this.#closing) {
      throw new CodexAppServerProtocolError();
    }
    if (this.#connection !== undefined) {
      return this.#connection;
    }
    if (this.#connecting !== undefined) {
      return await this.#connecting;
    }
    this.#connecting = this.#connect();
    try {
      return await this.#connecting;
    } finally {
      this.#connecting = undefined;
    }
  }

  async #connect(): Promise<CodexAppServerConnection> {
    const connection = await this.#connectionFactory();
    connection.onNotification((notification) => {
      void this.#handleNotification(notification);
    });
    connection.onClosed(() => {
      if (this.#connection === connection) {
        this.#connection = undefined;
      }
      if (!this.#closing && this.#status.state !== "connected") {
        this.#status = {
          state: "failed",
          code: "CHATGPT_APP_SERVER_UNAVAILABLE",
        };
      }
      if (!this.#closing) {
        void this.#replaceCapabilities({
          state: "unavailable",
          planType: null,
          models: [],
          refreshedAt: null,
        }).then(async () => {
          if (this.#status.state === "connected") {
            await this.refreshCapabilities().catch(() => undefined);
          }
        });
      }
    });
    try {
      const initialized = initializeResponseSchema.parse(
        await connection.request("initialize", {
          clientInfo: {
            name: "imessage_codex_agent",
            title: "iMessage Codex Agent",
            version: "0.1.0",
          },
        }),
      );
      const [expectedHome, actualHome] = await Promise.all([
        realpath(this.#codexHome),
        realpath(initialized.codexHome),
      ]);
      if (actualHome !== expectedHome || this.#closing) {
        throw new CodexAppServerProtocolError();
      }
      connection.notify("initialized", {});
      this.#connection = connection;
      return connection;
    } catch (error) {
      await connection.close().catch(() => undefined);
      throw error;
    }
  }

  async #handleNotification(
    notification: AppServerNotification,
  ): Promise<void> {
    if (notification.method === "account/updated") {
      const updated = accountUpdatedSchema.safeParse(notification.params);
      if (!updated.success) {
        await this.#replaceCapabilities({
          state: "unavailable",
          planType: null,
          models: [],
          refreshedAt: null,
        });
        return;
      }
      if (updated.data.authMode === null) {
        this.#accountState = "not_connected";
        this.#status = { state: "not_connected" };
      }
      await this.refreshCapabilities();
      if (
        this.#accountState === "connected" &&
        this.#status.state !== "starting" &&
        this.#status.state !== "awaiting_authorization"
      ) {
        this.#status = { state: "connected" };
      }
      return;
    }
    if (notification.method !== "account/login/completed") {
      return;
    }
    const completed = loginCompletedSchema.safeParse(notification.params);
    if (!completed.success) {
      return;
    }
    if (
      this.#status.state !== "starting" &&
      this.#status.state !== "awaiting_authorization"
    ) {
      return;
    }
    if (completed.data.loginId === null) {
      return;
    }
    const expectedLoginId = this.#loginId;
    if (expectedLoginId === undefined) {
      if (this.#status.state === "starting") {
        this.#earlyCompletions.set(completed.data.loginId, completed.data);
        if (this.#earlyCompletions.size > 8) {
          const oldest = this.#earlyCompletions.keys().next().value;
          if (oldest !== undefined) {
            this.#earlyCompletions.delete(oldest);
          }
        }
      }
      return;
    }
    if (completed.data.loginId !== expectedLoginId) {
      return;
    }
    await this.#completeLogin(completed.data);
  }

  async #completeLogin(completed: LoginCompleted): Promise<void> {
    if (!completed.success) {
      this.#loginId = undefined;
      this.#status = { state: "failed", code: "CHATGPT_LOGIN_FAILED" };
      return;
    }
    try {
      await this.refreshCapabilities();
      if (this.#accountState !== "connected") {
        this.#loginId = undefined;
        this.#status = { state: "failed", code: "CHATGPT_LOGIN_FAILED" };
        return;
      }
      await validateAndRestrictCodexAuthFile(this.#codexHome);
    } catch {
      this.#loginId = undefined;
      this.#status = {
        state: "failed",
        code: "CHATGPT_CREDENTIAL_SAVE_FAILED",
      };
      return;
    }
    this.#loginId = undefined;
    this.#status = { state: "connected" };
    for (const listener of this.#connectedListeners) {
      void Promise.resolve(listener()).catch(() => undefined);
    }
  }

  async #refreshCapabilities(): Promise<CodexAccountCapabilitiesSnapshot> {
    await this.#replaceCapabilities({
      ...this.#capabilitiesSnapshot,
      state: "refreshing",
    });
    const connection = await this.#ensureConnection().catch(() => undefined);
    if (connection === undefined) {
      this.#accountState = "unknown";
      return await this.#replaceCapabilities({
        state: "unavailable",
        planType: null,
        models: [],
        refreshedAt: null,
      });
    }

    const result = await loadCodexAccountCapabilities(connection);
    this.#accountState = result.accountState;
    return await this.#replaceCapabilities(result.snapshot);
  }

  async #replaceCapabilities(
    snapshot: CodexAccountCapabilitiesSnapshot,
  ): Promise<CodexAccountCapabilitiesSnapshot> {
    this.#capabilitiesSnapshot = cloneCapabilitiesSnapshot(snapshot);
    for (const listener of this.#capabilitiesListeners) {
      await Promise.resolve(listener(this.capabilities())).catch(() => undefined);
    }
    return this.capabilities();
  }
}
