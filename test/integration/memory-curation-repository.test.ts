import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { MemoryCandidate } from "../../src/agent/schemas.js";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";
import { runDatabaseMigrations } from "../../src/db/migrate.js";
import { MemoryCurationRepository } from "../../src/db/repositories/memory-curation.js";
import {
  chainMemoryCandidates,
  memoryCurationRuns,
} from "../../src/db/schema-fragments/memory-curation.js";
import {
  chains,
  channelIdentities,
  deployments,
  executionTasks,
  messages,
  owners,
  spaces,
} from "../../src/db/schema.js";
import { createDataCipher } from "../../src/security/data-cipher.js";

const databaseUrl = process.env["POSTGRES_PIPELINE_TEST_DATABASE_URL"];
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;
const deploymentId = "5c000000-0000-4000-8000-000000000001";
const ownerId = "5c000000-0000-4000-8000-000000000002";
const spaceId = "5c000000-0000-4000-8000-000000000003";
const taskId = "5c000000-0000-4000-8000-000000000004";
const directChainId = "5c000000-0000-4000-8000-000000000005";
const identityId = "5c000000-0000-4000-8000-000000000006";

function preference(
  content: string,
  source: MemoryCandidate["source"] = "authorized_user",
): MemoryCandidate {
  return {
    kind: "preference",
    scope: "owner",
    content,
    confidence: 0.99,
    source,
    projectId: null,
    replacesMemoryId: null,
  };
}

