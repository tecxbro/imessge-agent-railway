import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  CodexRuntimeError,
  type CodexRunRequest,
  type CodexRunResult,
  type StructuredCodexRunner,
} from "../../src/agent/codex-client.js";
import {
  codexThreadScopeKey,
  ThreadStore,
  type CodexThreadRepository,
  type CodexThreadScope,
  type StoredCodexThread,
} from "../../src/agent/thread-store.js";

const modelProfile = { model: "gpt-5.6-luna", effort: "high" } as const;

const outputSchema = z.object({ ok: z.literal(true) }).strict();
const scope: CodexThreadScope = {
  kind: "interaction",
  ownerId: "00000000-0000-4000-8000-000000000001",
  spaceId: "00000000-0000-4000-8000-000000000002",
};

class FakeRunner implements StructuredCodexRunner {
  public readonly calls: Array<{ threadId?: string; prompt: string }> = [];
  private nextThread = 1;

  public async runStructured<Output>(
    request: CodexRunRequest<Output>,
  ): Promise<CodexRunResult<Output>> {
    this.calls.push({
      prompt: request.prompt,
      ...(request.threadId === undefined ? {} : { threadId: request.threadId }),
    });
    if (request.threadId === "missing-session") {
      throw new CodexRuntimeError(
        "CODEX_SESSION_MISSING",
        "missing",
        true,
      );
    }
    return {
      threadId: request.threadId ?? `thread-${this.nextThread++}`,
      output: request.outputSchema.parse({ ok: true }),
      usage: null,
    };
  }
}

class TestThreadRepository implements CodexThreadRepository {
  private readonly records = new Map<string, StoredCodexThread>();

  public async get(scopeKey: string): Promise<StoredCodexThread | undefined> {
    const record = this.records.get(scopeKey);
    return record === undefined ? undefined : structuredClone(record);
  }

  public async save(record: StoredCodexThread): Promise<void> {
    this.records.set(record.scopeKey, structuredClone(record));
  }
}

function request() {
  return {
    scope,
    prompt: "current turn",
    outputSchema,
    modelProfile,
    permissionProfile: "read" as const,
    workingDirectory: "/tmp",
    skipGitRepoCheck: true,
    recoverySummary: "bounded prior summary",
  };
}

describe("Codex thread store", () => {
  it("persists start, resume, and explicit reset paths", async () => {
    const repository = new TestThreadRepository();
    const runner = new FakeRunner();
    const threads = new ThreadStore(repository, runner);

    const started = await threads.run(request());
    const resumed = await threads.run(request());
    await threads.reset(scope);
    const restarted = await threads.run(request());

    expect(started.threadId).toBe("thread-1");
    expect(resumed.threadId).toBe("thread-1");
    expect(restarted.threadId).toBe("thread-2");
    expect(runner.calls.map((call) => call.threadId)).toEqual([
      undefined,
      "thread-1",
      undefined,
    ]);
    expect(restarted.generation).toBe(2);
  });

  it("recovers a missing session only through the stored bounded summary", async () => {
    const repository = new TestThreadRepository();
    await repository.save({
      scopeKey: codexThreadScopeKey(scope),
      scope,
      state: "active",
      threadId: "missing-session",
      recoverySummary: "safe recovery summary",
      generation: 3,
      updatedAt: new Date(),
    });
    const runner = new FakeRunner();
    const threads = new ThreadStore(repository, runner);

    const result = await threads.run(request());

    expect(result.recovered).toBe(true);
    expect(result.generation).toBe(4);
    expect(result.threadId).toBe("thread-1");
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1]?.threadId).toBeUndefined();
    expect(runner.calls[1]?.prompt).toContain("safe recovery summary");
    expect(runner.calls[1]?.prompt).toContain("current turn");
  });

  it("does not hide a missing session when no recovery summary exists", async () => {
    const repository = new TestThreadRepository();
    await repository.save({
      scopeKey: codexThreadScopeKey(scope),
      scope,
      state: "active",
      threadId: "missing-session",
      generation: 1,
      updatedAt: new Date(),
    });
    const threads = new ThreadStore(repository, new FakeRunner());

    await expect(threads.run(request())).rejects.toMatchObject({
      code: "CODEX_SESSION_MISSING",
    });
  });
});
