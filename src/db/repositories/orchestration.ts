import type { ExecutionResult } from "../../agent/schemas.js";
import type {
  TaskAttemptFailureOutcome,
  TaskExecutionContext,
  TaskTerminalOutcome,
} from "../../orchestration/contracts/task-execution.js";
import type {
  PersistedExecutionTaskInput,
  PlanFinalCommitInput,
  TurnPlanCommitBase,
  TurnPlanContext,
} from "../../orchestration/contracts/turn-plan.js";
import type {
  SynthesisFinalCommitInput,
  TurnSynthesisContext,
} from "../../orchestration/contracts/turn-synthesis.js";
import type {
  TaskExecutePayload,
  TurnPlanPayload,
  TurnSynthesizePayload,
} from "../../queue/payloads.js";
import type { Database } from "../client.js";
import { OrchestrationCodec } from "./orchestration-codec.js";
import { OrchestrationRecoveryRepository } from "./orchestration-recovery.js";
import type { OrchestrationRepositoryOptions } from "./orchestration-shared.js";
import { TaskExecutionRepository } from "./task-execution.js";
import { TurnPlanningRepository } from "./turn-planning.js";
import { TurnSynthesisRepository } from "./turn-synthesis.js";

export type { OrchestrationRepositoryOptions } from "./orchestration-shared.js";

/**
 * Compatibility facade for the original orchestration repository. Production
 * callers keep the same constructor and method surface while focused
 * repositories own planning, execution, synthesis, and recovery behavior.
 */
export class OrchestrationRepository {
  private readonly turnPlanning: TurnPlanningRepository;
  private readonly taskExecution: TaskExecutionRepository;
  private readonly turnSynthesis: TurnSynthesisRepository;
  private readonly recovery: OrchestrationRecoveryRepository;

  public constructor(
    database: Database,
    options: OrchestrationRepositoryOptions,
  ) {
    const codec = new OrchestrationCodec((plaintext) =>
      options.encrypt(plaintext),
    );
    this.turnPlanning = new TurnPlanningRepository(database, options, codec);
    this.taskExecution = new TaskExecutionRepository(database, options, codec);
    this.turnSynthesis = new TurnSynthesisRepository(database, options, codec);
    this.recovery = new OrchestrationRecoveryRepository(
      database,
      options.maximumTaskAttempts ?? 3,
      codec,
    );
  }

  public loadPlanContext(
    payload: TurnPlanPayload,
  ): Promise<TurnPlanContext | null> {
    return this.turnPlanning.loadPlanContext(payload);
  }

  public commitFinal(
    input: PlanFinalCommitInput | SynthesisFinalCommitInput,
  ): Promise<{ outboundBatchId: string }> {
    return "terminalResults" in input
      ? this.turnSynthesis.commitFinal(input)
      : this.turnPlanning.commitFinal(input);
  }

  public commitDelegation(
    input: TurnPlanCommitBase & {
      tasks: readonly PersistedExecutionTaskInput[];
      rootLogicalTaskIds: readonly string[];
    },
  ): Promise<{ rootTasks: readonly { taskId: string }[] }> {
    return this.turnPlanning.commitDelegation(input);
  }

  public commitSilent(input: TurnPlanCommitBase): Promise<void> {
    return this.turnPlanning.commitSilent(input);
  }

  public claimTask(
    payload: TaskExecutePayload,
  ): Promise<TaskExecutionContext | null> {
    return this.taskExecution.claimTask(payload);
  }

  public denyTaskCodexStart(input: {
    payload: TaskExecutePayload;
    errorCode: string;
  }): Promise<TaskTerminalOutcome> {
    return this.taskExecution.denyTaskCodexStart(input);
  }

  public completeTask(input: {
    payload: TaskExecutePayload;
    result: ExecutionResult;
    threadId?: string;
    promptSha256: string;
    recovered: boolean;
  }): Promise<TaskTerminalOutcome> {
    return this.taskExecution.completeTask(input);
  }

  public failTaskAttempt(input: {
    payload: TaskExecutePayload;
    result: ExecutionResult;
  }): Promise<TaskAttemptFailureOutcome> {
    return this.taskExecution.failTaskAttempt(input);
  }

  public loadSynthesisContext(
    payload: TurnSynthesizePayload,
  ): Promise<TurnSynthesisContext | null> {
    return this.turnSynthesis.loadSynthesisContext(payload);
  }

  public findRunnableTaskPayloads(
    limit = 100,
  ): Promise<TaskExecutePayload[]> {
    return this.recovery.findRunnableTaskPayloads(limit);
  }

  public denyChainCodexStart(input: {
    chainId: string;
    expectedChainVersion: number;
    expectedState: "queued" | "executing";
    errorCode: string;
  }): Promise<boolean> {
    return this.recovery.denyChainCodexStart(input);
  }

  public requeueStaleRunningTasks(
    staleBefore: Date,
    limit = 100,
  ): Promise<number> {
    return this.recovery.requeueStaleRunningTasks(staleBefore, limit);
  }

  public findSynthesisPayloads(
    limit = 100,
  ): Promise<TurnSynthesizePayload[]> {
    return this.recovery.findSynthesisPayloads(limit);
  }
}
