import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import {
  createInterface,
  type Interface as ReadlineInterface,
} from "node:readline";

import { buildCodexChildEnvironment } from "../child-environment.js";
import { resolvePinnedCodexExecutable } from "./executable.js";
import {
  type AppServerNotification,
  CodexAppServerProtocolError,
  MAXIMUM_PROTOCOL_LINE_BYTES,
  notificationEnvelopeSchema,
  responseEnvelopeSchema,
  serverRequestEnvelopeSchema,
} from "./protocol.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

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

export class StdioCodexAppServerConnection
  implements CodexAppServerConnection
{
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
