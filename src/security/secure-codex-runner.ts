import type { z } from "zod";

import type { ModelProfile } from "../config/model-profiles.js";
import type { PermissionProfileName } from "./permissions.js";
import {
  CodexStartDeniedError,
  type QueuedAuthorizationReferenceStore,
  QueuedCodexStartGate,
} from "./queued-authorization.js";

export interface SecureCodexProgressEvent {
  type: "thinking" | "tool" | "file" | "web";
  state: "started" | "updated" | "completed";
}

export interface SecureCodexRunRequest<Output> {
  threadId?: string;
  prompt: string;
  outputSchema: z.ZodType<Output>;
  modelProfile: ModelProfile;
  permissionProfile: PermissionProfileName;
  workingDirectory: string;
  skipGitRepoCheck: boolean;
  signal?: AbortSignal;
  maximumRuntimeMs?: number;
  concurrencyKey?: string;
  onProgress?: (event: SecureCodexProgressEvent) => void;
}

export interface SecureCodexUsage {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

export interface SecureCodexRunResult<Output> {
  threadId: string;
  output: Output;
  usage: SecureCodexUsage | null;
}

/** Structural port matching the agent-layer StructuredCodexRunner contract. */
export interface SecureStructuredCodexRunnerPort {
  runStructured<Output>(
    request: SecureCodexRunRequest<Output>,
  ): Promise<SecureCodexRunResult<Output>>;
}

export interface SecureStructuredCodexRunnerOptions {
  chainId: string;
  authorizationReferences: QueuedAuthorizationReferenceStore;
  startGate: QueuedCodexStartGate;
  delegate: SecureStructuredCodexRunnerPort;
}

/**
 * StructuredCodexRunner decorator for one queued chain. ThreadStore may invoke
 * the decorator more than once during recovery, so the reference and every
 * captured identity are reloaded immediately before each delegated call.
 */
export class SecureStructuredCodexRunner
  implements SecureStructuredCodexRunnerPort
{
  public constructor(
    private readonly options: SecureStructuredCodexRunnerOptions,
  ) {}

  public async runStructured<Output>(
    request: SecureCodexRunRequest<Output>,
  ): Promise<SecureCodexRunResult<Output>> {
    const reference = await this.options.authorizationReferences.load(
      this.options.chainId,
    );
    if (reference === undefined || reference.chainId !== this.options.chainId) {
      throw new CodexStartDeniedError("CODEX_START_AUTHORIZATION_INVALID");
    }
    return await this.options.startGate.start(reference, async () =>
      this.options.delegate.runStructured(request),
    );
  }
}
