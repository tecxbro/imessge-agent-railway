import { z } from "zod";

export const QUEUE_NAMES = {
  inboundFlush: "inbound.flush",
  turnPlan: "turn.plan",
  taskExecute: "task.execute",
  turnSynthesize: "turn.synthesize",
  outboundSend: "outbound.send",
  approvalRequest: "approval.request",
  approvalExecute: "approval.execute",
  memoryCurate: "memory.curate",
  maintenanceRetention: "maintenance.retention",
  maintenanceHealth: "maintenance.health",
} as const;

export const QUEUE_NAME_VALUES = [
  QUEUE_NAMES.inboundFlush,
  QUEUE_NAMES.turnPlan,
  QUEUE_NAMES.taskExecute,
  QUEUE_NAMES.turnSynthesize,
  QUEUE_NAMES.outboundSend,
  QUEUE_NAMES.approvalRequest,
  QUEUE_NAMES.approvalExecute,
  QUEUE_NAMES.memoryCurate,
  QUEUE_NAMES.maintenanceRetention,
  QUEUE_NAMES.maintenanceHealth,
] as const;

export const queueNameSchema = z.enum(QUEUE_NAME_VALUES);

export type QueueName = z.infer<typeof queueNameSchema>;
