import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createCodexOutputJsonSchema } from "../../src/agent/codex-client.js";
import {
  codexExecutionResultSchema,
  executionResultSchema,
  executionTaskSchema,
  interactionDecisionSchema,
  memoryCandidateSchema,
  memoryCurationResultSchema,
} from "../../src/agent/schemas.js";

function readFixture(fileName: string): unknown {
  return JSON.parse(
    readFileSync(resolve("test/fixtures/model-output", fileName), "utf8"),
  ) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectStrictStructuredOutputObjects(
  value: unknown,
  path = "schema",
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      expectStrictStructuredOutputObjects(item, `${path}[${index}]`),
    );
    return;
  }
  if (!isRecord(value)) {
    return;
  }

  if (value["type"] === "object") {
    expect(value["additionalProperties"], `${path}.additionalProperties`).toBe(
      false,
    );
    const properties = value["properties"];
    expect(isRecord(properties), `${path}.properties`).toBe(true);
    if (isRecord(properties)) {
      const propertyNames = Object.keys(properties).sort();
      const required = value["required"];
      expect(Array.isArray(required), `${path}.required`).toBe(true);
      expect(
        Array.isArray(required) ? [...required].sort() : required,
        `${path}.required`,
      ).toEqual(propertyNames);
    }
  }

  for (const [key, child] of Object.entries(value)) {
    expectStrictStructuredOutputObjects(child, `${path}.${key}`);
  }
}

describe("model output contracts", () => {
  it("requires workspaceBinding while accepting an explicit null binding", () => {
    const task = {
      id: "inspect-runtime",
      agentName: "runtime-debugger",
      purpose: "Inspect the runtime failure.",
      instructions: "Return the root cause with evidence.",
      workspaceBinding: null,
      permissionProfile: "read",
      dependsOn: [],
    };

    expect(executionTaskSchema.safeParse(task).success).toBe(true);
    expect(
      executionTaskSchema.safeParse({ ...task, modelProfile: "main" }).success,
    ).toBe(false);
    const { workspaceBinding: _workspaceBinding, ...withoutBinding } = task;
    expect(executionTaskSchema.safeParse(withoutBinding).success).toBe(false);
  });

  it("constructs every Codex output schema with strict recursive objects", () => {
    const schemas = [
      createCodexOutputJsonSchema(interactionDecisionSchema),
      createCodexOutputJsonSchema(codexExecutionResultSchema),
      createCodexOutputJsonSchema(memoryCurationResultSchema),
    ];

    schemas.forEach((schema, index) =>
      expectStrictStructuredOutputObjects(schema, `schema[${index}]`),
    );
  });

  it("accepts representative valid interaction and execution JSON fixtures", () => {
    const interaction = readFixture("interaction-valid.json");
    expect(
      interactionDecisionSchema.safeParse(interaction).success,
    ).toBe(true);
    expect(
      interactionDecisionSchema.safeParse({
        ...(interaction as Record<string, unknown>),
        modelProfile: "deep",
      }).success,
    ).toBe(false);
    expect(
      executionResultSchema.safeParse(readFixture("execution-valid.json"))
        .success,
    ).toBe(true);
  });

  it("rejects representative malformed fixtures deterministically", () => {
    const interaction = interactionDecisionSchema.safeParse(
      readFixture("interaction-invalid.json"),
    );
    const execution = executionResultSchema.safeParse(
      readFixture("execution-invalid.json"),
    );

    expect(interaction.success).toBe(false);
    expect(execution.success).toBe(false);
    if (!interaction.success) {
      expect(interaction.error.issues.map((issue) => issue.code)).toContain(
        "unrecognized_keys",
      );
    }
    if (!execution.success) {
      expect(execution.error.issues.map((issue) => issue.path.join("."))).toContain(
        "error",
      );
    }
  });

  it("rejects duplicate IDs, cycles, and graphs deeper than three tasks", () => {
    const base = {
      mode: "delegate",
      userMessage: null,
      statusMessage: null,
      waitForTasks: true,
      memoryCandidates: [],
    } as const;
    const task = (id: string, dependsOn: string[]) => ({
      id,
      agentName: `agent-${id}`,
      purpose: `Complete ${id}`,
      instructions: `Return evidence for ${id}.`,
      workspaceBinding: null,
      permissionProfile: "read",
      dependsOn,
    });

    expect(
      interactionDecisionSchema.safeParse({
        ...base,
        tasks: [task("a", []), task("a", [])],
      }).success,
    ).toBe(false);
    expect(
      interactionDecisionSchema.safeParse({
        ...base,
        tasks: [task("a", ["b"]), task("b", ["a"])],
      }).success,
    ).toBe(false);
    expect(
      interactionDecisionSchema.safeParse({
        ...base,
        tasks: [
          task("a", []),
          task("b", ["a"]),
          task("c", ["b"]),
          task("d", ["c"]),
        ],
      }).success,
    ).toBe(false);
  });

  it("requires explicit support for durable project-scoped memory", () => {
    const candidate = {
      kind: "project_fact",
      scope: "project",
      content: "Project Atlas uses PostgreSQL as its operational store.",
      confidence: 1,
      source: "verified_task_result",
      projectId: null,
      replacesMemoryId: null,
    };

    expect(memoryCandidateSchema.safeParse(candidate).success).toBe(false);
    expect(
      memoryCandidateSchema.safeParse({
        ...candidate,
        projectId: "00000000-0000-4000-8000-000000000010",
      }).success,
    ).toBe(true);
  });

  it("requires proposed actions to remain in needs_approval results", () => {
    const proposedAction = {
      actionType: "filesystem.destructive",
      target: "primary-repo/main",
      normalizedPayload: { command: "git reset" },
      humanSummary: "Reset the primary repository branch.",
    };
    const baseResult = {
      taskId: "task-a",
      userSafeSummary: "The next operation requires approval.",
      artifacts: [],
      proposedActions: [proposedAction],
      memoryCandidates: [],
      error: null,
    };

    expect(
      executionResultSchema.safeParse({
        ...baseResult,
        status: "succeeded",
      }).success,
    ).toBe(false);
    expect(
      executionResultSchema.safeParse({
        ...baseResult,
        status: "needs_approval",
      }).success,
    ).toBe(true);
  });
});