describeDatabase("memory curation PostgreSQL repository", () => {
  let client: DatabaseClient;
  let repository: MemoryCurationRepository;
  const cipher = createDataCipher("51".repeat(32));
  let version = 0;

  beforeAll(async () => {
    if (databaseUrl === undefined) {
      return;
    }
    client = createDatabaseClient({ connectionString: databaseUrl });
    await runDatabaseMigrations(client, resolve("src/db/migrations"));
    const exists = await client.pool.query<{ table_name: string | null }>(
      "select to_regclass('public.memory_curation_runs')::text as table_name",
    );
    if (exists.rows[0]?.table_name === null) {
      const migration = await readFile(
        resolve("src/db/migrations/0010_memory_curation_pipeline.sql"),
        "utf8",
      );
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim().length > 0) {
          await client.pool.query(statement);
        }
      }
    }
    repository = new MemoryCurationRepository(client.database, {
      encrypt: cipher.encrypt,
      decrypt: cipher.decrypt,
    });
  });

  beforeEach(async () => {
    version = 0;
    await client.pool.query(`
      truncate table
        memory_curation_runs,
        chain_memory_candidates,
        approvals,
        memory_sync_events,
        usage_events,
        failure_events,
        outbound_parts,
        outbound_batches,
        execution_tasks,
        agent_threads,
        carried_messages,
        messages,
        chains,
        space_members,
        spaces,
        channel_identities,
        owners,
        deployments
      restart identity cascade
    `);
    await client.database.insert(deployments).values({
      id: deploymentId,
      name: "memory-curation-integration",
      defaultModelProfile: "main",
      effectiveModelId: "gpt-5.6-luna",
      effectiveReasoningEffort: "high",
      modelSelectionState: "preferred",
    });
    await client.database.insert(owners).values({
      id: ownerId,
      deploymentId,
      timezone: "UTC",
    });
    await client.database.insert(channelIdentities).values({
      id: identityId,
      deploymentId,
      ownerId,
      normalizedHandleCiphertext: "encrypted-fixture-handle",
      handleFingerprint: "memory-curation-owner",
      role: "owner",
      verifiedAt: new Date("2026-08-18T00:00:00Z"),
    });
    await client.database.insert(spaces).values({
      id: spaceId,
      deploymentId,
      externalSpaceGuid: "memory-curation-space",
      type: "dm",
      lastMessageAt: new Date("2026-08-18T00:00:00Z"),
    });
  });

  afterAll(async () => {
    await client?.close();
  });

  async function createChain(input?: {
    id?: string;
    state?: "executing" | "sending" | "complete";
  }) {
    version += 1;
    const id =
      input?.id ??
      `5c000000-0000-4000-8000-${String(version).padStart(12, "0")}`;
    const state = input?.state ?? "executing";
    await client.database.insert(chains).values({
      id,
      spaceId,
      version,
      state,
      chainStartedAt: new Date(`2026-08-18T00:00:${String(version).padStart(2, "0")}Z`),
      ...(state === "complete"
        ? { completedAt: new Date("2026-08-18T00:10:00Z") }
        : {}),
    });
    await client.database.insert(messages).values({
      id: `5c200000-0000-4000-8000-${String(version).padStart(12, "0")}`,
      spaceId,
      externalMessageId: `memory-curation-message-${version}`,
      direction: "inbound",
      senderIdentityId: identityId,
      contentCiphertext: "encrypted-fixture-message",
      contentHash: `memory-curation-hash-${version}`,
      receivedAt: new Date(
        `2026-08-18T00:00:${String(version).padStart(2, "0")}Z`,
      ),
      drainedChainId: id,
      retentionExpiresAt: new Date("2026-09-18T00:00:00Z"),
    });
    return { chainId: id, expectedChainVersion: version };
  }

  it("persists direct, task, and synthesis candidates encrypted under one run", async () => {
    const chain = await createChain({ id: directChainId });
    await client.database.insert(executionTasks).values({
      id: taskId,
      chainId: chain.chainId,
      name: "research",
      purpose: "verify a durable preference",
      modelProfile: "main",
      permissionProfile: "read",
      state: "succeeded",
    });
    const direct = preference("The owner prefers compact direct answers.");
    const task = preference(
      "The owner prefers verified task citations.",
      "verified_task_result",
    );
    const synthesis = preference("The owner prefers a short synthesis footer.");

    await repository.recordCandidates({
      chainId: chain.chainId,
      ownerId,
      spaceId,
      sourceStage: "direct",
      sourceTaskId: null,
      candidates: [direct],
    });
    await repository.recordCandidates({
      chainId: chain.chainId,
      ownerId,
      spaceId,
      sourceStage: "task",
      sourceTaskId: taskId,
      candidates: [task],
    });
    await repository.recordCandidates({
      chainId: chain.chainId,
      ownerId,
      spaceId,
      sourceStage: "synthesis",
      sourceTaskId: null,
      candidates: [synthesis],
    });

    const rows = await client.database
      .select()
      .from(chainMemoryCandidates)
      .where(eq(chainMemoryCandidates.chainId, chain.chainId));
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.sourceStage))).toEqual(
      new Set(["direct", "task", "synthesis"]),
    );
    for (const row of rows) {
      expect(row.encryptedCandidate).toMatch(/^v1\./u);
      expect(row.encryptedCandidate).not.toContain("owner prefers");
      expect(() => JSON.parse(row.encryptedCandidate)).toThrow();
      expect(JSON.parse(cipher.decrypt(row.encryptedCandidate))).toMatchObject({
        content: expect.stringContaining("owner prefers"),
      });
    }
    const runs = await client.database
      .select()
      .from(memoryCurationRuns)
      .where(eq(memoryCurationRuns.chainId, chain.chainId));
    expect(runs).toHaveLength(1);

    await client.database
      .update(chains)
      .set({ state: "complete", completedAt: new Date() })
      .where(eq(chains.id, chain.chainId));
    const claim = await repository.claimRun(
      {
        ...chain,
        expectedState: "complete",
      },
      true,
    );
    expect(claim.status).toBe("claimed");
    if (claim.status === "claimed") {
      expect(claim.candidates).toHaveLength(3);
      expect(new Set(claim.candidates.map((row) => row.sourceStage))).toEqual(
        new Set(["direct", "task", "synthesis"]),
      );
    }
  });

  it("finds every required reconciliation category and gates deferred runs", async () => {
    const missing = await createChain({ state: "complete" });
    const pending = await createChain();
    await repository.recordCandidates({
      chainId: pending.chainId,
      ownerId,
      spaceId,
      sourceStage: "direct",
      sourceTaskId: null,
      candidates: [],
    });
    const retryable = await createChain();
    await repository.recordCandidates({
      chainId: retryable.chainId,
      ownerId,
      spaceId,
      sourceStage: "direct",
      sourceTaskId: null,
      candidates: [],
    });
    const deferred = await createChain();
    await repository.recordCandidates({
      chainId: deferred.chainId,
      ownerId,
      spaceId,
      sourceStage: "synthesis",
      sourceTaskId: null,
      candidates: [],
    });
    await client.database
      .update(chains)
      .set({ state: "complete", completedAt: new Date() });

    expect(
      await repository.claimRun(
        { ...retryable, expectedState: "complete" },
        true,
      ),
    ).toMatchObject({ status: "claimed" });
    await repository.markFailed({
      chainId: retryable.chainId,
      failureCode: "MEMORY_PROVIDER_TIMEOUT",
      retryable: true,
    });
    expect(
      await repository.claimRun(
        { ...deferred, expectedState: "complete" },
        false,
      ),
    ).toMatchObject({ status: "deferred" });

    const disabled = await repository.findReconciliationWork({
      providerEnabled: false,
    });
    expect(disabled.completedWithoutRuns).toContainEqual({
      ...missing,
      expectedState: "complete",
    });
    expect(disabled.pendingRuns).toContainEqual({
      ...pending,
      expectedState: "complete",
    });
    expect(disabled.retryableFailedRuns).toContainEqual({
      ...retryable,
      expectedState: "complete",
    });
    expect(disabled.deferredRuns).toEqual([]);

    const enabled = await repository.findReconciliationWork({
      providerEnabled: true,
    });
    expect(enabled.deferredRuns).toContainEqual({
      ...deferred,
      expectedState: "complete",
    });
  });

  it("terminally rejects failed and superseded chains before curation", async () => {
    const failed = await createChain();
    const superseded = await createChain();
    for (const chain of [failed, superseded]) {
      await repository.recordCandidates({
        chainId: chain.chainId,
        ownerId,
        spaceId,
        sourceStage: "direct",
        sourceTaskId: null,
        candidates: [preference(`Durable candidate for ${chain.chainId}.`)],
      });
    }
    await client.database
      .update(chains)
      .set({ state: "failed", completedAt: new Date() })
      .where(eq(chains.id, failed.chainId));
    await client.database
      .update(chains)
      .set({
        state: "canceled",
        canceledAt: new Date(),
        completedAt: new Date(),
      })
      .where(eq(chains.id, superseded.chainId));

    await expect(
      repository.claimRun(
        { ...failed, expectedState: "complete" },
        true,
      ),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "MEMORY_CHAIN_FAILED",
    });
    await expect(
      repository.claimRun(
        { ...superseded, expectedState: "complete" },
        true,
      ),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "MEMORY_CHAIN_SUPERSEDED",
    });
  });
});
