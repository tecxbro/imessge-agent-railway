import {
  isMissingCodexSessionError,
  type CodexRunRequest,
  type CodexRunResult,
  type StructuredCodexRunner,
} from "./codex-client.js";
import { buildRecoveryPrompt } from "./prompt-builder.js";

const MAX_RECOVERY_SUMMARY_CHARACTERS = 16_000;

export type CodexThreadScope =
  | {
      kind: "interaction";
      ownerId: string;
      spaceId: string;
    }
  | {
      kind: "executor";
      ownerId: string;
      agentName: string;
      workspaceBinding: string;
    };

export interface StoredCodexThread {
  scopeKey: string;
  scope: CodexThreadScope;
  state: "active" | "reset";
  threadId?: string;
  recoverySummary?: string;
  generation: number;
  updatedAt: Date;
}

export interface CodexThreadRepository {
  get(scopeKey: string): Promise<StoredCodexThread | undefined>;
  save(record: StoredCodexThread): Promise<void>;
}

export interface RunStoredThreadRequest<Output>
  extends Omit<CodexRunRequest<Output>, "threadId"> {
  scope: CodexThreadScope;
  recoverySummary?: string;
}

export interface StoredThreadRunResult<Output>
  extends CodexRunResult<Output> {
  recovered: boolean;
  generation: number;
}

function scopeSegment(value: string, label: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 128 ||
    !/^[A-Za-z0-9._-]+$/u.test(normalized)
  ) {
    throw new Error(
      `${label} must be 1-128 letters, numbers, dots, underscores, or hyphens.`,
    );
  }
  return normalized;
}

export function codexThreadScopeKey(scope: CodexThreadScope): string {
  if (scope.kind === "interaction") {
    return [
      "interaction",
      scopeSegment(scope.ownerId, "ownerId"),
      scopeSegment(scope.spaceId, "spaceId"),
    ].join(":");
  }
  return [
    "executor",
    scopeSegment(scope.ownerId, "ownerId"),
    scopeSegment(scope.agentName, "agentName"),
    scopeSegment(scope.workspaceBinding, "workspaceBinding"),
  ].join(":");
}

function boundedSummary(summary: string | undefined): string | undefined {
  if (summary === undefined) {
    return undefined;
  }
  const normalized = summary.trim();
  return normalized.length === 0
    ? undefined
    : normalized.slice(0, MAX_RECOVERY_SUMMARY_CHARACTERS);
}

function withOptionalRecordFields(
  base: Omit<StoredCodexThread, "threadId" | "recoverySummary">,
  threadId: string | undefined,
  recoverySummary: string | undefined,
): StoredCodexThread {
  return {
    ...base,
    ...(threadId === undefined ? {} : { threadId }),
    ...(recoverySummary === undefined ? {} : { recoverySummary }),
  };
}

export class ThreadStore {
  private readonly pendingByScope = new Map<string, Promise<void>>();

  public constructor(
    private readonly repository: CodexThreadRepository,
    private readonly client: StructuredCodexRunner,
  ) {}

  public async run<Output>(
    request: RunStoredThreadRequest<Output>,
  ): Promise<StoredThreadRunResult<Output>> {
    // Serialize each logical scope so concurrent jobs cannot fork its persisted
    // thread state; recover a missing session only from the bounded DB summary.
    const key = codexThreadScopeKey(request.scope);
    return await this.withScopeLock(key, async () => {
      const stored = await this.repository.get(key);
      const resumableThreadId =
        stored?.state === "active" ? stored.threadId : undefined;
      const baseRequest = this.clientRequest(request);

      let recovered = false;
      let result: CodexRunResult<Output>;
      try {
        result = await this.client.runStructured({
          ...baseRequest,
          ...(resumableThreadId === undefined
            ? {}
            : { threadId: resumableThreadId }),
        });
      } catch (error) {
        if (!isMissingCodexSessionError(error) || stored?.recoverySummary === undefined) {
          throw error;
        }

        recovered = true;
        const prompt = buildRecoveryPrompt(
          stored.recoverySummary,
          request.prompt,
        ).content;
        result = await this.client.runStructured({
          ...baseRequest,
          prompt,
        });
      }

      const generation =
        stored === undefined
          ? 1
          : stored.state === "reset" || recovered
            ? stored.generation + 1
            : stored.generation;
      const summary =
        boundedSummary(request.recoverySummary) ?? stored?.recoverySummary;
      await this.repository.save(
        withOptionalRecordFields(
          {
            scopeKey: key,
            scope: request.scope,
            state: "active",
            generation,
            updatedAt: new Date(),
          },
          result.threadId,
          summary,
        ),
      );

      return { ...result, recovered, generation };
    });
  }

  public async reset(
    scope: CodexThreadScope,
    options: { preserveRecoverySummary?: boolean } = {},
  ): Promise<void> {
    const key = codexThreadScopeKey(scope);
    await this.withScopeLock(key, async () => {
      const stored = await this.repository.get(key);
      const summary =
        options.preserveRecoverySummary === true
          ? stored?.recoverySummary
          : undefined;
      await this.repository.save(
        withOptionalRecordFields(
          {
            scopeKey: key,
            scope,
            state: "reset",
            generation: stored?.generation ?? 0,
            updatedAt: new Date(),
          },
          undefined,
          summary,
        ),
      );
    });
  }

  private clientRequest<Output>(
    request: RunStoredThreadRequest<Output>,
  ): CodexRunRequest<Output> {
    return {
      prompt: request.prompt,
      outputSchema: request.outputSchema,
      modelProfile: request.modelProfile,
      permissionProfile: request.permissionProfile,
      concurrencyKey: request.scope.ownerId,
      workingDirectory: request.workingDirectory,
      skipGitRepoCheck: request.skipGitRepoCheck,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.maximumRuntimeMs === undefined
        ? {}
        : { maximumRuntimeMs: request.maximumRuntimeMs }),
      ...(request.onProgress === undefined
        ? {}
        : { onProgress: request.onProgress }),
    };
  }

  private async withScopeLock<Result>(
    key: string,
    work: () => Promise<Result>,
  ): Promise<Result> {
    const prior = this.pendingByScope.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.then(() => current);
    this.pendingByScope.set(key, tail);
    await prior;
    try {
      return await work();
    } finally {
      release();
      if (this.pendingByScope.get(key) === tail) {
        this.pendingByScope.delete(key);
      }
    }
  }
}
