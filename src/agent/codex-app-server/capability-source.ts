import { reasoningEffortSchema } from "../../config/model-profiles.js";
import type {
  CodexAccountCapabilitiesSnapshot,
  CodexModelOption,
} from "../codex-account-capabilities.js";
import {
  accountReadSchema,
  CodexAppServerProtocolError,
  modelListSchema,
  type WireCodexModelOption,
} from "./protocol.js";
import type { CodexAppServerConnection } from "./transport.js";

export type CodexAccountState = "unknown" | "connected" | "not_connected";

export interface CodexCapabilitySourceResult {
  accountState: CodexAccountState;
  snapshot: CodexAccountCapabilitiesSnapshot;
}

export function normalizeCodexModelOption(
  model: WireCodexModelOption,
): CodexModelOption | undefined {
  const supportedReasoningEfforts: Array<
    CodexModelOption["supportedReasoningEfforts"][number]
  > = [];
  const seenEfforts = new Set<string>();
  for (const effort of model.supportedReasoningEfforts) {
    const parsed = reasoningEffortSchema.safeParse(effort.reasoningEffort);
    if (!parsed.success || seenEfforts.has(parsed.data)) {
      continue;
    }
    seenEfforts.add(parsed.data);
    supportedReasoningEfforts.push({
      reasoningEffort: parsed.data,
      description: effort.description,
    });
  }

  const defaultReasoningEffort = reasoningEffortSchema.safeParse(
    model.defaultReasoningEffort,
  );
  if (
    !defaultReasoningEffort.success ||
    !seenEfforts.has(defaultReasoningEffort.data)
  ) {
    return undefined;
  }

  return {
    id: model.id,
    model: model.model,
    displayName: model.displayName,
    supportedReasoningEfforts,
    defaultReasoningEffort: defaultReasoningEffort.data,
    isDefault: model.isDefault,
  };
}

export async function loadCodexAccountCapabilities(
  connection: CodexAppServerConnection,
  now: () => Date = () => new Date(),
): Promise<CodexCapabilitySourceResult> {
  let account: ReturnType<typeof accountReadSchema.parse>;
  try {
    account = accountReadSchema.parse(
      await connection.request("account/read", { refreshToken: false }),
    );
  } catch {
    return {
      accountState: "unknown",
      snapshot: {
        state: "unavailable",
        planType: null,
        models: [],
        refreshedAt: null,
      },
    };
  }

  if (account.account?.type !== "chatgpt") {
    return {
      accountState: "not_connected",
      snapshot: {
        state: "unavailable",
        planType: null,
        models: [],
        refreshedAt: now(),
      },
    };
  }

  try {
    const models: WireCodexModelOption[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = modelListSchema.parse(
        await connection.request("model/list", {
          limit: 100,
          includeHidden: false,
          ...(cursor === null ? {} : { cursor }),
        }),
      );
      models.push(...page.data);
      cursor = page.nextCursor;
      if (cursor !== null) {
        if (seenCursors.has(cursor) || seenCursors.size >= 100) {
          throw new CodexAppServerProtocolError();
        }
        seenCursors.add(cursor);
      }
    } while (cursor !== null);

    const uniqueModels = new Map<string, CodexModelOption>();
    const seenModelIds = new Set<string>();
    for (const model of models) {
      if (seenModelIds.has(model.id)) {
        throw new CodexAppServerProtocolError();
      }
      seenModelIds.add(model.id);
      const normalized = normalizeCodexModelOption(model);
      if (normalized !== undefined) {
        uniqueModels.set(model.id, normalized);
      }
    }
    return {
      accountState: "connected",
      snapshot: {
        state: "available",
        planType: account.account.planType,
        models: [...uniqueModels.values()],
        refreshedAt: now(),
      },
    };
  } catch {
    return {
      accountState: "connected",
      snapshot: {
        state: "unavailable",
        planType: null,
        models: [],
        refreshedAt: null,
      },
    };
  }
}
