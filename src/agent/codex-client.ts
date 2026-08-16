import { Codex, type ThreadEvent, type ThreadOptions, type Usage } from "@openai/codex-sdk";
import { z } from "zod";

import type { ModelProfile, ReasoningEffort } from "../config/model-profiles.js";
import {
  resolvePermissionProfile,
  type PermissionProfileName,
} from "../security/permissions.js";
import { buildCodexShellEnvironmentPolicy } from "../security/secret-boundaries.js";
import {
  buildCodexChildEnvironment,
  type CodexAuthMode,
} from "./child-environment.js";

export const DEFAULT_CODEX_MAX_OUTPUT_BYTES = 512_000;
export const DEFAULT_CODEX_MAX_RUNTIME_MS = 900_000;
export const DEFAULT_CODEX_MAX_CONCURRENCY = 3;

export type CodexRuntimeErrorCode =
  | "CODEX_CANCELED"
  | "CODEX_TIMEOUT"
  | "CODEX_OUTPUT_TOO_LARGE"
  | "CODEX_STRUCTURED_OUTPUT_INVALID"
  | "CODEX_SESSION_MISSING"
  | "CODEX_AUTH_FAILED"
  | "CODEX_MODEL_UNSUPPORTED"
  | "CODEX_EFFORT_UNSUPPORTED"
  | "CODEX_INVOCATION_FAILED";

export class CodexRuntimeError extends Error {
  public constructor(
    public readonly code: CodexRuntimeErrorCode,
    message: string,
    public readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CodexRuntimeError";
  }
}

export interface CodexProgressEvent {
  type: "thinking" | "tool" | "file" | "web";
  state: "started" | "updated" | "completed";
}

export interface CodexClientOptions {
  codexHome: string;
  authMode: CodexAuthMode;
  parentEnvironment: Readonly<NodeJS.ProcessEnv>;
  openAiApiKey?: string;
  codexPathOverride?: string;
  safeTaskEnvironment?: Readonly<Record<string, string>>;
  allowedTaskEnvironmentKeys?: readonly string[];
  maximumOutputBytes?: number;
  maximumRuntimeMs?: number;
  maximumConcurrency?: number;
  maximumConcurrencyPerOwner?: number;
}

export interface CodexRunRequest<Output> {
  threadId?: string;
  prompt: string;
  outputSchema: z.ZodType<Output>;
  modelProfile: ModelProfile;
  permissionProfile: PermissionProfileName;
  workingDirectory: string;
  skipGitRepoCheck: boolean;
  signal?: AbortSignal;
  maximumRuntimeMs?: number;
  /** Deterministic owner ID used only for the per-owner process cap. */
  concurrencyKey?: string;
  onProgress?: (event: CodexProgressEvent) => void;
}

export interface CodexRunResult<Output> {
  threadId: string;
  output: Output;
  usage: Usage | null;
}

export interface StructuredCodexRunner {
  runStructured<Output>(
    request: CodexRunRequest<Output>,
  ): Promise<CodexRunResult<Output>>;
}

interface RunAbortContext {
  signal: AbortSignal;
  timedOut: () => boolean;
  outputExceeded: () => boolean;
  markOutputExceeded: () => void;
  cleanup: () => void;
}

function createRunAbortContext(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): RunAbortContext {
  const controller = new AbortController();
  let didTimeOut = false;
  let didExceedOutput = false;

  const parentAbort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted === true) {
    parentAbort();
  } else {
    parentSignal?.addEventListener("abort", parentAbort, { once: true });
  }

  const timer = setTimeout(() => {
    didTimeOut = true;
    controller.abort(new Error("Codex task timed out"));
  }, timeoutMs);
  timer.unref();

  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    outputExceeded: () => didExceedOutput,
    markOutputExceeded: () => {
      didExceedOutput = true;
      controller.abort(new Error("Codex output limit exceeded"));
    },
    cleanup: () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", parentAbort);
    },
  };
}

class ConcurrencyGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  public constructor(private readonly maximum: number) {}

  public async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted === true) {
      throw canceledError();
    }

    if (this.active < this.maximum) {
      this.active += 1;
      return () => this.release();
    }

    return await new Promise<() => void>((resolve, reject) => {
      const enter = () => {
        signal?.removeEventListener("abort", onAbort);
        this.active += 1;
        resolve(() => this.release());
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(enter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        reject(canceledError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(enter);
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    next?.();
  }
}

function canceledError(cause?: unknown): CodexRuntimeError {
  return new CodexRuntimeError(
    "CODEX_CANCELED",
    "Codex execution was canceled. Retry only if the chain is still current.",
    true,
    cause === undefined ? undefined : { cause },
  );
}

function classifyInvocationFailure(error: unknown): CodexRuntimeError {
  if (error instanceof CodexRuntimeError) {
    return error;
  }
  const message = error instanceof Error ? error.message : "";
  if (
    /invalid_json_schema|invalid schema for response_format|text\.format\.schema/iu.test(
      message,
    )
  ) {
    return new CodexRuntimeError(
      "CODEX_STRUCTURED_OUTPUT_INVALID",
      "The configured Codex output schema is not accepted by OpenAI Structured Outputs. Fix the required and nullable field contract before retrying.",
      false,
      { cause: error },
    );
  }
  if (/session .*(?:missing|not found)|thread .*(?:missing|not found)/iu.test(message)) {
    return new CodexRuntimeError(
      "CODEX_SESSION_MISSING",
      "The saved Codex session is unavailable. Start a replacement thread with the bounded recovery summary.",
      true,
      { cause: error },
    );
  }
  if (/auth|login|credential|unauthorized|401/iu.test(message)) {
    return new CodexRuntimeError(
      "CODEX_AUTH_FAILED",
      "Codex authentication failed. Re-enroll ChatGPT or replace the API key, then rerun capability checks.",
      false,
      { cause: error },
    );
  }
  if (/model .*(?:unsupported|not found|unavailable)/iu.test(message)) {
    return new CodexRuntimeError(
      "CODEX_MODEL_UNSUPPORTED",
      "A configured Codex model is unsupported. Correct the affected model profile and restart.",
      false,
      { cause: error },
    );
  }
  if (/reasoning|effort|xhigh|\bmax\b/iu.test(message)) {
    return new CodexRuntimeError(
      "CODEX_EFFORT_UNSUPPORTED",
      "A configured reasoning effort is unsupported. Correct the profile or explicitly enable the documented max-to-xhigh fallback.",
      false,
      { cause: error },
    );
  }
  return new CodexRuntimeError(
    "CODEX_INVOCATION_FAILED",
    "Codex execution failed without a safe provider diagnostic. Inspect redacted operator logs and rerun the capability probe.",
    true,
    { cause: error },
  );
}

function sdkReasoningEffort(
  effort: ReasoningEffort,
): Exclude<ReasoningEffort, "max"> | undefined {
  return effort === "max" ? undefined : effort;
}

function filteredProgress(event: ThreadEvent): CodexProgressEvent | undefined {
  if (
    event.type !== "item.started" &&
    event.type !== "item.updated" &&
    event.type !== "item.completed"
  ) {
    return undefined;
  }
  const state =
    event.type === "item.started"
      ? "started"
      : event.type === "item.updated"
        ? "updated"
        : "completed";
  switch (event.item.type) {
    case "command_execution":
    case "mcp_tool_call":
      return { type: "tool", state };
    case "file_change":
      return { type: "file", state };
    case "web_search":
      return { type: "web", state };
    case "reasoning":
    case "todo_list":
      return { type: "thinking", state };
    case "agent_message":
    case "error":
      return undefined;
  }
}

function structuredOutputError(
  message: string,
  cause?: unknown,
): CodexRuntimeError {
  return new CodexRuntimeError(
    "CODEX_STRUCTURED_OUTPUT_INVALID",
    message,
    true,
    cause === undefined ? undefined : { cause },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strictStructuredOutputIssue(
  value: unknown,
  path = "schema",
): string | undefined {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const issue = strictStructuredOutputIssue(item, `${path}[${index}]`);
      if (issue !== undefined) {
        return issue;
      }
    }
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }

  if (value["type"] === "object") {
    if (value["additionalProperties"] !== false) {
      return `${path}.additionalProperties must be false`;
    }
    const properties = value["properties"];
    if (!isRecord(properties)) {
      return `${path}.properties must be an object`;
    }
    const required = value["required"];
    if (!Array.isArray(required) || required.some((item) => typeof item !== "string")) {
      return `${path}.required must be a string array`;
    }
    const propertyNames = Object.keys(properties).sort();
    const requiredNames = [...required].sort();
    if (
      propertyNames.length !== requiredNames.length ||
      propertyNames.some((property, index) => property !== requiredNames[index])
    ) {
      return `${path}.required must contain every property exactly once`;
    }
  }

  for (const [key, child] of Object.entries(value)) {
    const issue = strictStructuredOutputIssue(child, `${path}.${key}`);
    if (issue !== undefined) {
      return issue;
    }
  }
  return undefined;
}

export function createCodexOutputJsonSchema<Output>(
  outputSchema: z.ZodType<Output>,
): Record<string, unknown> {
  let generated: unknown;
  try {
    generated = z.toJSONSchema(outputSchema, { io: "input" });
  } catch (error) {
    throw new CodexRuntimeError(
      "CODEX_STRUCTURED_OUTPUT_INVALID",
      "The configured Codex output schema could not be converted to JSON Schema. Fix the schema contract before retrying.",
      false,
      { cause: error },
    );
  }
  if (!isRecord(generated) || generated["type"] !== "object") {
    throw new CodexRuntimeError(
      "CODEX_STRUCTURED_OUTPUT_INVALID",
      "The configured Codex output schema must generate a root object.",
      false,
    );
  }
  const issue = strictStructuredOutputIssue(generated);
  if (issue !== undefined) {
    throw new CodexRuntimeError(
      "CODEX_STRUCTURED_OUTPUT_INVALID",
      `The configured Codex output schema is not strict at ${issue}.`,
      false,
    );
  }
  return generated;
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

export function isMissingCodexSessionError(error: unknown): boolean {
  return (
    error instanceof CodexRuntimeError && error.code === "CODEX_SESSION_MISSING"
  );
}

export class CodexClient implements StructuredCodexRunner {
  private readonly childEnvironment: Record<string, string>;
  private readonly maximumOutputBytes: number;
  private readonly maximumRuntimeMs: number;
  private readonly gate: ConcurrencyGate;
  private readonly maximumConcurrencyPerOwner: number;
  private readonly ownerGates = new Map<string, ConcurrencyGate>();

  public constructor(private readonly options: CodexClientOptions) {
    this.childEnvironment = buildCodexChildEnvironment({
      parentEnvironment: options.parentEnvironment,
      codexHome: options.codexHome,
      authMode: options.authMode,
      ...(options.openAiApiKey === undefined
        ? {}
        : { openAiApiKey: options.openAiApiKey }),
      ...(options.safeTaskEnvironment === undefined
        ? {}
        : { safeTaskEnvironment: options.safeTaskEnvironment }),
      ...(options.allowedTaskEnvironmentKeys === undefined
        ? {}
        : { allowedTaskEnvironmentKeys: options.allowedTaskEnvironmentKeys }),
    });
    this.maximumOutputBytes = requirePositiveInteger(
      options.maximumOutputBytes ?? DEFAULT_CODEX_MAX_OUTPUT_BYTES,
      "Codex maximum output bytes",
    );
    this.maximumRuntimeMs = requirePositiveInteger(
      options.maximumRuntimeMs ?? DEFAULT_CODEX_MAX_RUNTIME_MS,
      "Codex maximum runtime",
    );
    const maximumConcurrency = requirePositiveInteger(
      options.maximumConcurrency ?? DEFAULT_CODEX_MAX_CONCURRENCY,
      "Codex maximum concurrency",
    );
    this.gate = new ConcurrencyGate(maximumConcurrency);
    this.maximumConcurrencyPerOwner = requirePositiveInteger(
      options.maximumConcurrencyPerOwner ?? maximumConcurrency,
      "Codex maximum concurrency per owner",
    );
  }

  public async runStructured<Output>(
    request: CodexRunRequest<Output>,
  ): Promise<CodexRunResult<Output>> {
    // All Codex thread start/resume calls cross this boundary so environment,
    // permissions, concurrency, time, output, and cancellation limits agree.
    const requestedRuntime = requirePositiveInteger(
      request.maximumRuntimeMs ?? this.maximumRuntimeMs,
      "Codex task runtime",
    );
    const ownerGate =
      request.concurrencyKey === undefined
        ? undefined
        : this.ownerGates.get(request.concurrencyKey) ??
          new ConcurrencyGate(this.maximumConcurrencyPerOwner);
    if (
      request.concurrencyKey !== undefined &&
      !this.ownerGates.has(request.concurrencyKey)
    ) {
      this.ownerGates.set(request.concurrencyKey, ownerGate!);
    }
    const releaseOwner = await ownerGate?.acquire(request.signal);
    let releaseGlobal: (() => void) | undefined;
    try {
      releaseGlobal = await this.gate.acquire(request.signal);
    } catch (error) {
      releaseOwner?.();
      throw error;
    }
    const timeoutMs = Math.min(requestedRuntime, this.maximumRuntimeMs);
    const abort = createRunAbortContext(request.signal, timeoutMs);

    try {
      const permission = resolvePermissionProfile(request.permissionProfile);
      const config = {
        cli_auth_credentials_store: "file",
        forced_login_method:
          this.options.authMode === "api_key" ? "api" : "chatgpt",
        hide_agent_reasoning: true,
        approvals_reviewer: "user",
        shell_environment_policy: buildCodexShellEnvironmentPolicy(
          this.childEnvironment,
          request.workingDirectory,
        ),
        ...(request.modelProfile.effort === "max"
          ? { model_reasoning_effort: "max" }
          : {}),
      };
      const codex = new Codex({
        env: this.childEnvironment,
        config,
        ...(this.options.openAiApiKey === undefined
          ? {}
          : { apiKey: this.options.openAiApiKey }),
        ...(this.options.codexPathOverride === undefined
          ? {}
          : { codexPathOverride: this.options.codexPathOverride }),
      });
      const effort = sdkReasoningEffort(request.modelProfile.effort);
      const threadOptions: ThreadOptions = {
        model: request.modelProfile.model,
        sandboxMode: permission.sandboxMode,
        workingDirectory: request.workingDirectory,
        skipGitRepoCheck: request.skipGitRepoCheck,
        networkAccessEnabled: permission.networkAccessEnabled,
        webSearchMode: permission.webSearchMode,
        approvalPolicy: permission.approvalPolicy,
        ...(effort === undefined ? {} : { modelReasoningEffort: effort }),
      };
      const thread =
        request.threadId === undefined
          ? codex.startThread(threadOptions)
          : codex.resumeThread(request.threadId, threadOptions);
      const jsonSchema = createCodexOutputJsonSchema(request.outputSchema);
      const { events } = await thread.runStreamed(request.prompt, {
        outputSchema: jsonSchema,
        signal: abort.signal,
      });

      let eventBytes = 0;
      let response = "";
      let usage: Usage | null = null;
      let completed = false;
      for await (const event of events) {
        eventBytes += Buffer.byteLength(JSON.stringify(event), "utf8");
        if (eventBytes > this.maximumOutputBytes) {
          abort.markOutputExceeded();
          throw new CodexRuntimeError(
            "CODEX_OUTPUT_TOO_LARGE",
            `Codex event output exceeded the ${this.maximumOutputBytes}-byte limit. Narrow the task and retry.`,
            true,
          );
        }

        const progress = filteredProgress(event);
        if (progress !== undefined) {
          request.onProgress?.(progress);
        }

        if (
          event.type === "item.completed" &&
          event.item.type === "agent_message"
        ) {
          response = event.item.text;
        } else if (event.type === "turn.completed") {
          usage = event.usage;
          completed = true;
        } else if (event.type === "turn.failed" || event.type === "error") {
          const providerMessage =
            event.type === "turn.failed" ? event.error.message : event.message;
          throw classifyInvocationFailure(new Error(providerMessage));
        }
      }

      if (!completed) {
        throw new CodexRuntimeError(
          "CODEX_INVOCATION_FAILED",
          "Codex ended before a terminal completion event. Retry after checking runtime health.",
          true,
        );
      }
      if (Buffer.byteLength(response, "utf8") > this.maximumOutputBytes) {
        throw new CodexRuntimeError(
          "CODEX_OUTPUT_TOO_LARGE",
          `Codex structured output exceeded the ${this.maximumOutputBytes}-byte limit. Narrow the task and retry.`,
          true,
        );
      }

      let raw: unknown;
      try {
        raw = JSON.parse(response) as unknown;
      } catch (error) {
        throw structuredOutputError(
          "Codex returned malformed JSON for a schema-bound turn. Retry once, then inspect the model capability configuration.",
          error,
        );
      }
      const parsed = request.outputSchema.safeParse(raw);
      if (!parsed.success) {
        const paths = parsed.error.issues
          .slice(0, 8)
          .map((issue) => issue.path.join(".") || "output")
          .join(", ");
        throw structuredOutputError(
          `Codex output did not satisfy the frozen schema at: ${paths}. Retry once without broadening permissions.`,
          parsed.error,
        );
      }

      const threadId = thread.id ?? request.threadId;
      if (threadId === undefined || threadId.length === 0) {
        throw new CodexRuntimeError(
          "CODEX_INVOCATION_FAILED",
          "Codex completed without a thread identifier. Do not persist this turn; retry after checking the pinned CLI/SDK pair.",
          true,
        );
      }
      return { threadId, output: parsed.data, usage };
    } catch (error) {
      if (abort.outputExceeded()) {
        throw new CodexRuntimeError(
          "CODEX_OUTPUT_TOO_LARGE",
          `Codex event output exceeded the ${this.maximumOutputBytes}-byte limit. Narrow the task and retry.`,
          true,
          { cause: error },
        );
      }
      if (abort.timedOut()) {
        throw new CodexRuntimeError(
          "CODEX_TIMEOUT",
          `Codex exceeded the ${timeoutMs}-millisecond runtime limit and was terminated. The job may be retried if its chain is current.`,
          true,
          { cause: error },
        );
      }
      if (request.signal?.aborted === true) {
        throw canceledError(error);
      }
      throw classifyInvocationFailure(error);
    } finally {
      abort.cleanup();
      releaseGlobal?.();
      releaseOwner?.();
    }
  }
}
