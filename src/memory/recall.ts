import { z } from "zod";

import type { MemoryReceiptStore } from "./receipts.js";
import {
  MemoryProviderError,
  type MemorySearchHit,
  type SupermemoryPort,
  ownerContainerTag,
} from "./supermemory-client.js";

const recallInputSchema = z.object({
  deploymentId: z.uuid(),
  ownerId: z.uuid(),
  spaceId: z.uuid(),
  query: z.string().trim().min(1).max(8_000),
  projectIds: z.array(z.uuid()).max(10).default([]),
  maxProfileItems: z.number().int().min(0).max(10).default(4),
  maxMemories: z.number().int().min(1).max(20).default(8),
  maxCharacters: z.number().int().min(256).max(16_000).default(4_000),
});

export interface RecalledText {
  text: string;
  trust: "untrusted_context";
}

export interface RecalledMemory extends RecalledText {
  externalMemoryId: string;
  scope: "owner" | "space" | "project";
  similarity: number;
}

export interface MemoryRecallResult {
  available: boolean;
  degradedReason?:
    | "container_deleted"
    | "provider_auth"
    | "provider_invalid_response"
    | "provider_rate_limited"
    | "provider_timeout"
    | "provider_unavailable"
    | "receipt_store_unavailable";
  containerTag: string;
  ownerProfile: RecalledText[];
  relevantMemories: RecalledMemory[];
  totalCharacters: number;
}

function degradeReason(error: unknown): MemoryRecallResult["degradedReason"] {
  if (!(error instanceof MemoryProviderError)) {
    return "provider_unavailable";
  }
  switch (error.code) {
    case "MEMORY_PROVIDER_AUTH_FAILED":
      return "provider_auth";
    case "MEMORY_PROVIDER_INVALID_RESPONSE":
    case "MEMORY_PROVIDER_REJECTED":
      return "provider_invalid_response";
    case "MEMORY_PROVIDER_RATE_LIMITED":
      return "provider_rate_limited";
    case "MEMORY_PROVIDER_TIMEOUT":
      return "provider_timeout";
    case "MEMORY_PROVIDER_ABORTED":
    case "MEMORY_PROVIDER_UNAVAILABLE":
      return "provider_unavailable";
  }
}

function memoryScope(
  memory: MemorySearchHit,
  spaceId: string,
  projectIds: ReadonlySet<string>,
): RecalledMemory["scope"] | undefined {
  const scope = memory.metadata["scope"];
  if (scope === "owner") {
    return "owner";
  }
  if (scope === "space" && memory.metadata["spaceId"] === spaceId) {
    return "space";
  }
  if (
    scope === "project" &&
    typeof memory.metadata["projectId"] === "string" &&
    projectIds.has(memory.metadata["projectId"])
  ) {
    return "project";
  }
  return undefined;
}

function appendWithinBudget(
  target: RecalledText[],
  text: string,
  budget: { remaining: number; used: number },
): boolean {
  const normalized = text.trim().replace(/\s+/gu, " ");
  if (normalized.length === 0 || budget.remaining === 0) {
    return false;
  }
  const bounded =
    normalized.length <= budget.remaining
      ? normalized
      : budget.remaining > 1
        ? `${normalized.slice(0, budget.remaining - 1)}…`
        : normalized.slice(0, budget.remaining);
  target.push({ text: bounded, trust: "untrusted_context" });
  budget.remaining -= bounded.length;
  budget.used += bounded.length;
  return true;
}

export async function recallMemoryContext(input: {
  provider: SupermemoryPort;
  receipts: MemoryReceiptStore;
  deploymentId: string;
  ownerId: string;
  spaceId: string;
  query: string;
  projectIds?: readonly string[];
  maxProfileItems?: number;
  maxMemories?: number;
  maxCharacters?: number;
  signal?: AbortSignal;
}): Promise<MemoryRecallResult> {
  // Recall is owner-scoped, deletion-aware, bounded, and explicitly untrusted;
  // provider or receipt outages degrade context instead of operational state.
  const parsed = recallInputSchema.parse({
    deploymentId: input.deploymentId,
    ownerId: input.ownerId,
    spaceId: input.spaceId,
    query: input.query,
    projectIds: input.projectIds,
    maxProfileItems: input.maxProfileItems,
    maxMemories: input.maxMemories,
    maxCharacters: input.maxCharacters,
  });
  const containerTag = ownerContainerTag(parsed.deploymentId, parsed.ownerId);
  const empty = (
    degradedReason: MemoryRecallResult["degradedReason"],
  ): MemoryRecallResult => ({
    available: false,
    ...(degradedReason === undefined ? {} : { degradedReason }),
    containerTag,
    ownerProfile: [],
    relevantMemories: [],
    totalCharacters: 0,
  });

  let suppressOwnerProfile: boolean;
  try {
    if (await input.receipts.isContainerDeleted(parsed.ownerId, containerTag)) {
      return empty("container_deleted");
    }
    suppressOwnerProfile = await input.receipts.hasSucceededDeletion(parsed.ownerId);
  } catch {
    return empty("receipt_store_unavailable");
  }

  let profile: Awaited<ReturnType<SupermemoryPort["getOwnerProfile"]>>;
  let matches: MemorySearchHit[];
  try {
    [profile, matches] = await Promise.all([
      suppressOwnerProfile
        ? Promise.resolve({ static: [], dynamic: [] })
        : input.provider.getOwnerProfile(
            containerTag,
            ...(input.signal === undefined ? [] : [input.signal]),
          ),
      input.provider.searchMemories({
        containerTag,
        query: parsed.query,
        limit: Math.min(100, parsed.maxMemories * 3),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }),
    ]);
  } catch (error) {
    if (input.signal?.aborted === true) {
      throw error;
    }
    return empty(degradeReason(error));
  }

  let deletedIds: ReadonlySet<string>;
  try {
    deletedIds = await input.receipts.findDeletedMemoryIds(
      parsed.ownerId,
      matches.map((memory) => memory.id),
    );
  } catch {
    return empty("receipt_store_unavailable");
  }

  const budget = { remaining: parsed.maxCharacters, used: 0 };
  const ownerProfile: RecalledText[] = [];
  for (const text of [...profile.static, ...profile.dynamic]) {
    if (ownerProfile.length >= parsed.maxProfileItems) {
      break;
    }
    if (!appendWithinBudget(ownerProfile, text, budget)) {
      break;
    }
  }

  const projectIds = new Set(parsed.projectIds);
  const relevantMemories: RecalledMemory[] = [];
  for (const memory of matches) {
    if (
      relevantMemories.length >= parsed.maxMemories ||
      budget.remaining === 0 ||
      deletedIds.has(memory.id)
    ) {
      continue;
    }
    const scope = memoryScope(memory, parsed.spaceId, projectIds);
    if (scope === undefined) {
      continue;
    }
    const bounded: RecalledText[] = [];
    if (!appendWithinBudget(bounded, memory.text, budget)) {
      continue;
    }
    const item = bounded[0];
    if (item !== undefined) {
      relevantMemories.push({
        ...item,
        externalMemoryId: memory.id,
        scope,
        similarity: memory.similarity,
      });
    }
  }

  return {
    available: true,
    containerTag,
    ownerProfile,
    relevantMemories,
    totalCharacters: budget.used,
  };
}
