import type { PgBoss } from "pg-boss";

import { QUEUE_NAMES } from "./names.js";
import type {
  InboundFlushPayload,
  ApprovalExecutePayload,
  ApprovalRequestPayload,
  MemoryCuratePayload,
  OutboundSendPayload,
  TaskExecutePayload,
  TurnPlanPayload,
  TurnSynthesizePayload,
} from "./payloads.js";

export interface QueuePublisher {
  scheduleInboundFlush(payload: InboundFlushPayload, debounceMs: number): Promise<void>;
  enqueueTurnPlan(payload: TurnPlanPayload): Promise<void>;
  enqueueTaskExecute(payload: TaskExecutePayload): Promise<void>;
  enqueueTurnSynthesize(payload: TurnSynthesizePayload): Promise<void>;
  enqueueOutboundSend(payload: OutboundSendPayload): Promise<void>;
  enqueueApprovalRequest(payload: ApprovalRequestPayload): Promise<void>;
  enqueueApprovalExecute(payload: ApprovalExecutePayload): Promise<void>;
  enqueueMemoryCurate(payload: MemoryCuratePayload): Promise<void>;
}

export class PgBossPublisher implements QueuePublisher {
  public constructor(
    private readonly boss: Pick<PgBoss, "send" | "upsert">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async scheduleInboundFlush(
    payload: InboundFlushPayload,
    debounceMs: number,
  ): Promise<void> {
    const startAfter = new Date(this.now().getTime() + debounceMs);
    await this.boss.upsert(
      QUEUE_NAMES.inboundFlush,
      payload,
      {
        singletonKey: `space:${payload.spaceId}`,
        startAfter,
        retryLimit: 5,
        retryDelay: 2,
        retryBackoff: true,
        expireInSeconds: 60,
      },
    );
  }

  public async enqueueTurnPlan(payload: TurnPlanPayload): Promise<void> {
    await this.sendSingleton(
      QUEUE_NAMES.turnPlan,
      payload,
      `chain:${payload.chainId}:plan`,
    );
  }

  public async enqueueTaskExecute(payload: TaskExecutePayload): Promise<void> {
    await this.sendSingleton(
      QUEUE_NAMES.taskExecute,
      payload,
      `task:${payload.taskId}`,
    );
  }

  public async enqueueTurnSynthesize(
    payload: TurnSynthesizePayload,
  ): Promise<void> {
    await this.sendSingleton(
      QUEUE_NAMES.turnSynthesize,
      payload,
      `chain:${payload.chainId}:synthesize`,
    );
  }

  public async enqueueOutboundSend(payload: OutboundSendPayload): Promise<void> {
    await this.sendSingleton(
      QUEUE_NAMES.outboundSend,
      payload,
      `outbound:${payload.outboundBatchId}`,
    );
  }

  public async enqueueApprovalRequest(
    payload: ApprovalRequestPayload,
  ): Promise<void> {
    await this.sendSingleton(
      QUEUE_NAMES.approvalRequest,
      payload,
      `approval-request:${payload.executionTaskId}`,
    );
  }

  public async enqueueApprovalExecute(
    payload: ApprovalExecutePayload,
  ): Promise<void> {
    await this.sendSingleton(
      QUEUE_NAMES.approvalExecute,
      payload,
      `approval-execute:${payload.actionExecutionId}`,
    );
  }

  public async enqueueMemoryCurate(payload: MemoryCuratePayload): Promise<void> {
    await this.sendSingleton(
      QUEUE_NAMES.memoryCurate,
      payload,
      `memory:${payload.chainId}:${payload.expectedChainVersion}`,
    );
  }

  private async sendSingleton(
    name:
      | typeof QUEUE_NAMES.turnPlan
      | typeof QUEUE_NAMES.taskExecute
      | typeof QUEUE_NAMES.turnSynthesize
      | typeof QUEUE_NAMES.outboundSend
      | typeof QUEUE_NAMES.approvalRequest
      | typeof QUEUE_NAMES.approvalExecute
      | typeof QUEUE_NAMES.memoryCurate,
    payload:
      | TurnPlanPayload
      | TaskExecutePayload
      | TurnSynthesizePayload
      | OutboundSendPayload
      | ApprovalRequestPayload
      | ApprovalExecutePayload
      | MemoryCuratePayload,
    singletonKey: string,
  ): Promise<void> {
    await this.boss.send(name, payload, {
      singletonKey,
      retryLimit: 5,
      retryDelay: 2,
      retryBackoff: true,
      expireInSeconds: 900,
    });
  }
}
