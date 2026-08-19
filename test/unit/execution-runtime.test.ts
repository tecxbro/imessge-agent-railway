import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CodexRuntimeError,
  type CodexRunRequest,
  type CodexRunResult,
  type StructuredCodexRunner,
} from "../../src/agent/codex-client.js";
import { ExecutionRuntime } from "../../src/agent/execution-runtime.js";
import { executionTaskSchema } from "../../src/agent/schemas.js";
import {
  ThreadStore,
  type CodexThreadRepository,
  type StoredCodexThread,
} from "../../src/agent/thread-store.js";

const modelProfile = { model: "gpt-5.6-luna", effort: "high" } as const;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

class CanceledRunner implements StructuredCodexRunner {
  public calls = 0;

  public async runStructured<Output>(
    _request: CodexRunRequest<Output>,
  ): Promise<CodexRunResult<Output>> {
    this.calls += 1;
    throw new CodexRuntimeError("CODEX_CANCELED", "canceled", true);
  }
}

class ArtifactRunner implements StructuredCodexRunner {
  public async runStructured<Output>(
    request: CodexRunRequest<Output>,
  ): Promise<CodexRunResult<Output>> {
    return {
      threadId: "artifact-thread",
      output: request.outputSchema.parse({
        taskId: "task-a",
        status: "succeeded",
        userSafeSummary: "Created the requested artifact.",
        artifacts: [
          {
            type: "file",
            path: "escaped-artifact.md",
            description: "Unsafe symlink fixture",
          },
        ],
        proposedActions: [],
        memoryCandidates: [],
        error: null,
      }),
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

function task(workspaceBinding = "workspace") {
  return executionTaskSchema.parse({
    id: "task-a",
    agentName: "repo-agent",
    purpose: "Inspect one repository.",
    instructions: "Return a bounded result.",
    workspaceBinding,
    permissionProfile: "workspace-write",
    dependsOn: [],
  });
}

describe("bounded execution runtime", () => {
  it("transitions an aborted Codex run to a canceled terminal result", async () => {
    const root = await mkdtemp(join(tmpdir(), "execution-runtime-test-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "workspace"));
    const runner = new CanceledRunner();
    const runtime = new ExecutionRuntime(
      new ThreadStore(new TestThreadRepository(), runner, () => runner),
    );

    const result = await runtime.run({
      chainId: "00000000-0000-4000-8000-000000000010",
      ownerId: "00000000-0000-4000-8000-000000000001",
      authorizedPermissionProfiles: ["workspace-write"],
      task: task(),
      modelProfile,
      resolvedWorkspacePath: join(root, "workspace"),
      policySections: [
        {
          name: "Execution policy",
          trust: "trusted-policy",
          content: "Stay within the workspace.",
        },
      ],
    });

    expect(result.result).toMatchObject({
      taskId: "task-a",
      status: "canceled",
      error: { code: "CODEX_TASK_CANCELED", retryable: true },
    });
    expect(runner.calls).toBe(1);
  });

  it("rejects a permission outside the exact authorized set before invoking Codex", async () => {
    const root = await mkdtemp(join(tmpdir(), "execution-runtime-root-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "workspace"));
    const runner = new CanceledRunner();
    const runtime = new ExecutionRuntime(
      new ThreadStore(new TestThreadRepository(), runner, () => runner),
    );

    await expect(
      runtime.run({
        chainId: "00000000-0000-4000-8000-000000000010",
        ownerId: "00000000-0000-4000-8000-000000000001",
        authorizedPermissionProfiles: ["read"],
        task: task(),
        modelProfile,
        resolvedWorkspacePath: join(root, "workspace"),
        policySections: [
          {
            name: "Execution policy",
            trust: "trusted-policy",
            content: "Stay within the workspace.",
          },
        ],
      }),
    ).rejects.toThrow(/not in the code-authorized set/);
    expect(runner.calls).toBe(0);
  });

  it("rejects an artifact symlink that escapes after execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "execution-artifact-root-"));
    const outside = await mkdtemp(join(tmpdir(), "execution-artifact-outside-"));
    temporaryDirectories.push(root, outside);
    const workspace = join(root, "workspace");
    const outsideFile = join(outside, "private.md");
    await mkdir(workspace);
    await writeFile(outsideFile, "private", "utf8");
    await symlink(outsideFile, join(workspace, "escaped-artifact.md"));
    const runtime = new ExecutionRuntime(
      new ThreadStore(
        new TestThreadRepository(),
        new ArtifactRunner(),
        () => new ArtifactRunner(),
      ),
    );

    await expect(
      runtime.run({
        chainId: "00000000-0000-4000-8000-000000000010",
        ownerId: "00000000-0000-4000-8000-000000000001",
        authorizedPermissionProfiles: ["workspace-write"],
        task: task(),
        modelProfile,
        resolvedWorkspacePath: workspace,
        policySections: [
          {
            name: "Execution policy",
            trust: "trusted-policy",
            content: "Keep artifacts inside the workspace.",
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "CODEX_STRUCTURED_OUTPUT_INVALID",
      retryable: false,
    });
  });
});
