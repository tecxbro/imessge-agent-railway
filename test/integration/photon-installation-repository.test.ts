import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";
import { runDatabaseMigrations } from "../../src/db/migrate.js";
import {
  advanceOwnerBindingRevisionInTransaction,
  photonInstallationJournalFromRecord,
  PostgresPhotonInstallationRepository,
} from "../../src/db/repositories/photon-installations.js";

const databaseUrl = process.env["POSTGRES_PIPELINE_TEST_DATABASE_URL"];
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

const DEPLOYMENT_ID = "41000000-0000-4000-8000-000000000001";
const INSTALLATION_ID = "42000000-0000-4000-8000-000000000001";
const FIRST_OPERATION_ID = "43000000-0000-4000-8000-000000000001";
const INVALIDATION_OPERATION_ID = "43000000-0000-4000-8000-000000000002";

describeDatabase("PostgreSQL Photon installation repository", () => {
  let client: DatabaseClient;
  let repository: PostgresPhotonInstallationRepository;

  beforeAll(async () => {
    if (databaseUrl === undefined) {
      return;
    }
    client = createDatabaseClient({ connectionString: databaseUrl });
    await runDatabaseMigrations(client, resolve("src/db/migrations"));
    const existing = await client.pool.query<{ name: string | null }>(
      "select to_regclass('public.photon_installations')::text as name",
    );
    if (existing.rows[0]?.name === null) {
      const migration = await readFile(
        resolve(
          "src/db/migrations/0007_photon_installation_lifecycle.sql",
        ),
        "utf8",
      );
      await client.pool.query(migration);
    }
    repository = new PostgresPhotonInstallationRepository(client.pool);
  });

  beforeEach(async () => {
    await client.pool.query("delete from deployments where id = $1", [
      DEPLOYMENT_ID,
    ]);
    await client.pool.query(
      `insert into deployments (
         id, name, default_model_profile
       ) values ($1, 'Photon lifecycle integration', 'main')`,
      [DEPLOYMENT_ID],
    );
    await repository.ensureOwnerBindingRevision(DEPLOYMENT_ID, 1);
  });

  afterAll(async () => {
    if (client !== undefined) {
      await client.pool.query("delete from deployments where id = $1", [
        DEPLOYMENT_ID,
      ]);
      await client.close();
    }
  });

  it("rejects stale operation and owner-revision journal commits", async () => {
    const initial = await repository.createInitial({
      installationId: INSTALLATION_ID,
      deploymentId: DEPLOYMENT_ID,
      ownerRevision: 1,
      operationId: FIRST_OPERATION_ID,
    });
    expect(initial?.state).toBe("not_started");

    const projectClaimed = await repository.checkpoint({
      installationId: INSTALLATION_ID,
      operationId: FIRST_OPERATION_ID,
      ownerRevision: 1,
      expectedStates: ["not_started"],
      next: {
        state: "owner_registering",
        photonProjectId: "exact-project-id",
        managementTokenCiphertext: "cipher:management",
        spectrumSecretCiphertext: "cipher:secret",
        lastCompletedStep: "project_credential_stored",
      },
    });
    expect(projectClaimed?.photonProjectId).toBe("exact-project-id");

    const transaction = await client.pool.connect();
    try {
      await transaction.query("begin");
      const revision = await advanceOwnerBindingRevisionInTransaction(
        transaction,
        {
          deploymentId: DEPLOYMENT_ID,
          invalidationOperationId: INVALIDATION_OPERATION_ID,
        },
      );
      expect(revision).toBe(2);
      await transaction.query("commit");
    } catch (error) {
      await transaction.query("rollback");
      throw error;
    } finally {
      transaction.release();
    }

    const stale = await repository.checkpoint({
      installationId: INSTALLATION_ID,
      operationId: FIRST_OPERATION_ID,
      ownerRevision: 1,
      expectedStates: ["owner_registering"],
      next: {
        ...photonInstallationJournalFromRecord(projectClaimed!),
        state: "connected",
        assignedNumberCiphertext: "cipher:+15555550999",
        lastCompletedStep: "credential_validated",
      },
    });
    expect(stale).toBeUndefined();

    const durable = await repository.load(INSTALLATION_ID);
    expect(durable).toMatchObject({
      operationId: INVALIDATION_OPERATION_ID,
      ownerRevision: 2,
      state: "needs_owner_rebind",
      photonProjectId: "exact-project-id",
      spectrumSecretCiphertext: "cipher:secret",
    });
  });
});
