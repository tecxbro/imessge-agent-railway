import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  createInterface,
  type Interface as ReadlineInterface,
} from "node:readline";

import { z } from "zod";

import { buildCodexChildEnvironment } from "./child-environment.js";

const MAXIMUM_PROTOCOL_LINE_BYTES = 1_048_576;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const require = createRequire(import.meta.url);

function resolvePinnedCodexExecutable(): string {
  const target = (() => {
    if (process.platform === "darwin" && process.arch === "arm64") {
      return ["@openai/codex-darwin-arm64", "aarch64-apple-darwin"] as const;
    }
    if (process.platform === "darwin" && process.arch === "x64") {
      return ["@openai/codex-darwin-x64", "x86_64-apple-darwin"] as const;
    }
    if (process.platform === "linux" && process.arch === "arm64") {
      return ["@openai/codex-linux-arm64", "aarch64-unknown-linux-musl"] as const;
    }
    if (process.platform === "linux" && process.arch === "x64") {
      return ["@openai/codex-linux-x64", "x86_64-unknown-linux-musl"] as const;
    }
    if (process.platform === "win32" && process.arch === "arm64") {
      return ["@openai/codex-win32-arm64", "aarch64-pc-windows-msvc"] as const;
    }
    if (process.platform === "win32" && process.arch === "x64") {
      return ["@openai/codex-win32-x64", "x86_64-pc-windows-msvc"] as const;
    }
    throw new Error(`Unsupported Codex platform: ${process.platform}/${process.arch}`);
  })();
  const packageRoot = dirname(require.resolve(`${target[0]}/package.json`));
  return resolve(
    packageRoot,
    "vendor",
    target[1],
    "bin",
    process.platform === "win32" ? "codex.exe" : "codex",
  );
}

const requestIdSchema = z.union([
  z.number().int(),
  z.string().trim().min(1).max(256),
]);

