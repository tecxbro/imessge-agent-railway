import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ExecutionResult,
  InteractionDecision,
} from "../../src/agent/schemas.js";
import type {
  PlanFinalCommitInput,
  TurnPlanCommitBase,
} from "../../src/orchestration/contracts/turn-plan.js";
import type { SynthesisFinalCommitInput } from "../../src/orchestration/contracts/turn-synthesis.js";
import type {
  TaskExecutePayload,
  TurnPlanPayload,
  TurnSynthesizePayload,
} from "../../src/queue/payloads.js";
import type { Database } from "../../src/db/client.js";
import {
  OrchestrationRepository,
  type OrchestrationRepositoryOptions,
} from "../../src/db/repositories/orchestration.js";
import { OrchestrationRecoveryRepository } from "../../src/db/repositories/orchestration-recovery.js";
import { TaskExecutionRepository } from "../../src/db/repositories/task-execution.js";
import { TurnPlanningRepository } from "../../src/db/repositories/turn-planning.js";
import { TurnSynthesisRepository } from "../../src/db/repositories/turn-synthesis.js";

const chainId = "00000000-0000-4000-8000-000000000001";
const taskId = "00000000-0000-4000-8000-000000000002";
const planPayload: TurnPlanPayload = {
  chainId,
  expectedChainVersion: 3,
  expectedState: "queued",
};
const taskPayload: TaskExecutePayload = {
  taskId,
  chainId,
  expectedChainVersion: 3,
  expectedState: "queued",
};
const synthesisPayload: TurnSynthesizePayload = {
  chainId,
  expectedChainVersion: 3,
  expectedState: "executing",
};
const silentDecision: InteractionDecision = {
  mode: "silent",
  userMessage: null,
  statusMessage: null,
  tasks: [],
  waitForTasks: false,
  memoryCandidates: [],
};
const result: ExecutionResult = {
  taskId: "task-1",
  status: "succeeded",
  userSafeSummary: "Done.",
  artifacts: [],
  proposedActions: [],
  memoryCandidates: [],
  error: null,
};

const options: OrchestrationRepositoryOptions = {
  workspaceRoot: "/workspace",
  interactionWorkingDirectory: "/interaction",
  decrypt: (ciphertext) => ciphertext,
  encrypt: (plaintext) => plaintext,
  capabilities: () => [],
};

function repository(): OrchestrationRepository {
  return new OrchestrationRepository({} as Database, options);
}

