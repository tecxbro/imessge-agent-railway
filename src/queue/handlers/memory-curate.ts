import type { MemoryCurationRepository } from "../../db/repositories/memory-curation.js";
import {
  curateMemories,
  type CurationResultItem,
} from "../../memory/curator.js";
import type { MemoryReceiptStore } from "../../memory/receipts.js";
import type { SupermemoryPort } from "../../memory/supermemory-client.js";
import {
  memoryCuratePayloadSchema,
  type MemoryCuratePayload,
} from "../payloads.js";

const MAX_CANDIDATES_PER_CURATION_CALL = 20;

export interface MemoryCurateHandlerDependencies {
  repository: Pick<
    MemoryCurationRepository,
    "claimRun" | "markSucceeded" | "markFailed"
  >;
  receipts: MemoryReceiptStore;
  provider?: SupermemoryPort | null;
}

export class MemoryCurationRetryError extends Error {
  public readonly retryable = true;

  public constructor(public readonly code: string) {
    super(
      `Memory curation has a retryable candidate failure (${code}); retry the isolated projection job.`,
    );
    this.name = "MemoryCurationRetryError";
  }
}

function chunks<Value>(
  values: readonly Value[],
  size: number,
): readonly (readonly Value[])[] {
  const batches: Value[][] = [];
  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size));
  }
  return batches;
}

export function createMemoryCurateHandler(
  dependencies: MemoryCurateHandlerDependencies,
) {
  return async (
    unparsedPayload: MemoryCuratePayload,
    signal?: AbortSignal,
  ): Promise<void> => {
    const payload = memoryCuratePayloadSchema.parse(unparsedPayload);
    const provider = dependencies.provider ?? null;
    const claim = await dependencies.repository.claimRun(
      payload,
      provider !== null,
    );
    if (claim.status !== "claimed") {
      return;
    }
    if (claim.candidates.length === 0) {
      await dependencies.repository.markSucceeded(payload.chainId);
      return;
    }
    if (provider === null || claim.context === undefined) {
      await dependencies.repository.markFailed({
        chainId: payload.chainId,
        failureCode: "MEMORY_CURATION_CLAIM_INVALID",
        retryable: false,
      });
      return;
    }

    const results: CurationResultItem[] = [];
    for (const batch of chunks(
      claim.candidates,
      MAX_CANDIDATES_PER_CURATION_CALL,
    )) {
      results.push(
        ...(await curateMemories({
          provider,
          receipts: dependencies.receipts,
          context: claim.context,
          candidates: batch.map(({ candidate }) => candidate),
          ...(signal === undefined ? {} : { signal }),
        })),
      );
    }

    const failures = results.filter(
      (result): result is Extract<CurationResultItem, { status: "failed" }> =>
        result.status === "failed",
    );
    const retryableFailure = failures.find((failure) => failure.retryable);
    if (retryableFailure !== undefined) {
      await dependencies.repository.markFailed({
        chainId: payload.chainId,
        failureCode: retryableFailure.failureCode,
        retryable: true,
      });
      throw new MemoryCurationRetryError(retryableFailure.failureCode);
    }
    const terminalFailure = failures[0];
    if (terminalFailure !== undefined) {
      await dependencies.repository.markFailed({
        chainId: payload.chainId,
        failureCode: terminalFailure.failureCode,
        retryable: false,
      });
      return;
    }
    await dependencies.repository.markSucceeded(payload.chainId);
  };
}
