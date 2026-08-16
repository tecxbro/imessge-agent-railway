import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

describe("documentation contract", () => {
  it("keeps guides aligned with files, commands, configuration, and runtime entrypoints", () => {
    const result = spawnSync("npm", ["run", "docs:check"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Documentation contract passed");
  });
});
