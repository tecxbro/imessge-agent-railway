import { describe, expect, it } from "vitest";

import {
  modelIdentifierSchema,
  modelProfileSchema,
  reasoningEffortSchema,
} from "../../src/config/model-profiles.js";

describe("Codex model pair primitives", () => {
  it("accepts bounded model identifiers and advertised reasoning efforts", () => {
    expect(modelIdentifierSchema.parse("gpt-5.6-luna")).toBe("gpt-5.6-luna");
    expect(reasoningEffortSchema.parse("high")).toBe("high");
    expect(
      modelProfileSchema.parse({ model: "gpt-5.6-luna", effort: "high" }),
    ).toEqual({ model: "gpt-5.6-luna", effort: "high" });
  });

  it("contains no static routing profile map", async () => {
    const exports = await import("../../src/config/model-profiles.js");
    expect(exports).not.toHaveProperty("MODEL_PROFILE_NAMES");
    expect(exports).not.toHaveProperty("DEFAULT_MODEL_PROFILES");
    expect(exports).not.toHaveProperty("modelProfilesSchema");
  });
});
