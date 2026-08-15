import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const forbiddenMarkers = [
  ["ren", "der.com"].join(""),
  ["REN", "DER_"].join(""),
  ["ren", "der.yaml"].join(""),
  ["ren", "der:validate"].join(""),
  ["Ren", "der Blueprint"].join(""),
  ["Ren", "der Shell"].join(""),
  ["iMessage-agent-", "ren", "der"].join(""),
  ["ren", "der-smoke"].join(""),
];

describe("retired provider cleanup", () => {
  it("keeps provider-specific markers out of tracked current-tree files", async () => {
    const trackedFiles = execFileSync("git", ["ls-files", "-z"], {
      encoding: "utf8",
    })
      .split("\0")
      .filter((path) => path.length > 0);
    const violations: string[] = [];

    for (const path of trackedFiles) {
      const content = await readFile(path);
      if (content.includes(0)) {
        continue;
      }

      const text = content.toString("utf8");
      for (const marker of forbiddenMarkers) {
        if (text.includes(marker)) {
          violations.push(`${path}: ${marker}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
