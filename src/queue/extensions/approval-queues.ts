import { QUEUE_NAMES } from "../names.js";
import {
  approvalExecutePayloadSchema,
  approvalRequestPayloadSchema,
  type ApprovalExecutePayload,
  type ApprovalRequestPayload,
} from "../payloads.js";

export const APPROVAL_QUEUE_NAMES = {
  request: QUEUE_NAMES.approvalRequest,
  execute: QUEUE_NAMES.approvalExecute,
} as const;

/** Compatibility facade; approval queues now live in the central contract. */
export {
  approvalExecutePayloadSchema,
  approvalRequestPayloadSchema,
  type ApprovalExecutePayload,
  type ApprovalRequestPayload,
};

export interface ApprovalQueuePublisher {
  enqueueApprovalRequest(payload: ApprovalRequestPayload): Promise<void>;
  enqueueApprovalExecute(payload: ApprovalExecutePayload): Promise<void>;
}

export function parseApprovalQueuePayload(
  queueName: typeof APPROVAL_QUEUE_NAMES.request,
  payload: unknown,
): ApprovalRequestPayload;
export function parseApprovalQueuePayload(
  queueName: typeof APPROVAL_QUEUE_NAMES.execute,
  payload: unknown,
): ApprovalExecutePayload;
export function parseApprovalQueuePayload(
  queueName: (typeof APPROVAL_QUEUE_NAMES)[keyof typeof APPROVAL_QUEUE_NAMES],
  payload: unknown,
): ApprovalRequestPayload | ApprovalExecutePayload {
  return queueName === APPROVAL_QUEUE_NAMES.request
    ? approvalRequestPayloadSchema.parse(payload)
    : approvalExecutePayloadSchema.parse(payload);
}
