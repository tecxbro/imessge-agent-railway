import { createHash } from "node:crypto";

import { z } from "zod";

import {
  memoryCandidateSchema,
  type MemoryCandidate,
} from "../agent/schemas.js";
import {
  type MemoryMetadata,
  MemoryProviderError,
  type SupermemoryPort,
  ownerContainerTag,
} from "./supermemory-client.js";
import {
  MemoryReceiptError,
  type MemoryReceiptStore,
} from "./receipts.js";

const curationContextSchema = z.object({
  deploymentId: z.uuid(),
  ownerId: z.uuid(),
  spaceId: z.uuid(),
  chainId: z.uuid(),
  turnSucceeded: z.boolean(),
});

const TEMPORARY_CONTENT =
  /\b(?:right now|for the next (?:few|\d+) (?:minutes?|hours?|days?)|just for today|today only|tonight only|temporary|one[- ]time code|until tomorrow)\b/iu;
const SECRET_CONTENT =
  /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|private[_ -]?key|password|passcode|verification code|seed phrase)\b/iu;

export type CurationFilterReason =
  | "low_confidence"
  | "secret_like"
  | "temporary"
  | "unsuccessful_turn";

export interface CurationContext {
  deploymentId: string;
  ownerId: string;
  spaceId: string;
  chainId: string;
  turnSucceeded: boolean;
}

export type CurationResultItem =
  | {
      contentHash: string;
      status: "written" | "updated" | "deduplicated";
      externalMemoryId?: string;
      filterReason?: never;
      failureCode?: never;
      retryable?: never;
    }
  | {
      contentHash: string;
      status: "filtered";
      filterReason: CurationFilterReason;
      externalMemoryId?: never;
      failureCode?: never;
      retryable?: never;
    }
  | {
      contentHash: string;
      status: "failed";
      failureCode: string;
      retryable: boolean;
      externalMemoryId?: never;
      filterReason?: never;
    };

export class MemoryProjectionError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(
    code: string,
    retryable: boolean,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MemoryProjectionError";
    this.code = code;
    this.retryable = retryable;
  }
}

function normalizeContent(content: string): string {
  return content.trim().replace(/\s+/gu, " ").normalize("NFKC");
}

export function memoryCandidateHash(
  candidate: MemoryCandidate,
  context: Pick<CurationContext, "spaceId">,
): string {
  const normalized = normalizeContent(candidate.content);
  const scopeId =
    candidate.scope === "owner"
      ? "owner"
      : candidate.scope === "space"
        ? context.spaceId
        : candidate.projectId;
  return createHash("sha256")
    .update(`${candidate.kind}\0${candidate.scope}\0${scopeId}\0${normalized}`, "utf8")
    .digest("hex");
}

export function curationFilterReason(
  candidate: MemoryCandidate,
  turnSucceeded = true,
): CurationFilterReason | undefined {
  if (!turnSucceeded) {
    return "unsuccessful_turn";
  }
  if (candidate.confidence < 0.8) {
    return "low_confidence";
  }
  if (SECRET_CONTENT.test(candidate.content)) {
    return "secret_like";
  }
  if (TEMPORARY_CONTENT.test(candidate.content)) {
    return "temporary";
  }
  return undefined;
}

function candidateMetadata(
  candidate: MemoryCandidate,
  context: CurationContext,
  contentHash: string,
): MemoryMetadata {
  const metadata: MemoryMetadata = {
    source: candidate.source,
    kind: candidate.kind,
    scope: candidate.scope,
    contentHash,
  };
  if (candidate.scope === "space") {
    metadata["spaceId"] = context.spaceId;
  }
  if (candidate.scope === "project" && candidate.projectId !== null) {
    metadata["projectId"] = candidate.projectId;
  }
  return metadata;
}

function isStaticMemory(candidate: MemoryCandidate): boolean {
  return (
    candidate.scope === "owner" &&
    (candidate.kind === "preference" ||
      candidate.kind === "relationship" ||
      candidate.kind === "correction")
  );
}

function safeFailureCode(error: unknown): string {
  if (error instanceof MemoryProviderError || error instanceof MemoryProjectionError) {
    return error.code;
  }
  if (error instanceof MemoryReceiptError) {
    return error.code;
  }
  return "MEMORY_PROJECTION_FAILED";
}

function isRetryableFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "retryable" in error &&
    error.retryable === true
  );
}

