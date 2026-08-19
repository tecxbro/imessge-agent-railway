import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type { Usage } from "@openai/codex-sdk";

import {
  CodexRuntimeError,
  type CodexProgressEvent,
} from "./codex-client.js";
import {
  codexExecutionResultSchema,
  executionResultSchema,
  type ExecutionResult,
  type ExecutionTask,
} from "./schemas.js";
import type { ModelProfile } from "../config/model-profiles.js";
import {
  enforcePermissionGrantSet,
} from "../security/permission-grants.js";
import type { PermissionProfileName } from "../security/permissions.js";
import { buildPrompt, type PromptSection } from "./prompt-builder.js";
import type { ThreadStore } from "./thread-store.js";

export interface ExecutionRuntimeRequest {
  chainId: string;
  ownerId: string;
  task: ExecutionTask;
  /** Exact code-owned set; permission profiles do not imply one another. */
  authorizedPermissionProfiles: readonly PermissionProfileName[];
  modelProfile: ModelProfile;
  resolvedWorkspacePath: string;
  policySections: readonly PromptSection[];
  recoverySummary?: string;
  signal?: AbortSignal;
  maximumRuntimeMs?: number;
  onProgress?: (event: CodexProgressEvent) => void;
}

export interface ExecutionRuntimeRunResult {
  result: ExecutionResult;
  threadId?: string;
  promptSha256: string;
  usage: Usage | null;
  recovered: boolean;
}

async function validateArtifactContainment(
  result: ExecutionResult,
  workspace: string,
): Promise<void> {
  for (const artifact of result.artifacts) {
    let resolved: string;
    try {
      resolved = await realpath(resolve(workspace, artifact.path));
    } catch (error) {
      throw new CodexRuntimeError(
        "CODEX_STRUCTURED_OUTPUT_INVALID",
        "Codex referenced an artifact that does not exist in the approved workspace. Create the artifact or remove the reference before retrying.",
        true,
        { cause: error },
      );
    }
    const relation = relative(workspace, resolved);
    if (relation === "" || relation.startsWith("..") || isAbsolute(relation)) {
      throw new CodexRuntimeError(
        "CODEX_STRUCTURED_OUTPUT_INVALID",
        "Codex referenced an artifact outside the approved workspace. Discard the result and retry with a contained artifact path.",
        false,
      );
    }
    const artifactStat = await stat(resolved);
    if (!artifactStat.isFile()) {
      throw new CodexRuntimeError(
        "CODEX_STRUCTURED_OUTPUT_INVALID",
        "Codex referenced an artifact that is not a file. Return a concrete file inside the approved workspace.",
        true,
      );
    }
  }
}

function canceledResult(taskId: string): ExecutionResult {
  return executionResultSchema.parse({
    taskId,
    status: "canceled",
    userSafeSummary: "This task was canceled because its chain was superseded.",
    artifacts: [],
    proposedActions: [],
    memoryCandidates: [],
    error: {
      code: "CODEX_TASK_CANCELED",
      retryable: true,
      safeMessage: "Retry only if the newer chain still needs this task.",
    },
  });
}

function timedOutResult(taskId: string): ExecutionResult {
  return executionResultSchema.parse({
    taskId,
    status: "failed",
    userSafeSummary: "This bounded task exceeded its runtime limit.",
    artifacts: [],
    proposedActions: [],
    memoryCandidates: [],
    error: {
      code: "CODEX_TASK_TIMEOUT",
      retryable: true,
      safeMessage: "Narrow the task or retry while its chain is current.",
    },
  });
}

export class ExecutionRuntime {
  public constructor(private readonly threads: ThreadStore) {}

  public async run(
    request: ExecutionRuntimeRequest,
  ): Promise<ExecutionRuntimeRunResult> {
    // Resolve the code-owned workspace and maximum permission grant before any
    // untrusted task purpose or instructions reach Codex.
    const binding = request.task.workspaceBinding ?? request.task.agentName;
    const workspace = await realpath(request.resolvedWorkspacePath);
    if (!(await stat(workspace)).isDirectory()) {
      throw new Error("The authorized execution workspace is not a directory.");
    }
    const permissionProfile = enforcePermissionGrantSet(
      request.task.permissionProfile,
      new Set(request.authorizedPermissionProfiles),
    );
    const prompt = buildPrompt({
      title: `Bounded execution task ${request.task.id}`,
      sections: [
        ...request.policySections,
        {
          name: "Task purpose",
          trust: "untrusted-context",
          content: request.task.purpose,
        },
        {
          name: "Task instructions",
          trust: "untrusted-context",
          content: request.task.instructions,
        },
      ],
    });

    try {
      const turn = await this.threads.run({
        authorizationChainId: request.chainId,
        scope: {
          kind: "executor",
          ownerId: request.ownerId,
          agentName: request.task.agentName,
          workspaceBinding: binding,
        },
        prompt: prompt.content,
        outputSchema: codexExecutionResultSchema,
        modelProfile: request.modelProfile,
        permissionProfile,
        workingDirectory: workspace,
        skipGitRepoCheck: false,
        ...(request.recoverySummary === undefined
          ? {}
          : { recoverySummary: request.recoverySummary }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(request.maximumRuntimeMs === undefined
          ? {}
          : { maximumRuntimeMs: request.maximumRuntimeMs }),
        ...(request.onProgress === undefined
          ? {}
          : { onProgress: request.onProgress }),
      });
      if (turn.output.taskId !== request.task.id) {
        throw new CodexRuntimeError(
          "CODEX_STRUCTURED_OUTPUT_INVALID",
          "Codex returned an execution result for a different task ID. Discard the result and retry the bounded task.",
          true,
        );
      }
      await validateArtifactContainment(turn.output, workspace);
      return {
        result: turn.output,
        threadId: turn.threadId,
        promptSha256: prompt.sha256,
        usage: turn.usage,
        recovered: turn.recovered,
      };
    } catch (error) {
      if (error instanceof CodexRuntimeError && error.code === "CODEX_CANCELED") {
        return {
          result: canceledResult(request.task.id),
          promptSha256: prompt.sha256,
          usage: null,
          recovered: false,
        };
      }
      if (error instanceof CodexRuntimeError && error.code === "CODEX_TIMEOUT") {
        return {
          result: timedOutResult(request.task.id),
          promptSha256: prompt.sha256,
          usage: null,
          recovered: false,
        };
      }
      throw error;
    }
  }
}
