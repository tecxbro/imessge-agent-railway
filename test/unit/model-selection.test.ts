import { describe, expect, it } from "vitest";

import type { CodexModelOption } from "../../src/agent/codex-account-capabilities.js";
import {
  DEFAULT_MODEL_SELECTION,
  resolveEffectiveModelSelection,
} from "../../src/agent/model-selection.js";

function model(
  input: Partial<CodexModelOption> & Pick<CodexModelOption, "id">,
): CodexModelOption {
  return {
    id: input.id,
    model: input.model ?? input.id,
    displayName: input.displayName ?? input.id,
    supportedReasoningEfforts:
      input.supportedReasoningEfforts ?? [
        { reasoningEffort: "medium", description: "Medium" },
        { reasoningEffort: "high", description: "High" },
      ],
    defaultReasoningEffort: input.defaultReasoningEffort ?? "medium",
    isDefault: input.isDefault ?? false,
  };
}

describe("account-aware model selection", () => {
  it("keeps Luna High as the stored default and uses it when advertised", () => {
    expect(DEFAULT_MODEL_SELECTION).toEqual({
      modelId: "gpt-5.6-luna",
      reasoningEffort: "high",
    });
    expect(
      resolveEffectiveModelSelection(DEFAULT_MODEL_SELECTION, [
        model({ id: "gpt-5.6-luna", isDefault: true }),
      ]),
    ).toEqual({ ...DEFAULT_MODEL_SELECTION, source: "preferred" });
  });

  it("falls back to the provider default effort when Luna lacks High", () => {
    expect(
      resolveEffectiveModelSelection(DEFAULT_MODEL_SELECTION, [
        model({
          id: "gpt-5.6-luna",
          isDefault: true,
          supportedReasoningEfforts: [
            { reasoningEffort: "medium", description: "Medium" },
          ],
          defaultReasoningEffort: "medium",
        }),
      ]),
    ).toEqual({
      modelId: "gpt-5.6-luna",
      reasoningEffort: "medium",
      source: "fallback",
    });
  });

  it("falls back to the advertised default model when Luna is absent", () => {
    expect(
      resolveEffectiveModelSelection(DEFAULT_MODEL_SELECTION, [
        model({ id: "gpt-5.6-terra", isDefault: true }),
      ]),
    ).toEqual({
      modelId: "gpt-5.6-terra",
      reasoningEffort: "medium",
      source: "fallback",
    });
  });

  it("uses the first visible model when no model is marked default", () => {
    expect(
      resolveEffectiveModelSelection(DEFAULT_MODEL_SELECTION, [
        model({ id: "gpt-5.6-sol" }),
        model({ id: "gpt-5.6-terra" }),
      ]),
    ).toMatchObject({ modelId: "gpt-5.6-sol", source: "fallback" });
  });

  it("is unavailable when Codex advertises no visible models", () => {
    expect(resolveEffectiveModelSelection(DEFAULT_MODEL_SELECTION, [])).toBeNull();
  });
});
