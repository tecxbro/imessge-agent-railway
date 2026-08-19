import type { ActionType } from "../security/action-schema.js";
import type { ActionExecutor } from "./action-executor.js";

export class UnsupportedActionTypeError extends Error {
  public readonly code = "ACTION_TYPE_UNSUPPORTED";
  public readonly retryable = false;
  public readonly safeMessage =
    "This action type has no code-registered executor and cannot be approved.";

  public constructor(public readonly actionType: ActionType) {
    super(
      `No action executor is registered for ${actionType}. Register a reviewed provider adapter before requesting approval.`,
    );
    this.name = "UnsupportedActionTypeError";
  }
}

export class ActionExecutorRegistry {
  private readonly executors = new Map<ActionType, ActionExecutor>();

  public constructor(executors: readonly ActionExecutor[] = []) {
    for (const executor of executors) {
      if (this.executors.has(executor.actionType)) {
        throw new Error(
          `Duplicate action executor registration for ${executor.actionType}.`,
        );
      }
      this.executors.set(executor.actionType, executor);
    }
  }

  public supports(actionType: ActionType): boolean {
    return this.executors.has(actionType);
  }

  public require(actionType: ActionType): ActionExecutor {
    const executor = this.executors.get(actionType);
    if (executor === undefined) {
      throw new UnsupportedActionTypeError(actionType);
    }
    return executor;
  }

  public supportedActionTypes(): readonly ActionType[] {
    return Object.freeze([...this.executors.keys()].sort());
  }
}