const responseEnvelopeSchema = z
  .object({
    id: z.number().int(),
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.number().int(),
        message: z.string(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .refine(
    (value) =>
      Object.hasOwn(value, "result") !== Object.hasOwn(value, "error"),
    "App Server responses require exactly one result or error field.",
  );

const serverRequestEnvelopeSchema = z
  .object({
    id: requestIdSchema,
    method: z.string(),
    params: z.unknown(),
  })
  .passthrough();

const notificationEnvelopeSchema = z
  .object({
    method: z.string(),
    params: z.unknown(),
  })
  .passthrough();

const accountReadSchema = z
  .object({
    account: z
      .discriminatedUnion("type", [
        z.object({ type: z.literal("apiKey") }).passthrough(),
        z
          .object({
            type: z.literal("chatgpt"),
            email: z.string().nullable(),
            planType: z.string(),
          })
          .passthrough(),
        z.object({ type: z.literal("amazonBedrock") }).passthrough(),
      ])
      .nullable(),
    requiresOpenaiAuth: z.boolean(),
  })
  .passthrough();

const initializeResponseSchema = z
  .object({
    codexHome: z.string(),
  })
  .passthrough();

const deviceLoginSchema = z
  .object({
    type: z.literal("chatgptDeviceCode"),
    loginId: z.string().trim().min(1).max(512),
    verificationUrl: z
      .url()
      .max(2_048)
      .refine((value) => {
        const parsed = new URL(value);
        return parsed.protocol === "https:" && parsed.hostname === "auth.openai.com";
      }),
    userCode: z.string().trim().min(1).max(128),
  })
  .passthrough();

const loginCompletedSchema = z
  .object({
    loginId: z.string().trim().min(1).max(512).nullable(),
    success: z.boolean(),
    error: z.string().nullable(),
  })
  .passthrough();

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

type LoginCompleted = z.infer<typeof loginCompletedSchema>;

type ConnectedListener = () => void | Promise<void>;

export interface ChatGptSetupController {
  initialize(): Promise<ChatGptSetupStatus>;
  start(): Promise<ChatGptSetupStatus>;
  status(): ChatGptSetupStatus;
  onConnected(listener: ConnectedListener): () => void;
  close(): Promise<void>;
}

interface AppServerNotification {
  method: string;
  params: unknown;
}

export interface CodexAppServerConnection {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): void;
  onNotification(
    listener: (notification: AppServerNotification) => void,
  ): () => void;
  onClosed(listener: () => void): () => void;
  close(): Promise<void>;
}

export type CodexAppServerConnectionFactory =
  () => Promise<CodexAppServerConnection>;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

class CodexAppServerProtocolError extends Error {
  public constructor() {
    super("CODEX_APP_SERVER_PROTOCOL_ERROR");
    this.name = "CodexAppServerProtocolError";
  }
}

class StdioCodexAppServerConnection implements CodexAppServerConnection {
  readonly #process: ChildProcessWithoutNullStreams;
  readonly #readline: ReadlineInterface;
  readonly #requestTimeoutMs: number;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #notificationListeners = new Set<
    (notification: AppServerNotification) => void
  >();
  readonly #closedListeners = new Set<() => void>();
  #requestId = 0;
  #closed = false;

  private constructor(
    process: ChildProcessWithoutNullStreams,
    requestTimeoutMs: number,
  ) {
    this.#process = process;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#readline = createInterface({ input: process.stdout });
    this.#readline.on("line", (line) => this.#handleLine(line));
    process.once("error", () => this.#handleClosed());
    process.once("exit", () => this.#handleClosed());
  }

  public static async connect(options: {
    codexHome: string;
    parentEnvironment: Readonly<NodeJS.ProcessEnv>;
    executablePath?: string;
    requestTimeoutMs?: number;
  }): Promise<StdioCodexAppServerConnection> {
    if (!isAbsolute(options.codexHome)) {
      throw new Error("CODEX_HOME must be absolute before App Server starts.");
    }
    const codexHome = resolve(options.codexHome);
    const environment = buildCodexChildEnvironment({
      parentEnvironment: options.parentEnvironment,
      codexHome,
      authMode: "chatgpt",
    });
    const child = spawn(
      options.executablePath ?? resolvePinnedCodexExecutable(),
      ["app-server", "--stdio"],
      {
        cwd: codexHome,
        env: environment,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    // Never forward or persist App Server stderr. Provider details and paths
    // are not part of the dashboard or setup API contract.
    child.stderr.resume();
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once("spawn", resolveSpawn);
      child.once("error", rejectSpawn);
    });
    return new StdioCodexAppServerConnection(
      child,
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
  }

  public async request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed) {
      throw new CodexAppServerProtocolError();
    }
    const id = ++this.#requestId;
    const response = new Promise<unknown>((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        rejectRequest(new CodexAppServerProtocolError());
      }, this.#requestTimeoutMs);
      timeout.unref();
      this.#pending.set(id, {
        resolve: resolveRequest,
        reject: rejectRequest,
        timeout,
      });
    });
    try {
      this.#write({ method, id, params });
    } catch (error) {
      const pending = this.#pending.get(id);
      if (pending !== undefined) {
        this.#pending.delete(id);
        clearTimeout(pending.timeout);
        pending.reject(
          error instanceof Error ? error : new CodexAppServerProtocolError(),
        );
      }
    }
    return await response;
  }

  public notify(method: string, params: unknown): void {
    this.#write({ method, params });
  }

  public onNotification(
    listener: (notification: AppServerNotification) => void,
  ): () => void {
    this.#notificationListeners.add(listener);
    return () => this.#notificationListeners.delete(listener);
  }

  public onClosed(listener: () => void): () => void {
    this.#closedListeners.add(listener);
    return () => this.#closedListeners.delete(listener);
  }

  public async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    const exited = new Promise<void>((resolveExit) => {
      this.#process.once("exit", () => resolveExit());
    });
    this.#process.kill("SIGTERM");
    let forceTimer: NodeJS.Timeout | undefined;
    await Promise.race([
      exited,
      new Promise<void>((resolveWait) => {
        forceTimer = setTimeout(() => {
          this.#process.kill("SIGKILL");
          resolveWait();
        }, 2_000);
        forceTimer.unref();
      }),
    ]);
    if (forceTimer !== undefined) {
      clearTimeout(forceTimer);
    }
    this.#handleClosed();
  }

  #write(message: unknown): void {
    if (this.#closed || !this.#process.stdin.writable) {
      throw new CodexAppServerProtocolError();
    }
    this.#process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line: string): void {
    if (Buffer.byteLength(line, "utf8") > MAXIMUM_PROTOCOL_LINE_BYTES) {
      this.#handleClosed();
      this.#process.kill("SIGTERM");
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.#handleClosed();
      this.#process.kill("SIGTERM");
      return;
    }

    const response = responseEnvelopeSchema.safeParse(value);
    if (response.success) {
      const pending = this.#pending.get(response.data.id);
      if (pending === undefined) {
        return;
      }
      this.#pending.delete(response.data.id);
      clearTimeout(pending.timeout);
      if (response.data.error !== undefined) {
        pending.reject(new CodexAppServerProtocolError());
      } else {
        pending.resolve(response.data.result);
      }
      return;
    }

    const notification = notificationEnvelopeSchema.safeParse(value);
    if (notification.success && !("id" in notification.data)) {
      for (const listener of this.#notificationListeners) {
        listener(notification.data);
      }
      return;
    }

    const serverRequest = serverRequestEnvelopeSchema.safeParse(value);
    if (serverRequest.success) {
      this.#write({
        id: serverRequest.data.id,
        error: {
          code: -32_601,
          message: "Method not supported by this authentication client.",
        },
      });
    }
  }

  #handleClosed(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#readline.close();
    const error = new CodexAppServerProtocolError();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
    for (const listener of this.#closedListeners) {
      listener();
    }
  }
}