describe("OrchestrationRepository compatibility facade", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves the existing orchestration method surface", () => {
    const methods = Object.getOwnPropertyNames(
      OrchestrationRepository.prototype,
    );
    expect(methods).toEqual(
      expect.arrayContaining([
        "claimTask",
        "commitDelegation",
        "commitFinal",
        "commitSilent",
        "completeTask",
        "constructor",
        "failTaskAttempt",
        "findRunnableTaskPayloads",
        "findSynthesisPayloads",
        "loadPlanContext",
        "loadSynthesisContext",
        "requeueStaleRunningTasks",
      ]),
    );
  });

  it("delegates planning calls and direct final commits", async () => {
    const load = vi
      .spyOn(TurnPlanningRepository.prototype, "loadPlanContext")
      .mockResolvedValue(null);
    const delegation = vi
      .spyOn(TurnPlanningRepository.prototype, "commitDelegation")
      .mockResolvedValue({ rootTasks: [{ taskId }] });
    const silent = vi
      .spyOn(TurnPlanningRepository.prototype, "commitSilent")
      .mockResolvedValue(undefined);
    const final = vi
      .spyOn(TurnPlanningRepository.prototype, "commitFinal")
      .mockResolvedValue({ outboundBatchId: "plan-batch" });
    const facade = repository();
    const commitBase: TurnPlanCommitBase = {
      payload: planPayload,
      decision: silentDecision,
      promptVersion: "v1",
    };
    const finalInput: PlanFinalCommitInput = {
      ...commitBase,
      encryptedParts: ["ciphertext"],
    };

    await expect(facade.loadPlanContext(planPayload)).resolves.toBeNull();
    await expect(
      facade.commitDelegation({
        ...commitBase,
        tasks: [],
        rootLogicalTaskIds: [],
      }),
    ).resolves.toEqual({ rootTasks: [{ taskId }] });
    await expect(facade.commitSilent(commitBase)).resolves.toBeUndefined();
    await expect(facade.commitFinal(finalInput)).resolves.toEqual({
      outboundBatchId: "plan-batch",
    });

    expect(load).toHaveBeenCalledWith(planPayload);
    expect(delegation).toHaveBeenCalledWith({
      ...commitBase,
      tasks: [],
      rootLogicalTaskIds: [],
    });
    expect(silent).toHaveBeenCalledWith(commitBase);
    expect(final).toHaveBeenCalledWith(finalInput);
  });

  it("delegates execution calls", async () => {
    const claim = vi
      .spyOn(TaskExecutionRepository.prototype, "claimTask")
      .mockResolvedValue(null);
    const complete = vi
      .spyOn(TaskExecutionRepository.prototype, "completeTask")
      .mockResolvedValue({
        accepted: true,
        readyTasks: [],
        shouldSynthesize: true,
      });
    const fail = vi
      .spyOn(TaskExecutionRepository.prototype, "failTaskAttempt")
      .mockResolvedValue({
        accepted: true,
        readyTasks: [],
        shouldSynthesize: false,
        retry: true,
      });
    const facade = repository();
    const completeInput = {
      payload: taskPayload,
      result,
      promptSha256: "a".repeat(64),
      recovered: false,
    };
    const failInput = { payload: taskPayload, result };

    await expect(facade.claimTask(taskPayload)).resolves.toBeNull();
    await expect(facade.completeTask(completeInput)).resolves.toEqual({
      accepted: true,
      readyTasks: [],
      shouldSynthesize: true,
    });
    await expect(facade.failTaskAttempt(failInput)).resolves.toEqual({
      accepted: true,
      readyTasks: [],
      shouldSynthesize: false,
      retry: true,
    });

    expect(claim).toHaveBeenCalledWith(taskPayload);
    expect(complete).toHaveBeenCalledWith(completeInput);
    expect(fail).toHaveBeenCalledWith(failInput);
  });

  it("delegates synthesis and recovery calls with legacy defaults", async () => {
    const load = vi
      .spyOn(TurnSynthesisRepository.prototype, "loadSynthesisContext")
      .mockResolvedValue(null);
    const final = vi
      .spyOn(TurnSynthesisRepository.prototype, "commitFinal")
      .mockResolvedValue({ outboundBatchId: "synthesis-batch" });
    const runnable = vi
      .spyOn(
        OrchestrationRecoveryRepository.prototype,
        "findRunnableTaskPayloads",
      )
      .mockResolvedValue([]);
    const requeue = vi
      .spyOn(
        OrchestrationRecoveryRepository.prototype,
        "requeueStaleRunningTasks",
      )
      .mockResolvedValue(2);
    const syntheses = vi
      .spyOn(
        OrchestrationRecoveryRepository.prototype,
        "findSynthesisPayloads",
      )
      .mockResolvedValue([]);
    const facade = repository();
    const finalInput: SynthesisFinalCommitInput = {
      payload: synthesisPayload,
      decision: silentDecision,
      terminalResults: [result],
      promptVersion: "v1",
      promptSha256: "a".repeat(64),
      encryptedParts: ["ciphertext"],
    };
    const staleBefore = new Date("2026-08-18T00:00:00.000Z");

    await expect(
      facade.loadSynthesisContext(synthesisPayload),
    ).resolves.toBeNull();
    await expect(facade.commitFinal(finalInput)).resolves.toEqual({
      outboundBatchId: "synthesis-batch",
    });
    await expect(facade.findRunnableTaskPayloads()).resolves.toEqual([]);
    await expect(
      facade.requeueStaleRunningTasks(staleBefore),
    ).resolves.toBe(2);
    await expect(facade.findSynthesisPayloads()).resolves.toEqual([]);

    expect(load).toHaveBeenCalledWith(synthesisPayload);
    expect(final).toHaveBeenCalledWith(finalInput);
    expect(runnable).toHaveBeenCalledWith(100);
    expect(requeue).toHaveBeenCalledWith(staleBefore, 100);
    expect(syntheses).toHaveBeenCalledWith(100);
  });
});
