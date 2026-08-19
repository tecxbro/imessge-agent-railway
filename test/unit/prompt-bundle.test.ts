import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PROMPT_CONTRACT_VERSION,
  PROMPT_FILES,
  loadPromptBundle,
} from "../../src/config/prompt-bundle.js";

describe("prompt bundle", () => {
  it("loads every versioned prompt and produces a stable bundle hash", async () => {
    const first = await loadPromptBundle();
    const second = await loadPromptBundle();

    expect(first.contractVersion).toBe(PROMPT_CONTRACT_VERSION);
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first).toEqual(second);
    expect(Object.keys(first.prompts).sort()).toEqual([...PROMPT_FILES].sort());
    for (const prompt of Object.values(first.prompts)) {
      expect(prompt.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(prompt.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("changes the bundle version when prompt content changes", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "contracts-prompts-"));
    const temporaryPrompts = join(temporaryRoot, "prompts");
    await cp(resolve("prompts"), temporaryPrompts, { recursive: true });

    const before = await loadPromptBundle(temporaryPrompts);
    const target = join(temporaryPrompts, "voice-policy.md");
    const content = await readFile(target, "utf8");
    await writeFile(target, `${content}\n`, "utf8");
    const after = await loadPromptBundle(temporaryPrompts);

    expect(after.version).not.toBe(before.version);
  });

  it("keeps the iMessage voice direct, short, lowercase, and multi-message", async () => {
    const bundle = await loadPromptBundle();
    const voice = bundle.prompts["voice-policy.md"]?.content ?? "";
    const interaction = bundle.prompts["interaction.system.md"]?.content ?? "";

    expect(voice).toContain("Talk like a smart friend inside iMessage.");
    expect(voice).toContain("Aim for 120 characters in each intended message");
    expect(voice).toContain("try not to exceed 150");
    expect(voice).toContain(
      "Each blank-line-separated block is one intended iMessage bubble.",
    );
    expect(voice).toContain(
      "rewrite or divide the answer at complete-thought boundaries",
    );
    expect(voice).toContain(
      "Never split a word, sentence, URL, path, command, code fragment, or coherent thought merely to meet the target.",
    );
    expect(voice).toContain("Ask only one short question per turn.");
    expect(voice).toContain("Use natural lowercase.");
    expect(voice).toContain(
      "Never use em dashes. Rewrite with commas, periods, colons, or parentheses.",
    );
    expect(voice).toContain(
      "Sound like the user’s friend, not a personal assistant.",
    );
    expect(voice).toContain("Never use customer-support language.");
    expect(voice).toContain(
      "When something does not work, describe the situation with friendly honesty instead of a formal self-focused failure admission.",
    );
    expect(voice).toContain(
      "looks like the link is not in mood of opening",
    );
    expect(voice).not.toContain("—");
    expect(voice).toContain("Separate intended messages with a blank line.");
    expect(interaction).toContain(
      "Follow `voice-policy.md` for all user-facing text in both `userMessage` and `statusMessage`.",
    );
    expect(interaction).toContain(
      "Compose longer answers as natural, complete-thought messages",
    );
    expect(interaction).toContain(
      "Never mechanically slice text at the character target.",
    );
  });
});