export interface CodexAppServerAuthOptions {
  codexHome: string;
  parentEnvironment: Readonly<NodeJS.ProcessEnv>;
  /** Test seam for a compatible executable; production uses the pinned package. */
  executablePath?: string;
  requestTimeoutMs?: number;
  connectionFactory?: CodexAppServerConnectionFactory;
}

export class CodexAppServerAuth implements ChatGptSetupController {
  readonly #codexHome: string;
  readonly #connectionFactory: CodexAppServerConnectionFactory;
  readonly #connectedListeners = new Set<ConnectedListener>();
  #connection: CodexAppServerConnection | undefined;
  #connecting: Promise<CodexAppServerConnection> | undefined;
  #starting: Promise<ChatGptSetupStatus> | undefined;
  #status: ChatGptSetupStatus = { state: "not_connected" };
  #loginId: string | undefined;
  readonly #earlyCompletions = new Map<string, LoginCompleted>();
  #closing = false;

  public constructor(options: CodexAppServerAuthOptions) {
    this.#codexHome = resolve(options.codexHome);
    this.#connectionFactory =
      options.connectionFactory ??
      (() =>
        StdioCodexAppServerConnection.connect({
          codexHome: options.codexHome,
          parentEnvironment: options.parentEnvironment,
          ...(options.executablePath === undefined
            ? {}
            : { executablePath: options.executablePath }),
          ...(options.requestTimeoutMs === undefined
            ? {}
            : { requestTimeoutMs: options.requestTimeoutMs }),
        }));
  }

  public status(): ChatGptSetupStatus {
    return { ...this.#status };
  }

  public onConnected(listener: ConnectedListener): () => void {
    this.#connectedListeners.add(listener);
    return () => this.#connectedListeners.delete(listener);
  }

  public async initialize(): Promise<ChatGptSetupStatus> {
    try {
      const connection = await this.#ensureConnection();
      const account = accountReadSchema.parse(
        await connection.request("account/read", { refreshToken: false }),
      );
      this.#status =
        account.account?.type === "chatgpt"
          ? { state: "connected" }
          : { state: "not_connected" };
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
      const connection = await this.#ensureConnection();
      const account = accountReadSchema.parse(
        await connection.request("account/read", { refreshToken: false }),
      );
      if (account.account?.type !== "chatgpt") {
        this.#loginId = undefined;
        this.#status = { state: "failed", code: "CHATGPT_LOGIN_FAILED" };
        return;
      }
      await this.#validateAndRestrictAuthFile();
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

  async #validateAndRestrictAuthFile(): Promise<void> {
    const authPath = resolve(this.#codexHome, "auth.json");
    const currentUid = process.getuid?.();
    const handle = await open(authPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (
        !before.isFile() ||
        (currentUid !== undefined && before.uid !== currentUid)
      ) {
        throw new CodexAppServerProtocolError();
      }
      await handle.chmod(0o600);
      const after = await handle.stat();
      if (
        !after.isFile() ||
        (after.mode & 0o077) !== 0 ||
        (currentUid !== undefined && after.uid !== currentUid)
      ) {
        throw new CodexAppServerProtocolError();
      }
    } finally {
      await handle.close();
    }
  }
}
