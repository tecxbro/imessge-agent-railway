import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const verifier = fileURLToPath(
  new URL("../../scripts/verify-push-target.mjs", import.meta.url),
);

function verify(url: string) {
  return spawnSync(process.execPath, [verifier, "candidate", url], {
    encoding: "utf8",
  });
}

describe("repository push-target guard", () => {
  it.each([
    "https://github.com/tecxbro/imessge-agent-railway.git",
    "git@github.com:tecxbro/imessge-agent-railway.git",
    "ssh://git@github.com/tecxbro/imessge-agent-railway.git",
  ])("accepts the canonical repository via %s", (url) => {
    const result = verify(url);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Push target verified");
  });

  it.each([
    "https://github.com/tecxbro/iMessage-boiler-plate-.git",
    "https://github.com/tecxbro/unrelated-agent-blueprint.git",
    "DISABLED",
  ])("rejects a noncanonical push URL via %s", (url) => {
    const result = verify(url);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("PUSH_TARGET_MISMATCH");
    expect(result.stderr).toContain("imessge-agent-railway.git");
  });

  it("does not echo credentials from a malformed remote URL", () => {
    const result = verify(
      "https://secret-token@github.com/tecxbro/iMessage-boiler-plate-.git",
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("PUSH_TARGET_MISMATCH");
    expect(result.stderr).not.toContain("secret-token");
  });
});
