import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const databaseUrl = process.env["POSTGRES_PIPELINE_TEST_DATABASE_URL"];
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;
const execFileAsync = promisify(execFile);

describeDatabase("Railway pre-deploy migration", () => {
  it("runs npm run db:migrate with DATABASE_URL as its only application setting", async () => {
    expect(databaseUrl).toBeDefined();
    const projectRoot = resolve(".");
    const isolatedRoot = await mkdtemp(
      join(tmpdir(), "railway-migration-environment-"),
    );

    try {
      await Promise.all([
        copyFile(
          join(projectRoot, "package.json"),
          join(isolatedRoot, "package.json"),
        ),
        symlink(
          join(projectRoot, "node_modules"),
          join(isolatedRoot, "node_modules"),
          "dir",
        ),
        symlink(join(projectRoot, "src"), join(isolatedRoot, "src"), "dir"),
      ]);

      await expect(
        execFileAsync(
          process.platform === "win32" ? "npm.cmd" : "npm",
          ["run", "db:migrate"],
          {
            cwd: isolatedRoot,
            env: {
              DATABASE_URL: databaseUrl,
              PATH: process.env["PATH"] ?? "",
            },
          },
        ),
      ).resolves.toMatchObject({ stderr: "" });
    } finally {
      await rm(isolatedRoot, { force: true, recursive: true });
    }
  });
});
