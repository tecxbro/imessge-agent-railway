import { describe, expect, it, vi } from "vitest";

import { executionResultSchema, executionTaskSchema } from "../../src/agent/schemas.js";
import { DEFAULT_MODEL_SELECTION } from "../../src/agent/model-selection.js";
import { loadPromptBundle } from "../../src/config/prompt-bundle.js";
import { createTaskExecuteHandler } from "../../src/queue/handlers/task-execute.js";

const taskId = "40000000-0000-4000-8000-000000000001";
const chainId = "40000000-0000-4000-8000-000000000002";
const payload = {
  taskId,
  chainId,
  expectedChainVersion: 2,
  expectedState: "queued" as const,
};

describe("Step 5 task execution handler", () => {
  it("runs one bounded task, collects its structured result, and releases dependents", async () => {
    const task = executionTaskSchema.parse({
      id: "inspect",
      agentName: "runtime-reviewer",
      purpose: "Inspect the bounded runtime path.",
      instructions: "Return evidence for the runtime path.",
      workspaceBinding: "primary-repo",
      permissionProfile: "read",
      dependsOn: [],
    });
    const result = executionResultSchema.parse({
      taskId: task.id,
      status: "succeeded",
      userSafeSummary: "The bounded runtime path is verified.",
      artifacts: [],
      proposedActions: [],
      memoryCandidates: [],
      error: null,
    });
    const completeTask = vi.fn(async () => ({
      accepted: true,
      readyTasks: [
        { taskId: "40000000-0000-4000-8000-000000000003" },
        { taskId: "40000000-0000-4000-8000-000000000004" },
      ],
      shouldSynthesize: false,
    }));
    const enqueueTaskExecute = vi.fn(async () => undefined);
    const enqueueTurnSynthesize = vi.fn(async () => undefined);
    const executionRun = vi.fn(async (_request: unknown) => ({
      result,
      threadId: "thread-runtime-reviewer",
      promptSha256: "a".repeat(64),
      usage: null,
      recovered: false,
    }));
    const handler = createTaskExecuteHandler({
      repository: {
        claimTask: async () => ({
          ownerId: "40000000-0000-4000-8000-000000000005",
          task,
          modelSelection: DEFAULT_MODEL_SELECTION,
          maximumPermissionProfile: "read",
          workspaceRoot: "/tmp/workspaces",
          relevantContext: [],
        }),
        completeTask,
        failTaskAttempt: vi.fn(),
      },
      execution: { run: executionRun },
      publisher: { enqueueTaskExecute, enqueueTurnSynthesize },
      promptBundle: await loadPromptBundle(),
    });

    await handler(payload);

    expect(executionRun).toHaveBeenCalledTimes(1);
    expect(executionRun).toHaveBeenCalledWith(
      expect.objectContaining({
        modelProfile: { model: "gpt-5.6-luna", effort: "high" },
      }),
    );
    expect(executionRun.mock.calls[0]?.[0]).not.toHaveProperty("onProgress");
    expect(completeTask).toHaveBeenCalledWith(
      expect.objectContaining({ payload, result }),
    );
    expect(enqueueTaskExecute).toHaveBeenCalledTimes(2);
    expect(enqueueTurnSynthesize).not.toHaveBeenCalled();
  });

  it("enqueues one synthesis when the terminal result scan says the graph is done", async () => {
    const task = executionTaskSchema.parse({
      id: "final-check",
      agentName: "runtime-reviewer",
      purpose: "Finish the bounded check.",
      instructions: "Return the final evidence.",
      workspaceBinding: "primary-repo",
      permissionProfile: "read",
      dependsOn: [],
    });
    const result = executionResultSchema.parse({
      taskId: task.id,
      status: "failed",
      userSafeSummary: "The final check could not complete.",
      artifacts: [],
      proposedActions: [],
      memoryCandidates: [],
      error: {
        code: "SAFE_FIXTURE_FAILURE",
        retryable: false,
        safeMessage: "The fixture dependency is unavailable.",
      },
    });
    const enqueueTurnSynthesize = vi.fn(async () => undefined);
    const handler = createTaskExecuteHandler({
      repository: {
        claimTask: async () => ({
          ownerId: "40000000-0000-4000-8000-000000000005",
          task,
          modelSelection: DEFAULT_MODEL_SELECTION,
          maximumPermissionProfile: "read",
          workspaceRoot: "/tmp/workspaces",
          relevantContext: [],
        }),
        completeTask: async () => ({
          accepted: true,
          readyTasks: [],
          shouldSynthesize: true,
        }),
        failTaskAttempt: vi.fn(),
      },
      execution: {
        run: async () => ({
          result,
          promptSha256: "b".repeat(64),
          usage: null,
          recovered: false,
        }),
      },
      publisher: {
        enqueueTaskExecute: vi.fn(),
        enqueueTurnSynthesize,
      },
      promptBundle: await loadPromptBundle(),
    });

    await handler(payload);

    expect(enqueueTurnSynthesize).toHaveBeenCalledWith({
      chainId,
      expectedChainVersion: 2,
      expectedState: "executing",
    });
  });
});
