import type { ReasoningEffort } from "../config/model-profiles.js";

export interface CodexModelOption {
  id: string;
  model: string;
  displayName: string;
  supportedReasoningEfforts: readonly {
    reasoningEffort: ReasoningEffort;
    description: string;
  }[];
  defaultReasoningEffort: ReasoningEffort;
  isDefault: boolean;
}

export interface CodexAccountCapabilitiesSnapshot {
  state: "available" | "unavailable" | "refreshing";
  planType: string | null;
  models: readonly CodexModelOption[];
  refreshedAt: Date | null;
}

export type CapabilitiesListener = (
  snapshot: CodexAccountCapabilitiesSnapshot,
) => void | Promise<void>;

export function cloneCapabilitiesSnapshot(
  snapshot: CodexAccountCapabilitiesSnapshot,
): CodexAccountCapabilitiesSnapshot {
  return {
    state: snapshot.state,
    planType: snapshot.planType,
    models: snapshot.models.map((model) => ({
      ...model,
      supportedReasoningEfforts: model.supportedReasoningEfforts.map(
        (effort) => ({ ...effort }),
      ),
    })),
    refreshedAt:
      snapshot.refreshedAt === null
        ? null
        : new Date(snapshot.refreshedAt.getTime()),
  };
}
