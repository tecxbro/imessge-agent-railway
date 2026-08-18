import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  type CodexRunRequest,
  type CodexRunResult,
  type StructuredCodexRunner,
} from "../../src/agent/codex-client.js";
import {
  executionTaskSchema,
  type ExecutionResult,
  type ExecutionTask,
} from "../../src/agent/schemas.js";
import {
  executionTaskLevels,
} from "../../src/agent/task-graph.js";
import {
  ThreadStore,
  type CodexThreadRepository,
  type StoredCodexThread,
} from "../../src/agent/thread-store.js";
import { buildUserSafeSynthesisInput } from "../../src/queue/handlers/turn-synthesize.js";

const modelProfile = { model: "gpt-5.6-luna", effort: "high" } as const;

function task(id: string, dependsOn: string[] = []): ExecutionTask {
  return executionTaskSchema.parse({
    id,
    agentName: `agent-${id}`,
    purpose: `Establish the ${id} result with evidence.`,
    instructions: `Return the bounded ${id} finding.`,
    workspaceBinding: "primary-repo",
    permissionProfile: "read",
    dependsOn,
  });
}

class MemoryThreadRepository implements CodexThreadRepository {
  private readonly records = new Map<string, StoredCodexThread>();

  public async get(scopeKey: string): Promise<StoredCodexThread | undefined> {
    const record = this.records.get(scopeKey);
    return record === undefined ? undefined : structuredClone(record);
  }

  public async save(record: StoredCodexThread): Promise<void> {
    this.records.set(record.scopeKey, structuredClone(record));
  }
}

class RecordingRunner implements StructuredCodexRunner {
  public readonly resumedThreadIds: Array<string | undefined> = [];
  private nextId = 1;

  public async runStructured<Output>(
    request: CodexRunRequest<Output>,
  ): Promise<CodexRunResult<Output>> {
    this.resumedThreadIds.push(request.threadId);
    return {
      threadId: request.threadId ?? `executor-thread-${this.nextId++}`,
      output: request.outputSchema.parse({ ok: true }),
      usage: null,
    };
  }
}

describe("Step 5 bounded task graphs", () => {
  it("returns independent roots in the same deterministic parallel level", () => {
    const levels = executionTaskLevels([
      task("verify", ["inspect", "research"]),
      task("research"),
      task("inspect"),
      task("report", ["verify"]),
    ]);

    expect(levels.map((level) => level.map((item) => item.id))).toEqual([
      ["research", "inspect"],
      ["verify"],
      ["report"],
    ]);
  });

  it("fails closed on duplicates, missing dependencies, cycles, excess tasks, and excess depth", () => {
    const invalidGraphs: ExecutionTask[][] = [
      [task("same"), task("same")],
      [task("orphan", ["missing"])],
      [task("a", ["b"]), task("b", ["a"])],
      [
        task("a"),
        task("b"),
        task("c"),
        task("d"),
        task("e"),
        task("f"),
      ],
      [task("one"), task("two", ["one"]), task("three", ["two"]), task("four", ["three"])],
    ];

    for (const graph of invalidGraphs) {
      expect(() => executionTaskLevels(graph)).toThrow();
    }
  });

  it("reuses the persisted thread for the same named agent and workspace only", async () => {
    const runner = new RecordingRunner();
    const threads = new ThreadStore(new MemoryThreadRepository(), runner);
    const outputSchema = z.object({ ok: z.literal(true) }).strict();
    const baseRequest = {
      prompt: "bounded follow-up",
      outputSchema,
      modelProfile,
      permissionProfile: "read" as const,
      workingDirectory: "/tmp",
      skipGitRepoCheck: true,
    };
    const reusableScope = {
      kind: "executor" as const,
      ownerId: "00000000-0000-4000-8000-000000000001",
      agentName: "runtime-debugger",
      workspaceBinding: "primary-repo",
    };

    const first = await threads.run({ ...baseRequest, scope: reusableScope });
    const reused = await threads.run({ ...baseRequest, scope: reusableScope });
    const isolated = await threads.run({
      ...baseRequest,
      scope: { ...reusableScope, agentName: "security-reviewer" },
    });

    expect(reused.threadId).toBe(first.threadId);
    expect(isolated.threadId).not.toBe(first.threadId);
    expect(runner.resumedThreadIds).toEqual([
      undefined,
      first.threadId,
      undefined,
    ]);
  });
});

describe("Step 5 execution-result collection", () => {
  it("retains successful findings and material partial failure without raw internals", () => {
    const results: ExecutionResult[] = [
      {
        taskId: "inspect",
        status: "succeeded",
        userSafeSummary: "The persisted cursor prevents replay of the first part.",
        artifacts: [
          {
            type: "file",
            path: "reports/restart.md",
            description: "Restart evidence",
          },
        ],
        proposedActions: [],
        memoryCandidates: [],
        error: null,
      },
      {
        taskId: "live-check",
        status: "failed",
        userSafeSummary: "The live provider check could not run.",
        artifacts: [],
        proposedActions: [],
        memoryCandidates: [],
        error: {
          code: "PROVIDER_AUTH_MISSING",
          retryable: false,
          safeMessage: "Enroll the development provider account before retrying.",
        },
      },
    ];

    const safeInput = buildUserSafeSynthesisInput(results);
    const serialized = JSON.stringify(safeInput);

    expect(serialized).toContain("persisted cursor prevents replay");
    expect(serialized).toContain("live provider check could not run");
    expect(serialized).toContain("PROVIDER_AUTH_MISSING");
    expect(serialized).toContain("reports/restart.md");
    expect(serialized).not.toContain("memoryCandidates");
    expect(serialized).not.toContain("normalizedPayload");
    expect(serialized).not.toContain("modelProfile");
    expect(serialized).not.toContain("rawCodexEvents");
  });

  it("exposes approval summaries without exposing normalized action payloads", () => {
    const safeInput = buildUserSafeSynthesisInput([
      {
        taskId: "publish",
        status: "needs_approval",
        userSafeSummary: "Publishing requires confirmation.",
        artifacts: [],
        proposedActions: [
          {
            actionType: "external.send",
            target: "release channel",
            normalizedPayload: {
              accessToken: "must-never-reach-synthesis",
              body: "private draft",
            },
            humanSummary: "Publish the prepared release note to the release channel.",
          },
        ],
        memoryCandidates: [],
        error: null,
      },
    ]);
    const serialized = JSON.stringify(safeInput);

    expect(serialized).toContain(
      "Publish the prepared release note to the release channel.",
    );
    expect(serialized).not.toContain("must-never-reach-synthesis");
    expect(serialized).not.toContain("private draft");
  });

  it("rejects unvalidated worker output with unrestricted logs", () => {
    expect(() =>
      buildUserSafeSynthesisInput([
        {
          taskId: "inspect",
          status: "succeeded",
          userSafeSummary: "Inspection completed.",
          artifacts: [],
          proposedActions: [],
          memoryCandidates: [],
          error: null,
          rawCodexEvents: [{ type: "command", output: "DATABASE_URL=secret" }],
        },
      ]),
    ).toThrow();
  });
});
