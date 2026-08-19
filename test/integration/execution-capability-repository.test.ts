import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";
import { runDatabaseMigrations } from "../../src/db/migrate.js";
import { PostgresExecutionCapabilityRepository } from "../../src/db/repositories/execution-capabilities.js";
import { executionCapabilityBindings } from "../../src/db/schema-fragments/execution-capabilities.js";
import { deployments, owners } from "../../src/db/schema.js";

const databaseUrl = process.env["POSTGRES_PIPELINE_TEST_DATABASE_URL"];
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

const deploymentId = "50000000-0000-4000-8000-000000000001";
const ownerId = "50000000-0000-4000-8000-000000000002";
const otherOwnerId = "50000000-0000-4000-8000-000000000003";

async function applyAssignedMigration(client: DatabaseClient): Promise<boolean> {
  const result = await client.pool.query<{ exists: boolean }>(
    "select to_regclass('public.execution_capability_bindings') is not null as exists",
  );
  if (result.rows[0]?.exists === true) {
    return false;
  }
  const source = await readFile(
    resolve("src/db/migrations/0008_execution_capability_bindings.sql"),
    "utf8",
  );
  for (const statement of source
    .split("--> statement-breakpoint")
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length > 0)) {
    await client.pool.query(statement);
  }
  return true;
}

describeDatabase("PostgreSQL execution capability repository", () => {
  let client: DatabaseClient;
  let repository: PostgresExecutionCapabilityRepository;
  let migrationAppliedByTest = false;

  beforeAll(async () => {
    if (databaseUrl === undefined) {
      return;
    }
    client = createDatabaseClient({ connectionString: databaseUrl });
    await runDatabaseMigrations(client, resolve("src/db/migrations"));
    migrationAppliedByTest = await applyAssignedMigration(client);
    repository = new PostgresExecutionCapabilityRepository(client.database);
  });

  beforeEach(async () => {
    await client.pool.query(`
      truncate table execution_capability_bindings, owners, deployments
      restart identity cascade
    `);
    await client.database.insert(deployments).values({
      id: deploymentId,
      name: "execution-capability-integration",
      defaultModelProfile: "main",
    });
    await client.database.insert(owners).values([
      { id: ownerId, deploymentId, timezone: "UTC" },
      {
        id: otherOwnerId,
        deploymentId,
        timezone: "UTC",
        status: "disabled",
      },
    ]);
  });

  afterAll(async () => {
    if (migrationAppliedByTest) {
      await client.pool.query(
        "drop table if exists execution_capability_bindings",
      );
    }
    await client?.close();
  });

  it("returns revisioned enabled and disabled bindings for an active deployment owner", async () => {
    await client.database.insert(executionCapabilityBindings).values([
      {
        deploymentId,
        workspaceBinding: "disabled",
        relativeWorkspacePath: "disabled",
        allowedPermissionProfiles: ["read"],
        enabled: false,
        revision: 1,
      },
      {
        deploymentId,
        workspaceBinding: "personal",
        relativeWorkspacePath: ".",
        allowedPermissionProfiles: [
          "read",
          "workspace-write",
          "network-read",
          "approval-required",
        ],
        enabled: true,
        revision: 3,
      },
    ]);

    await expect(
      repository.listForActor(deploymentId, ownerId),
    ).resolves.toMatchObject([
      {
        deploymentId,
        workspaceBinding: "disabled",
        enabled: false,
        revision: 1,
      },
      {
        deploymentId,
        workspaceBinding: "personal",
        relativeWorkspacePath: ".",
        allowedPermissionProfiles: [
          "read",
          "workspace-write",
          "network-read",
          "approval-required",
        ],
        enabled: true,
        revision: 3,
      },
    ]);
  });

  it("returns no bindings for an owner outside the active actor scope", async () => {
    await client.database.insert(executionCapabilityBindings).values({
      deploymentId,
      workspaceBinding: "personal",
      relativeWorkspacePath: ".",
      allowedPermissionProfiles: ["read"],
      enabled: true,
    });

    await expect(
      repository.listForActor(deploymentId, otherOwnerId),
    ).resolves.toEqual([]);
    await expect(
      repository.listForActor(
        deploymentId,
        "50000000-0000-4000-8000-000000000099",
      ),
    ).resolves.toEqual([]);
  });
});
