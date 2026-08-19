import { executionResultSchema } from "../../agent/schemas.js";
import type { ActionExecutorRegistry } from "../../actions/action-executor-registry.js";
import type {
  ApprovalService,
  ImmutableApprovalRequest,
} from "../../security/approvals.js";
import {
  approvalRequestPayloadSchema,
  type ApprovalRequestPayload,
} from "../extensions/approval-queues.js";

export interface DurableApprovalProposal {
  ownerId: string;
  spaceId: string;
  chainId: string;
  executionTaskId: string;
  logicalTaskId: string;
  executionResultCiphertext: string;
}

export interface ApprovalRequestRepository {
  loadApprovalRequestContext(
    executionTaskId: string,
  ): Promise<DurableApprovalProposal | null>;
}

export interface ApprovalRequestMessage {
  approvalId: string;
  ownerId: string;
  spaceId: string;
  idempotencyKey: string;
  body: string;
}

export interface ApprovalRequestPublisher {
  publishApprovalRequest(message: ApprovalRequestMessage): Promise<void>;
}

export interface ApprovalRequestDependencies {
  repository: ApprovalRequestRepository;
  approvals: Pick<ApprovalService, "create">;
  executors: Pick<ActionExecutorRegistry, "require">;
  publisher: ApprovalRequestPublisher;
  decryptExecutionResult(ciphertext: string): Promise<string> | string;
}

/** Deterministic, code-owned text. No model-supplied human summary is used. */
export function formatApprovalRequestMessage(
  request: ImmutableApprovalRequest,
): string {
  return [
    "Approval required.",
    request.humanSummary,
    `Reply /approve ${request.id} or /reject ${request.id} before ${request.expiresAt}.`,
  ].join("\n");
}

export function createApprovalRequestHandler(
  dependencies: ApprovalRequestDependencies,
) {
  return async (
    unparsedPayload: ApprovalRequestPayload,
  ): Promise<ImmutableApprovalRequest | null> => {
    const payload = approvalRequestPayloadSchema.parse(unparsedPayload);
    const durable = await dependencies.repository.loadApprovalRequestContext(
      payload.executionTaskId,
    );
    if (durable === null) {
      return null;
    }
    if (durable.executionTaskId !== payload.executionTaskId) {
      throw new Error(
        "Approval request repository returned a different execution task.",
      );
    }

    let rawResult: unknown;
    try {
      rawResult = JSON.parse(
        await dependencies.decryptExecutionResult(
          durable.executionResultCiphertext,
        ),
      ) as unknown;
    } catch (error) {
      throw new Error(
        "The durable approval proposal could not be decrypted and parsed. Reject the request and inspect task storage.",
        { cause: error },
      );
    }
    const result = executionResultSchema.parse(rawResult);
    if (
      result.status !== "needs_approval" ||
      result.taskId !== durable.logicalTaskId ||
      result.proposedActions.length !== 1
    ) {
      throw new Error(
        "The durable execution result is not one exact approval proposal for this task.",
      );
    }
    const action = result.proposedActions[0]!;

    // Fail before an approval row or owner-visible request can be created.
    dependencies.executors.require(action.actionType);

    const request = await dependencies.approvals.create(
      {
        ownerId: durable.ownerId,
        spaceId: durable.spaceId,
        executionTaskId: durable.executionTaskId,
        chainId: durable.chainId,
      },
      action,
    );
    await dependencies.publisher.publishApprovalRequest({
      approvalId: request.id,
      ownerId: request.ownerId,
      spaceId: request.spaceId,
      idempotencyKey: request.id,
      body: formatApprovalRequestMessage(request),
    });
    return request;
  };
}
