import { z } from "zod";

import type { CodexModelOption } from "./codex-account-capabilities.js";
import {
  modelIdentifierSchema,
  reasoningEffortSchema,
  type ReasoningEffort,
} from "../config/model-profiles.js";

export const DEFAULT_MODEL_SELECTION = {
  modelId: "gpt-5.6-luna",
  reasoningEffort: "high",
} as const;

export const modelSelectionSchema = z
  .object({
    modelId: modelIdentifierSchema,
    reasoningEffort: reasoningEffortSchema,
  })
  .strict();

export const effectiveModelSelectionSchema = modelSelectionSchema.extend({
  source: z.enum(["preferred", "fallback"]),
});

export const modelSelectionStateSchema = z.enum([
  "preferred",
  "fallback",
  "unavailable",
  "pending",
]);

export type ModelSelection = z.infer<typeof modelSelectionSchema>;
export type EffectiveModelSelection = z.infer<
  typeof effectiveModelSelectionSchema
>;
export type ModelSelectionState = z.infer<typeof modelSelectionStateSchema>;

export interface DeploymentModelSettings {
  planType: string | null;
  preferred: ModelSelection;
  effective: ModelSelection | null;
  selectionState: ModelSelectionState;
  modelCatalogRefreshedAt: Date | null;
}

export function modelSupportsSelection(
  model: CodexModelOption,
  selection: ModelSelection,
): boolean {
  return (
    model.id === selection.modelId &&
    model.supportedReasoningEfforts.some(
      (effort) => effort.reasoningEffort === selection.reasoningEffort,
    )
  );
}

export function resolveEffectiveModelSelection(
  preferred: ModelSelection,
  models: readonly CodexModelOption[],
): EffectiveModelSelection | null {
  const preferredModel = models.find((model) => model.id === preferred.modelId);
  if (
    preferredModel !== undefined &&
    modelSupportsSelection(preferredModel, preferred)
  ) {
    return { ...preferred, source: "preferred" };
  }

  const fallback = models.find((model) => model.isDefault) ?? models[0];
  if (fallback === undefined) {
    return null;
  }
  return {
    modelId: fallback.id,
    reasoningEffort: fallback.defaultReasoningEffort,
    source: "fallback",
  };
}

export function asCodexModelProfile(selection: ModelSelection): {
  model: string;
  effort: ReasoningEffort;
} {
  return {
    model: selection.modelId,
    effort: selection.reasoningEffort,
  };
}
