import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";
import { runDatabaseMigrations } from "../../src/db/migrate.js";
import { ChainAuthorizationRepository } from "../../src/db/repositories/chain-authorization.js";
import { chainAuthorizationIdentities } from "../../src/db/schema-fragments/chain-authorization.js";
import {
  chains,
  channelIdentities,
  deployments,
  owners,
  spaces,
} from "../../src/db/schema.js";
import { DatabaseAuthorizationDirectory } from "../../src/security/authorize-sender.js";
import type { QueuedAuthorizationReference } from "../../src/security/queued-authorization.js";

const databaseUrl = process.env["POSTGRES_PIPELINE_TEST_DATABASE_URL"];
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

const deploymentId = "40000000-0000-4000-8000-000000000001";
const ownerId = "40000000-0000-4000-8000-000000000002";
const principalIdentityId = "40000000-0000-4000-8000-000000000003";
const contributorIdentityId = "40000000-0000-4000-8000-000000000004";
const otherIdentityId = "40000000-0000-4000-8000-000000000005";
const otherOwnerId = "40000000-0000-4000-8000-000000000006";
const spaceId = "40000000-0000-4000-8000-000000000007";
const chainId = "40000000-0000-4000-8000-000000000008";

const reference: QueuedAuthorizationReference = {
  deploymentId,
  ownerId,
  chainId,
  principalIdentityId,
  contributorIdentityIds: [contributorIdentityId],
};

async function applyAssignedMigration(client: DatabaseClient): Promise<void> {
  const result = await client.pool.query<{ table_name: string | null }>(
    "select to_regclass('public.chain_authorization_identities')::text as table_name",
  );
  if (result.rows[0]?.table_name != null) {
    return;
  }
  const migration = await readFile(
    resolve(
      "src/db/migrations/0005_chain_authorization_references.sql",
    ),
    "utf8",
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim().length > 0) {
      await client.pool.query(statement);
    }
  }
}

describeDatabase("chain authorization repository", () => {
  let client: DatabaseClient;
  let repository: ChainAuthorizationRepository;

  beforeAll(async () => {
    if (databaseUrl === undefined) {
      return;
    }
    client = createDatabaseClient({ connectionString: databaseUrl });
    await runDatabaseMigrations(client, resolve("src/db/migrations"));
    await applyAssignedMigration(client);
    repository = new ChainAuthorizationRepository(client.database);
  });

  beforeEach(async () => {
    await client.pool.query(`
      truncate table
        chain_authorization_identities,
        pairing_attempts,
        pairing_challenges,
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
      name: "chain-authorization-integration",
      defaultModelProfile: "main",
    });
    await client.database.insert(owners).values([
      { id: ownerId, deploymentId, timezone: "UTC" },
      { id: otherOwnerId, deploymentId, timezone: "UTC" },
    ]);
    await client.database.insert(channelIdentities).values([
      {
        id: principalIdentityId,
        deploymentId,
        ownerId,
        normalizedHandleCiphertext: "cipher:principal",
        handleFingerprint: "fingerprint-principal",
        role: "owner",
        verifiedAt: new Date("2026-08-18T00:00:00Z"),
      },
      {
        id: contributorIdentityId,
        deploymentId,
        ownerId,
        normalizedHandleCiphertext: "cipher:contributor",
        handleFingerprint: "fingerprint-contributor",
        role: "collaborator",
        verifiedAt: new Date("2026-08-18T00:00:00Z"),
      },
      {
        id: otherIdentityId,
        deploymentId,
        ownerId: otherOwnerId,
        normalizedHandleCiphertext: "cipher:other",
        handleFingerprint: "fingerprint-other",
        role: "collaborator",
        verifiedAt: new Date("2026-08-18T00:00:00Z"),
      },
    ]);
    await client.database.insert(spaces).values({
      id: spaceId,
      deploymentId,
      externalSpaceGuid: "chain-authorization-space",
      type: "group",
      lastMessageAt: new Date("2026-08-18T00:00:00Z"),
    });
    await client.database.insert(chains).values({
      id: chainId,
      spaceId,
      version: 1,
      chainStartedAt: new Date("2026-08-18T00:00:01Z"),
    });
  });

  afterAll(async () => {
    await client?.close();
  });

  it("captures and reloads one principal plus contributors idempotently", async () => {
    const acceptedAt = new Date("2026-08-18T00:00:02Z");

    await repository.capture(reference, acceptedAt);
    await repository.capture(reference, new Date("2026-08-18T00:00:03Z"));

    await expect(repository.load(chainId)).resolves.toEqual(reference);
    const rows = await client.database
      .select()
      .from(chainAuthorizationIdentities)
      .where(eq(chainAuthorizationIdentities.chainId, chainId));
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identityId: principalIdentityId,
          isPrincipal: true,
          acceptedAt,
        }),
        expect.objectContaining({
          identityId: contributorIdentityId,
          isPrincipal: false,
          acceptedAt,
        }),
      ]),
    );
  });

  it("enforces unique chain identities and at most one principal", async () => {
    await repository.capture(reference);

    await expect(
      client.database.insert(chainAuthorizationIdentities).values({
        chainId,
        identityId: contributorIdentityId,
        isPrincipal: false,
      }),
    ).rejects.toThrow();
    await expect(
      client.database.insert(chainAuthorizationIdentities).values({
        chainId,
        identityId: otherIdentityId,
        isPrincipal: true,
      }),
    ).rejects.toThrow();
  });

  it("rejects capture across owner ownership and reloads current identity state", async () => {
    await expect(
      repository.capture({
        ...reference,
        contributorIdentityIds: [otherIdentityId],
      }),
    ).rejects.toThrow(/does not belong to the referenced owner and deployment/u);

    await repository.capture(reference);
    await client.database
      .update(channelIdentities)
      .set({ revokedAt: new Date("2026-08-18T00:01:00Z") })
      .where(eq(channelIdentities.id, contributorIdentityId));
    const directory = new DatabaseAuthorizationDirectory(client.database);

    await expect(
      directory.findByIds(deploymentId, ownerId, [
        principalIdentityId,
        contributorIdentityId,
      ]),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identityId: contributorIdentityId,
          revokedAt: new Date("2026-08-18T00:01:00Z"),
          ownerStatus: "active",
          deploymentStatus: "active",
        }),
      ]),
    );
  });
});
