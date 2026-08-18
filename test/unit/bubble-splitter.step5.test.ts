import { describe, expect, it } from "vitest";

import { splitMessageBubbles } from "../../src/messaging/bubble-splitter.js";

function expectWellFormedUtf16(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      expect(value.charCodeAt(index + 1)).toBeGreaterThanOrEqual(0xdc00);
      expect(value.charCodeAt(index + 1)).toBeLessThanOrEqual(0xdfff);
      index += 1;
    } else {
      expect(code < 0xdc00 || code > 0xdfff).toBe(true);
    }
  }
}

describe("Step 5 iMessage bubble splitting", () => {
  it("treats 150 characters as model guidance rather than a transport limit", () => {
    const original =
      "Seedance did not generate the website. Seedance generated several pre-rendered films. The browser turns scrolling into a video-editing timeline, while the typography, buttons, navigation, grids, cards, and forms remain real frontend code.";
    const intended = [
      "Seedance didn’t generate the website. It generated several pre-rendered films.",
      "The browser turns scrolling into a video-editing timeline.",
      "The typography, buttons, navigation, grids, cards, and forms remain real frontend code.",
    ];

    expect(original.length).toBeGreaterThan(150);
    expect(splitMessageBubbles(original)).toEqual([original]);
    expect(splitMessageBubbles(intended.join("\n\n"))).toEqual(intended);
    expect(intended.every((bubble) => bubble.length <= 150)).toBe(true);
  });

  it("splits at paragraph boundaries without empty bubbles", () => {
    const input = [
      "The transport finding is confirmed.",
      "The retry path still needs a guard.",
      "The final paragraph reports the recovery impact.",
    ].join("\n\n");

    const bubbles = splitMessageBubbles(input, { maxCharacters: 70 });

    expect(bubbles).toEqual([
      "The transport finding is confirmed.",
      "The retry path still needs a guard.",
      "The final paragraph reports the recovery impact.",
    ]);
    expect(bubbles.every((bubble) => bubble.length > 0)).toBe(true);
    expect(bubbles.every((bubble) => bubble.length <= 70)).toBe(true);
  });

  it("keeps a fenced code block intact when the block fits one bubble", () => {
    const code = [
      "```ts",
      "const route = resolveRoute(spaceGuid);",
      "await sender.send(route);",
      "```",
    ].join("\n");
    const input = `The fix is small:\n\n${code}\n\nThen run the integration test.`;

    const bubbles = splitMessageBubbles(input, { maxCharacters: 110 });

    expect(bubbles.filter((bubble) => bubble.includes(code))).toHaveLength(1);
    expect(bubbles.join("\n\n")).toBe(input);
    expect(bubbles.every((bubble) => bubble.length <= 110)).toBe(true);
  });

  it("never breaks a URL token across bubbles", () => {
    const url =
      "https://example.com/releases/2026-08-14?artifact=restart-analysis&format=markdown";
    const input = `Read the evidence at ${url} before approving the release. The remaining explanation can move to another bubble.`;

    const bubbles = splitMessageBubbles(input, { maxCharacters: 105 });

    expect(bubbles.filter((bubble) => bubble.includes(url))).toHaveLength(1);
    expect(bubbles.some((bubble) => bubble.includes("https://example.com/releases/2026-") && !bubble.includes(url))).toBe(false);
    expect(bubbles.every((bubble) => bubble.length <= 105)).toBe(true);
  });

  it("splits only at Unicode grapheme boundaries", () => {
    const family = "👩🏽‍💻";
    const input = [
      family.repeat(3),
      family.repeat(3),
      family.repeat(3),
      family.repeat(3),
    ].join(" ");

    const bubbles = splitMessageBubbles(input, { maxCharacters: 24 });

    expect(bubbles.join(" ")).toBe(input);
    expect(bubbles.every((bubble) => bubble.length <= 24)).toBe(true);
    for (const bubble of bubbles) {
      expectWellFormedUtf16(bubble);
      expect(bubble.startsWith("\u200d")).toBe(false);
      expect(bubble.endsWith("\u200d")).toBe(false);
      expect(bubble.startsWith("🏽")).toBe(false);
    }
  });

  it("rejects an impossible size rather than returning oversized or empty output", () => {
    expect(() =>
      splitMessageBubbles("hello", { maxCharacters: 0 }),
    ).toThrow(/maxCharacters/i);
    expect(splitMessageBubbles("   \n\n ", { maxCharacters: 50 })).toEqual([]);
  });
});
