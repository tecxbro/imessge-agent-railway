import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const CONTRACT_MODULES = [
  "src/orchestration/contracts/turn-plan.ts",
  "src/orchestration/contracts/task-execution.ts",
  "src/orchestration/contracts/turn-synthesis.ts",
  "src/orchestration/contracts/capabilities.ts",
] as const;

async function source(path: string): Promise<string> {
  return readFile(resolve(process.cwd(), path), "utf8");
}

async function typescriptModules(directory: string): Promise<string[]> {
  const entries = await readdir(resolve(process.cwd(), directory), {
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => `${directory}/${entry.name}`)
    .sort();
}

describe("orchestration dependency direction", () => {
  it("keeps every database repository independent of queue handlers", async () => {
    for (const path of await typescriptModules("src/db/repositories")) {
      expect(await source(path)).not.toMatch(/from\s+["'][^"']*queue\/handlers\//u);
    }
  });

  it.each(CONTRACT_MODULES)(
    "%s remains independent of persistence and queue implementations",
    async (path) => {
      const contents = await source(path);

      expect(contents).not.toMatch(/from\s+["'][^"']*db\//u);
      expect(contents).not.toMatch(
        /from\s+["'][^"']*queue\/(?:handlers|boss|pipeline|publisher)(?:[/."'])/u,
      );
    },
  );

  it("keeps HTTP error types out of runtime modules", async () => {
    for (const path of await typescriptModules("src/runtime")) {
      expect(await source(path)).not.toContain("ModelSettingsApiError");
    }
  });

  it("routes production user work through the secure queued runner", async () => {
    const production = await source("src/runtime/production-bootstrap.ts");
    const interaction = await source("src/agent/interaction-runtime.ts");
    const execution = await source("src/agent/execution-runtime.ts");

    expect(production.match(/new ThreadStore\(/gu)).toHaveLength(1);
    expect(production).toMatch(
      /new ThreadStore\([\s\S]*?\(chainId\)\s*=>\s*new SecureStructuredCodexRunner\(/u,
    );
    expect(interaction).toContain("authorizationChainId: request.chainId");
    expect(execution).toContain("authorizationChainId: request.chainId");
  });
});