async function failedResult(input: {
  receipts: MemoryReceiptStore;
  pendingReceiptId?: string;
  contentHash: string;
  error: unknown;
}): Promise<CurationResultItem> {
  let error = input.error;
  if (input.pendingReceiptId !== undefined) {
    try {
      await input.receipts.markFailed(
        input.pendingReceiptId,
        safeFailureCode(error),
      );
    } catch (receiptError) {
      error = new MemoryReceiptError(
        "The memory operation failed and its redacted failure receipt could not be stored; repair PostgreSQL before retrying.",
        { cause: new AggregateError([error, receiptError]) },
      );
    }
  }
  return {
    contentHash: input.contentHash,
    status: "failed",
    failureCode: safeFailureCode(error),
    retryable: isRetryableFailure(error),
  };
}

async function findProviderDuplicate(
  provider: SupermemoryPort,
  containerTag: string,
  candidate: MemoryCandidate,
  contentHash: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const matches = await provider.searchMemories({
    containerTag,
    query: candidate.content,
    limit: 10,
    ...(signal === undefined ? {} : { signal }),
  });
  return matches.find((match) => match.metadata["contentHash"] === contentHash)?.id;
}

export async function curateMemories(input: {
  provider: SupermemoryPort;
  receipts: MemoryReceiptStore;
  context: CurationContext;
  candidates: readonly MemoryCandidate[];
  signal?: AbortSignal;
}): Promise<CurationResultItem[]> {
  const context = curationContextSchema.parse(input.context);
  const candidates = z.array(memoryCandidateSchema).max(20).parse(input.candidates);
  const containerTag = ownerContainerTag(context.deploymentId, context.ownerId);
  const localHashes = new Set<string>();
  const results: CurationResultItem[] = [];

  for (const candidate of candidates) {
    const contentHash = memoryCandidateHash(candidate, context);
    const filterReason = curationFilterReason(candidate, context.turnSucceeded);
    if (filterReason !== undefined) {
      results.push({ contentHash, status: "filtered", filterReason });
      continue;
    }
    if (localHashes.has(contentHash)) {
      results.push({ contentHash, status: "deduplicated" });
      continue;
    }
    localHashes.add(contentHash);

    let pendingReceiptId: string | undefined;
    try {
      const succeeded = await input.receipts.findSucceededByContentHash(
        context.ownerId,
        contentHash,
      );
      if (succeeded?.externalMemoryId !== undefined) {
        results.push({
          contentHash,
          status: "deduplicated",
          externalMemoryId: succeeded.externalMemoryId,
        });
        continue;
      }

      const providerDuplicate = await findProviderDuplicate(
        input.provider,
        containerTag,
        candidate,
        contentHash,
        input.signal,
      );
      const operation = candidate.replacesMemoryId === null ? "add" : "update";
      const pending = await input.receipts.createPending({
        ownerId: context.ownerId,
        spaceId: context.spaceId,
        chainId: context.chainId,
        operation,
        contentHash,
        safeSummary: `${candidate.kind}:${candidate.scope}`,
      });
      pendingReceiptId = pending.id;
      if (
        pending.status === "succeeded" &&
        pending.externalMemoryId !== undefined
      ) {
        results.push({
          contentHash,
          status: "deduplicated",
          externalMemoryId: pending.externalMemoryId,
        });
        continue;
      }

      let externalMemoryId = providerDuplicate;
      let resultStatus: "written" | "updated" | "deduplicated" =
        "deduplicated";
      if (externalMemoryId === undefined && candidate.replacesMemoryId !== null) {
        const updated = await input.provider.updateMemory({
          containerTag,
          memoryId: candidate.replacesMemoryId,
          content: normalizeContent(candidate.content),
          metadata: candidateMetadata(candidate, context, contentHash),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        externalMemoryId = updated.id;
        resultStatus = "updated";
      } else if (externalMemoryId === undefined) {
        const created = await input.provider.createMemories({
          containerTag,
          memories: [
            {
              content: normalizeContent(candidate.content),
              isStatic: isStaticMemory(candidate),
              metadata: candidateMetadata(candidate, context, contentHash),
            },
          ],
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        const memory = created[0];
        if (memory === undefined || created.length !== 1) {
          throw new MemoryProjectionError(
            "MEMORY_CREATE_RESULT_INVALID",
            false,
            "Supermemory did not return exactly one memory for a single candidate; verify provider compatibility.",
          );
        }
        externalMemoryId = memory.id;
        resultStatus = "written";
      }

      await input.receipts.markSucceeded(pendingReceiptId, externalMemoryId);
      results.push({
        contentHash,
        status: resultStatus,
        externalMemoryId,
      });
    } catch (error) {
      results.push(
        await failedResult({
          receipts: input.receipts,
          ...(pendingReceiptId === undefined ? {} : { pendingReceiptId }),
          contentHash,
          error,
        }),
      );
    }
  }

  return results;
}
