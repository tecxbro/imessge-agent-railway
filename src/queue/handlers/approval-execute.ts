import { z } from "zod";

import {
  ActionExecutorError,
  actionExecutorInputSchema,
  actionExecutorResultSchema,
} from "../../actions/action-executor.js";
import {
  ActionExecutorRegistry,
  UnsupportedActionTypeError,
} from "../../actions/action-executor-registry.js";
import type {
  ActionExecutionFailureOutcome,
  RecordActionExecutionFailureInput,
  StoredActionExecution,
} from "../../db/repositories/action-executions.js";
import {
  decryptStoredApprovedAction,
  type ApprovalChainProgression,
  type ApprovalPayloadCipher,
  type ApprovalRunnableTask,
} from "../../security/approvals.js";
import {
  approvalExecutePayloadSchema,
  type ApprovalExecutePayload,
} from "../extensions/approval-queues.js";

export interface ApprovalActionExecutionRepository {
  claimActionExecution(
    payload: ApprovalExecutePayload,
  ): Promise<StoredActionExecution | null>;
  loadCompletedProgression?(
    actionExecutionId: string,
  ): Promise<ApprovalChainProgression | null>;
  completeActionExecution(
    actionExecutionId: string,
    result: z.infer<typeof actionExecutorResultSchema>,
  ): Promise<ApprovalChainProgression | null>;
  recordActionExecutionFailure(
    input: RecordActionExecutionFailureInput,
  ): Promise<ActionExecutionFailureOutcome>;
}

export interface ApprovalProgressionPublisher {
  enqueueNewlyRunnableTask(task: ApprovalRunnableTask): Promise<void>;
  enqueueApprovalSynthesis(input: {
    chainId: string;
    expectedChainVersion: number;
    expectedState: "executing";
  }): Promise<void>;
}

export interface ApprovalExecuteDependencies {
  repository: ApprovalActionExecutionRepository;
  executors: ActionExecutorRegistry;
  cipher: ApprovalPayloadCipher;
  publisher: ApprovalProgressionPublisher;
}

interface ClassifiedFailure {
  code: string;
  retryable: boolean;
  safeMessage: string;
}

function classifyFailure(error: unknown): ClassifiedFailure {
  if (error instanceof ActionExecutorError) {
    return error;
  }
  if (error instanceof UnsupportedActionTypeError) {
    return error;
  }
  if (error instanceof z.ZodError) {
    return {
      code: "ACTION_EXECUTOR_RESULT_INVALID",
      retryable: false,
      safeMessage: "The action provider returned an invalid bounded result.",
    };
  }
  if (error instanceof Error && error.name === "AbortError") {
    return {
      code: "ACTION_EXECUTION_ABORTED",
      retryable: true,
      safeMessage: "The action execution was interrupted before completion.",
    };
  }
  return {
    code: "ACTION_EXECUTOR_FAILED",
    retryable: true,
    safeMessage: "The action provider failed before confirming completion.",
  };
}

async function publishProgression(
  progression: ApprovalChainProgression | null,
  publisher: ApprovalProgressionPublisher,
): Promise<void> {
  if (progression === null) {
    return;
  }
  await Promise.all(
    progression.newlyRunnableTasks.map(async (task) => {
      await publisher.enqueueNewlyRunnableTask(task);
    }),
  );
  if (progression.shouldSynthesize) {
    await publisher.enqueueApprovalSynthesis({
      chainId: progression.chainId,
      expectedChainVersion: progression.expectedChainVersion,
      expectedState: "executing",
    });
  }
}

export function createApprovalExecuteHandler(
  dependencies: ApprovalExecuteDependencies,
) {
  return async (
    unparsedPayload: ApprovalExecutePayload,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<void> => {
    const payload = approvalExecutePayloadSchema.parse(unparsedPayload);
    const stored = await dependencies.repository.claimActionExecution(payload);
    if (stored === null) {
      const recoveryProgression =
        dependencies.repository.loadCompletedProgression === undefined
          ? null
          : await dependencies.repository.loadCompletedProgression(
              payload.actionExecutionId,
            );
      await publishProgression(recoveryProgression, dependencies.publisher);
      return;
    }
    const action = decryptStoredApprovedAction(
      {
        ownerId: stored.ownerId,
        spaceId: stored.spaceId,
        executionTaskId: stored.executionTaskId,
        actionType: stored.actionType,
        actionHash: stored.actionHash,
        normalizedPayloadCiphertext: stored.normalizedPayloadCiphertext,
      },
      dependencies.cipher,
    );
    if (action === undefined) {
      const failure = await dependencies.repository.recordActionExecutionFailure({
        actionExecutionId: stored.actionExecutionId,
        errorCode: "APPROVED_ACTION_INVALID",
        retryable: false,
        safeMessage:
          "The stored approved action failed exact payload validation and was not executed.",
      });
      await publishProgression(failure.progression, dependencies.publisher);
      return;
    }

    let completedProgression: ApprovalChainProgression | null;
    try {
      signal.throwIfAborted();
      const executor = dependencies.executors.require(action.actionType);
      const input = actionExecutorInputSchema.parse({
        actionExecutionId: stored.actionExecutionId,
        ...action,
      });
      const result = actionExecutorResultSchema.parse(
        await executor.execute(input, signal),
      );
      signal.throwIfAborted();
      completedProgression =
        await dependencies.repository.completeActionExecution(
          stored.actionExecutionId,
          result,
        );
    } catch (error) {
      const classified = classifyFailure(error);
      const failure = await dependencies.repository.recordActionExecutionFailure({
        actionExecutionId: stored.actionExecutionId,
        errorCode: classified.code,
        retryable: classified.retryable,
        safeMessage: classified.safeMessage,
      });
      await publishProgression(failure.progression, dependencies.publisher);
      if (failure.retry) {
        throw error;
      }
      return;
    }
    await publishProgression(completedProgression, dependencies.publisher);
  };
}
