import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cloneCapabilitiesSnapshot,
  type CapabilitiesListener,
  type CodexAccountCapabilitiesSnapshot,
  type CodexModelOption,
} from "../../src/agent/codex-account-capabilities.js";
import type { ModelCapabilitySource } from "../../src/agent/model-capability-source.js";
import {
  ModelSettingsService,
  type ModelSettingsStore,
  type PersistModelSettingsReconciliationInput,
} from "../../src/agent/model-settings-service.js";
import type { DeploymentModelSettings } from "../../src/agent/model-selection.js";
import type { CapabilityPairRunner } from "../../src/config/capabilities.js";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";
import { runDatabaseMigrations } from "../../src/db/migrate.js";
import { ModelSettingsRepository } from "../../src/db/repositories/model-settings.js";
import { modelSettingsReconciliation } from "../../src/db/schema-fragments/model-settings-reconciliation.js";
import { deployments } from "../../src/db/schema.js";

const databaseUrl = process.env["POSTGRES_PIPELINE_TEST_DATABASE_URL"];
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

const deploymentId = "60000000-0000-4000-8000-000000000006";
const luna: CodexModelOption = {
  id: "gpt-5.6-luna",
  model: "gpt-5.6-luna",
  displayName: "GPT-5.6 Luna",
  supportedReasoningEfforts: [
    { reasoningEffort: "high", description: "High" },
  ],
  defaultReasoningEffort: "high",
  isDefault: true,
};

class FakeSource implements ModelCapabilitySource {
  public readonly kind = "chatgpt" as const;
  readonly #listeners = new Set<CapabilitiesListener>();
  current: CodexAccountCapabilitiesSnapshot = {
    state: "unavailable",
    planType: null,
    models: [],
    refreshedAt: null,
  };
  finalSnapshot: CodexAccountCapabilitiesSnapshot;

  public constructor(refreshedAt: Date) {
    this.finalSnapshot = {
      state: "available",
      planType: "plus",
      models: [luna],
      refreshedAt,
    };
  }

  public snapshot(): CodexAccountCapabilitiesSnapshot {
    return cloneCapabilitiesSnapshot(this.current);
  }

  public subscribe(listener: CapabilitiesListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public async refresh(): Promise<CodexAccountCapabilitiesSnapshot> {
    await this.#emit({
      state: "refreshing",
      planType: null,
      models: [],
      refreshedAt: null,
    });
    await this.#emit(this.finalSnapshot);
    return cloneCapabilitiesSnapshot(this.finalSnapshot);
  }

  async #emit(snapshot: CodexAccountCapabilitiesSnapshot): Promise<void> {
    this.current = cloneCapabilitiesSnapshot(snapshot);
    for (const listener of this.#listeners) {
      await listener(cloneCapabilitiesSnapshot(snapshot));
    }
  }
}

class CountingStore implements ModelSettingsStore {
  persistCalls = 0;

  public constructor(private readonly repository: ModelSettingsRepository) {}

  public async read(): Promise<DeploymentModelSettings> {
    return await this.repository.read();
  }

  public async readReconciliation() {
    return await this.repository.readReconciliation();
  }

  public async persistReconciliation(
    input: PersistModelSettingsReconciliationInput,
  ): Promise<DeploymentModelSettings> {
    this.persistCalls += 1;
    return await this.repository.persistReconciliation(input);
  }
}

async function applyLeafMigration(client: DatabaseClient): Promise<void> {
  const table = await client.pool.query<{ name: string | null }>(
    "select to_regclass('public.model_settings_reconciliation')::text as name",
  );
  const existingTable = table.rows[0]?.name;
  if (existingTable !== null && existingTable !== undefined) {
    return;
  }
  const sql = await readFile(
    resolve(
      "src/db/migrations/0006_model_settings_reconciliation.sql",
    ),
    "utf8",
  );
  const statements = sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  const connection = await client.pool.connect();
  try {
    await connection.query("begin");
    for (const statement of statements) {
      await connection.query(statement);
    }
    await connection.query("commit");
  } catch (error) {
    await connection.query("rollback");
    throw error;
  } finally {
    connection.release();
  }
}

describeDatabase("model settings reconciliation persistence", () => {
  let client: DatabaseClient;

  beforeAll(async () => {
    if (databaseUrl === undefined) {
      return;
    }
    client = createDatabaseClient({ connectionString: databaseUrl });
    await runDatabaseMigrations(client, resolve("src/db/migrations"));
    await applyLeafMigration(client);
  });

  beforeEach(async () => {
    await client.pool.query(`
      truncate table model_settings_reconciliation, deployments
      restart identity cascade
    `);
    await client.database.insert(deployments).values({
      id: deploymentId,
      name: "model-settings-integration",
      defaultModelProfile: "main",
    });
  });

  afterAll(async () => {
    await client?.close();
  });

  it("survives restart and coalesces the same final catalog without another write or probe", async () => {
    const firstRepository = new ModelSettingsRepository(
      client.database,
      deploymentId,
    );
    const firstStore = new CountingStore(firstRepository);
    const firstProbe: CapabilityPairRunner = {
      probe: vi.fn(async () => ({ supported: true })),
    };
    const firstService = new ModelSettingsService({
      source: new FakeSource(new Date("2026-08-18T16:00:00Z")),
      store: firstStore,
      probe: firstProbe,
    });
    await firstService.start();
    await firstService.refresh();
    await firstService.close();

    expect(firstStore.persistCalls).toBe(1);
    expect(firstProbe.probe).toHaveBeenCalledOnce();
    const [persisted] = await client.database
      .select()
      .from(modelSettingsReconciliation)
      .where(eq(modelSettingsReconciliation.deploymentId, deploymentId));
    expect(persisted).toMatchObject({
      sourceKind: "chatgpt",
      sourceState: "available",
      effectiveModelId: "gpt-5.6-luna",
      effectiveReasoningEffort: "high",
      probeState: "supported",
      probedModelId: "gpt-5.6-luna",
      probedReasoningEffort: "high",
      lastErrorCode: null,
    });
    expect(persisted?.catalogHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(persisted?.probedCatalogHash).toBe(persisted?.catalogHash);

    const restartedRepository = new ModelSettingsRepository(
      client.database,
      deploymentId,
    );
    const restartedStore = new CountingStore(restartedRepository);
    const restartedProbe: CapabilityPairRunner = {
      probe: vi.fn(async () => ({ supported: true })),
    };
    const restartedService = new ModelSettingsService({
      source: new FakeSource(new Date("2026-08-18T17:00:00Z")),
      store: restartedStore,
      probe: restartedProbe,
    });
    await restartedService.start();
    await restartedService.refresh();

    expect(restartedStore.persistCalls).toBe(0);
    expect(restartedProbe.probe).not.toHaveBeenCalled();
    expect(restartedService.readiness()).toMatchObject({
      ready: true,
      effective: {
        modelId: "gpt-5.6-luna",
        reasoningEffort: "high",
      },
    });
    await expect(restartedService.readDashboard()).resolves.toMatchObject({
      preferred: {
        modelId: "gpt-5.6-luna",
        reasoningEffort: "high",
      },
      availableModels: [{ id: "gpt-5.6-luna" }],
    });
    await restartedService.close();
  });
});
