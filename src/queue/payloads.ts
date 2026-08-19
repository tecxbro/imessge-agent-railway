import { z } from "zod";

import { QUEUE_NAMES, type QueueName } from "./names.js";

const idSchema = z.uuid();
const versionSchema = z.number().int().positive();

export const inboundFlushPayloadSchema = z
  .object({
    spaceId: idSchema,
  })
  .strict();

export const turnPlanPayloadSchema = z
  .object({
    chainId: idSchema,
    expectedChainVersion: versionSchema,
    expectedState: z.literal("queued"),
  })
  .strict();

export const taskExecutePayloadSchema = z
  .object({
    taskId: idSchema,
    chainId: idSchema,
    expectedChainVersion: versionSchema,
    expectedState: z.literal("queued"),
  })
  .strict();

export const turnSynthesizePayloadSchema = z
  .object({
    chainId: idSchema,
    expectedChainVersion: versionSchema,
    expectedState: z.literal("executing"),
  })
  .strict();

export const outboundSendPayloadSchema = z
  .object({
    outboundBatchId: idSchema,
    expectedState: z.enum(["queued", "sending"]),
  })
  .strict();

export const approvalRequestPayloadSchema = z
  .object({ executionTaskId: idSchema })
  .strict();

export const approvalExecutePayloadSchema = z
  .object({ actionExecutionId: idSchema })
  .strict();

export const memoryCuratePayloadSchema = z
  .object({
    chainId: idSchema,
    expectedChainVersion: versionSchema,
    expectedState: z.literal("complete"),
  })
  .strict();

export const maintenanceRetentionPayloadSchema = z.object({}).strict();
export const maintenanceHealthPayloadSchema = z.object({}).strict();

export const QUEUE_PAYLOAD_SCHEMAS = {
  [QUEUE_NAMES.inboundFlush]: inboundFlushPayloadSchema,
  [QUEUE_NAMES.turnPlan]: turnPlanPayloadSchema,
  [QUEUE_NAMES.taskExecute]: taskExecutePayloadSchema,
  [QUEUE_NAMES.turnSynthesize]: turnSynthesizePayloadSchema,
  [QUEUE_NAMES.outboundSend]: outboundSendPayloadSchema,
  [QUEUE_NAMES.approvalRequest]: approvalRequestPayloadSchema,
  [QUEUE_NAMES.approvalExecute]: approvalExecutePayloadSchema,
  [QUEUE_NAMES.memoryCurate]: memoryCuratePayloadSchema,
  [QUEUE_NAMES.maintenanceRetention]: maintenanceRetentionPayloadSchema,
  [QUEUE_NAMES.maintenanceHealth]: maintenanceHealthPayloadSchema,
} as const satisfies Record<QueueName, z.ZodType>;

export type InboundFlushPayload = z.infer<typeof inboundFlushPayloadSchema>;
export type TurnPlanPayload = z.infer<typeof turnPlanPayloadSchema>;
export type TaskExecutePayload = z.infer<typeof taskExecutePayloadSchema>;
export type TurnSynthesizePayload = z.infer<typeof turnSynthesizePayloadSchema>;
export type OutboundSendPayload = z.infer<typeof outboundSendPayloadSchema>;
export type ApprovalRequestPayload = z.infer<typeof approvalRequestPayloadSchema>;
export type ApprovalExecutePayload = z.infer<typeof approvalExecutePayloadSchema>;
export type MemoryCuratePayload = z.infer<typeof memoryCuratePayloadSchema>;
export type MaintenanceRetentionPayload = z.infer<
  typeof maintenanceRetentionPayloadSchema
>;
export type MaintenanceHealthPayload = z.infer<
  typeof maintenanceHealthPayloadSchema
>;

export interface QueuePayloadByName {
  [QUEUE_NAMES.inboundFlush]: InboundFlushPayload;
  [QUEUE_NAMES.turnPlan]: TurnPlanPayload;
  [QUEUE_NAMES.taskExecute]: TaskExecutePayload;
  [QUEUE_NAMES.turnSynthesize]: TurnSynthesizePayload;
  [QUEUE_NAMES.outboundSend]: OutboundSendPayload;
  [QUEUE_NAMES.approvalRequest]: ApprovalRequestPayload;
  [QUEUE_NAMES.approvalExecute]: ApprovalExecutePayload;
  [QUEUE_NAMES.memoryCurate]: MemoryCuratePayload;
  [QUEUE_NAMES.maintenanceRetention]: MaintenanceRetentionPayload;
  [QUEUE_NAMES.maintenanceHealth]: MaintenanceHealthPayload;
}

export function parseQueuePayload<Name extends QueueName>(
  name: Name,
  payload: unknown,
): QueuePayloadByName[Name] {
  return QUEUE_PAYLOAD_SCHEMAS[name].parse(payload) as QueuePayloadByName[Name];
}
