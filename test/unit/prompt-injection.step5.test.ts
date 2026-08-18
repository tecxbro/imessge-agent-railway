import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { executionTaskSchema } from "../../src/agent/schemas.js";
import { assertExecutionTasksAuthorized } from "../../src/queue/handlers/turn-plan.js";

interface InjectionFixture {
  id: string;
  source: "user" | "memory" | "repository" | "web";
  rejectionLayer: "schema" | "policy";
  untrustedText: string;
  maliciousTask: unknown;
}

function loadFixtures(): InjectionFixture[] {
  return JSON.parse(
    readFileSync(
      resolve("test/fixtures/step5/prompt-injection.json"),
      "utf8",
    ),
  ) as InjectionFixture[];
}

describe("Step 5 prompt-injection fixtures", () => {
  it("covers every required untrusted orchestration source", () => {
    expect(new Set(loadFixtures().map((fixture) => fixture.source))).toEqual(
      new Set(["memory", "repository", "user", "web"]),
    );
  });

  it.each(loadFixtures().filter((fixture) => fixture.rejectionLayer === "schema"))(
    "schema-rejects an unknown authority or permission from $id",
    (fixture) => {
      expect(fixture.untrustedText.length).toBeGreaterThan(20);
      expect(executionTaskSchema.safeParse(fixture.maliciousTask).success).toBe(
        false,
      );
    },
  );

  it.each(loadFixtures().filter((fixture) => fixture.rejectionLayer === "policy"))(
    "policy-rejects schema-valid permission broadening from $id",
    (fixture) => {
      const task = executionTaskSchema.parse(fixture.maliciousTask);

      expect(() =>
        assertExecutionTasksAuthorized([task], [
          {
            workspaceBinding: "primary-repo",
            permissionProfiles: ["read"],
          },
        ]),
      ).toThrow(/permission profile.*does not allow/i);
    },
  );

  it("rejects a disallowed workspace and keeps model selection out of task output", () => {
    const base = executionTaskSchema.parse({
      id: "inspect",
      agentName: "runtime-debugger",
      purpose: "Inspect bounded evidence.",
      instructions: "Return a read-only finding.",
      workspaceBinding: "primary-repo",
      permissionProfile: "read",
      dependsOn: [],
    });
    const capabilities = [
      {
        workspaceBinding: "primary-repo",
        permissionProfiles: ["read" as const],
      },
    ];

    expect(() =>
      assertExecutionTasksAuthorized(
        [{ ...base, workspaceBinding: "sibling-repo" }],
        capabilities,
      ),
    ).toThrow(/unavailable workspace binding/i);
    expect(
      executionTaskSchema.safeParse({ ...base, modelProfile: "deep" }).success,
    ).toBe(false);
    expect(() => assertExecutionTasksAuthorized([base], capabilities)).not.toThrow();
  });

  it("keeps original prompts explicit about untrusted context and code-enforced approval", () => {
    const interaction = readFileSync(
      resolve("prompts/interaction.system.md"),
      "utf8",
    );
    const execution = readFileSync(
      resolve("prompts/execution.system.md"),
      "utf8",
    );
    const approval = readFileSync(
      resolve("prompts/approval-policy.md"),
      "utf8",
    );
    const combined = `${interaction}\n${execution}\n${approval}`;

    for (const boundary of [
      "User text",
      "recalled memory",
      "repository content",
      "web content",
      "execution results",
    ]) {
      expect(combined.toLowerCase()).toContain(boundary.toLowerCase());
    }
    expect(combined).toMatch(/application[^.]*enforces permissions/i);
    expect(combined).toMatch(/application[^.]*decides whether a valid approval exists/i);
    expect(combined).toMatch(/do not communicate directly with the user/i);
  });
});
