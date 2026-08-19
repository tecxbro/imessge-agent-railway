import type { Pool, PoolClient, QueryResultRow } from "pg";

import type { OwnerBindingRevisionStore } from "../../runtime/owner-binding-revision.js";
import {
  PHOTON_INSTALLATION_FAILURE_CODES,
  PHOTON_INSTALLATION_STATES,
  PHOTON_INSTALLATION_STEPS,
  type CheckpointPhotonInstallationInput,
  type ClaimPhotonInstallationOperationInput,
  type CreatePhotonInstallationInput,
  type PhotonInstallationFailureCode,
  type PhotonInstallationRecord,
  type PhotonInstallationRepositoryPort,
  type PhotonInstallationState,
  type PhotonInstallationStep,
} from "../../transport/photon-installation-contracts.js";

type SqlClient = Pick<Pool, "query">;

interface PhotonInstallationRow extends QueryResultRow {
  installationId: string;
  deploymentId: string;
  ownerRevision: number;
  operationId: string;
  state: string;
  photonProjectId: string | null;
  managementTokenCiphertext: string | null;
  spectrumSecretCiphertext: string | null;
  assignedNumberCiphertext: string | null;
  deviceCodeCiphertext: string | null;
  deviceUserCode: string | null;
  verificationUrl: string | null;
  authorizationExpiresAt: Date | null;
  pollIntervalMs: number | null;
  lastCompletedStep: string;
  safeFailureCode: string | null;
  journalVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const installationColumns = `
  "installation_id" AS "installationId",
  "deployment_id" AS "deploymentId",
  "owner_revision" AS "ownerRevision",
  "operation_id" AS "operationId",
  "state"::text AS "state",
  "photon_project_id" AS "photonProjectId",
  "management_token_ciphertext" AS "managementTokenCiphertext",
  "spectrum_secret_ciphertext" AS "spectrumSecretCiphertext",
  "assigned_number_ciphertext" AS "assignedNumberCiphertext",
  "device_code_ciphertext" AS "deviceCodeCiphertext",
  "device_user_code" AS "deviceUserCode",
  "verification_url" AS "verificationUrl",
  "authorization_expires_at" AS "authorizationExpiresAt",
  "poll_interval_ms" AS "pollIntervalMs",
  "last_completed_step"::text AS "lastCompletedStep",
  "safe_failure_code" AS "safeFailureCode",
  "journal_version" AS "journalVersion",
  "created_at" AS "createdAt",
  "updated_at" AS "updatedAt"
`;

function isOneOf<const Values extends readonly string[]>(
  value: string,
  values: Values,
): value is Values[number] {
  return values.includes(value);
}

function requiredInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Photon installation ${field} is invalid.`);
  }
  return value;
}

function parseRow(row: PhotonInstallationRow): PhotonInstallationRecord {
  if (!isOneOf(row.state, PHOTON_INSTALLATION_STATES)) {
    throw new Error("Photon installation state is invalid.");
  }
  if (!isOneOf(row.lastCompletedStep, PHOTON_INSTALLATION_STEPS)) {
    throw new Error("Photon installation checkpoint is invalid.");
  }
  if (
    row.safeFailureCode !== null &&
    !isOneOf(row.safeFailureCode, PHOTON_INSTALLATION_FAILURE_CODES)
  ) {
    throw new Error("Photon installation failure code is invalid.");
  }

  return {
    installationId: row.installationId,
    deploymentId: row.deploymentId,
    ownerRevision: requiredInteger(row.ownerRevision, "owner revision"),
    operationId: row.operationId,
    state: row.state,
    ...(row.photonProjectId === null
      ? {}
      : { photonProjectId: row.photonProjectId }),
    ...(row.managementTokenCiphertext === null
      ? {}
      : { managementTokenCiphertext: row.managementTokenCiphertext }),
    ...(row.spectrumSecretCiphertext === null
      ? {}
      : { spectrumSecretCiphertext: row.spectrumSecretCiphertext }),
    ...(row.assignedNumberCiphertext === null
      ? {}
      : { assignedNumberCiphertext: row.assignedNumberCiphertext }),
    ...(row.deviceCodeCiphertext === null
      ? {}
      : { deviceCodeCiphertext: row.deviceCodeCiphertext }),
    ...(row.deviceUserCode === null
      ? {}
      : { deviceUserCode: row.deviceUserCode }),
    ...(row.verificationUrl === null
      ? {}
      : { verificationUrl: row.verificationUrl }),
    ...(row.authorizationExpiresAt === null
      ? {}
      : { authorizationExpiresAt: row.authorizationExpiresAt }),
    ...(row.pollIntervalMs === null
      ? {}
      : { pollIntervalMs: row.pollIntervalMs }),
    lastCompletedStep: row.lastCompletedStep,
    ...(row.safeFailureCode === null
      ? {}
      : {
          safeFailureCode:
            row.safeFailureCode as PhotonInstallationFailureCode,
        }),
    journalVersion: requiredInteger(row.journalVersion, "journal version"),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function assertState(state: string): asserts state is PhotonInstallationState {
  if (!isOneOf(state, PHOTON_INSTALLATION_STATES)) {
    throw new Error("Photon installation state is invalid.");
  }
}

function assertStep(step: string): asserts step is PhotonInstallationStep {
  if (!isOneOf(step, PHOTON_INSTALLATION_STEPS)) {
    throw new Error("Photon installation checkpoint is invalid.");
  }
}

export class PostgresPhotonInstallationRepository
  implements PhotonInstallationRepositoryPort, OwnerBindingRevisionStore
{
  public constructor(private readonly client: SqlClient) {}

  public async load(
    installationId: string,
  ): Promise<PhotonInstallationRecord | undefined> {
    const result = await this.client.query<PhotonInstallationRow>(
      `SELECT ${installationColumns}
       FROM "photon_installations"
       WHERE "installation_id" = $1
       LIMIT 1`,
      [installationId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : parseRow(row);
  }

  public async createInitial(
    input: CreatePhotonInstallationInput,
  ): Promise<PhotonInstallationRecord | undefined> {
    requiredInteger(input.ownerRevision, "owner revision");
    const result = await this.client.query<PhotonInstallationRow>(
      `INSERT INTO "photon_installations" (
         "installation_id",
         "deployment_id",
         "owner_revision",
         "operation_id",
         "state",
         "last_completed_step"
       ) VALUES ($1, $2, $3, $4, 'not_started', 'not_started')
       ON CONFLICT DO NOTHING
       RETURNING ${installationColumns}`,
      [
        input.installationId,
        input.deploymentId,
        input.ownerRevision,
        input.operationId,
      ],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : parseRow(row);
  }

  public async claimOperation(
    input: ClaimPhotonInstallationOperationInput,
  ): Promise<PhotonInstallationRecord | undefined> {
    requiredInteger(input.expectedOwnerRevision, "expected owner revision");
    requiredInteger(input.nextOwnerRevision, "next owner revision");
    assertState(input.nextState);
    const result = await this.client.query<PhotonInstallationRow>(
      `UPDATE "photon_installations"
       SET
         "operation_id" = $4,
         "owner_revision" = $5,
         "state" = $6::"photon_installation_state",
         "safe_failure_code" = NULL,
         "journal_version" = "journal_version" + 1,
         "updated_at" = now()
       WHERE "installation_id" = $1
         AND "operation_id" = $2
         AND "owner_revision" = $3
       RETURNING ${installationColumns}`,
      [
        input.installationId,
        input.expectedOperationId,
        input.expectedOwnerRevision,
        input.nextOperationId,
        input.nextOwnerRevision,
        input.nextState,
      ],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : parseRow(row);
  }

  public async checkpoint(
    input: CheckpointPhotonInstallationInput,
  ): Promise<PhotonInstallationRecord | undefined> {
    requiredInteger(input.ownerRevision, "owner revision");
    assertState(input.next.state);
    assertStep(input.next.lastCompletedStep);
    if (input.expectedStates.length === 0) {
      throw new Error("Photon installation CAS requires an expected state.");
    }
    for (const state of input.expectedStates) {
      assertState(state);
    }
    if (
      input.next.safeFailureCode !== undefined &&
      !isOneOf(
        input.next.safeFailureCode,
        PHOTON_INSTALLATION_FAILURE_CODES,
      )
    ) {
      throw new Error("Photon installation failure code is invalid.");
    }
    const result = await this.client.query<PhotonInstallationRow>(
      `UPDATE "photon_installations"
       SET
         "state" = $5::"photon_installation_state",
         "photon_project_id" = $6,
         "management_token_ciphertext" = $7,
         "spectrum_secret_ciphertext" = $8,
         "assigned_number_ciphertext" = $9,
         "device_code_ciphertext" = $10,
         "device_user_code" = $11,
         "verification_url" = $12,
         "authorization_expires_at" = $13,
         "poll_interval_ms" = $14,
         "last_completed_step" = $15::"photon_installation_step",
         "safe_failure_code" = $16,
         "journal_version" = "journal_version" + 1,
         "updated_at" = now()
       WHERE "installation_id" = $1
         AND "operation_id" = $2
         AND "owner_revision" = $3
         AND "state"::text = ANY($4::text[])
       RETURNING ${installationColumns}`,
      [
        input.installationId,
        input.operationId,
        input.ownerRevision,
        [...input.expectedStates],
        input.next.state,
        input.next.photonProjectId ?? null,
        input.next.managementTokenCiphertext ?? null,
        input.next.spectrumSecretCiphertext ?? null,
        input.next.assignedNumberCiphertext ?? null,
        input.next.deviceCodeCiphertext ?? null,
        input.next.deviceUserCode ?? null,
        input.next.verificationUrl ?? null,
        input.next.authorizationExpiresAt ?? null,
        input.next.pollIntervalMs ?? null,
        input.next.lastCompletedStep,
        input.next.safeFailureCode ?? null,
      ],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : parseRow(row);
  }

  public async readCurrentOwnerRevision(
    deploymentId: string,
  ): Promise<number | undefined> {
    const result = await this.client.query<
      QueryResultRow & { ownerRevision: number }
    >(
      `SELECT "owner_revision" AS "ownerRevision"
       FROM "owner_binding_revisions"
       WHERE "deployment_id" = $1`,
      [deploymentId],
    );
    const revision = result.rows[0]?.ownerRevision;
    return revision === undefined
      ? undefined
      : requiredInteger(revision, "owner revision");
  }

  public async ensureOwnerBindingRevision(
    deploymentId: string,
    initialRevision = 0,
  ): Promise<number> {
    requiredInteger(initialRevision, "initial owner revision");
    const result = await this.client.query<
      QueryResultRow & { ownerRevision: number }
    >(
      `INSERT INTO "owner_binding_revisions" (
         "deployment_id", "owner_revision"
       ) VALUES ($1, $2)
       ON CONFLICT ("deployment_id") DO UPDATE
       SET "updated_at" = "owner_binding_revisions"."updated_at"
       RETURNING "owner_revision" AS "ownerRevision"`,
      [deploymentId, initialRevision],
    );
    return requiredInteger(
      result.rows[0]!.ownerRevision,
      "owner revision",
    );
  }
}

/**
 * Must run on the same checked-out PostgreSQL transaction client that changes
 * the owner channel identity. It bumps the canonical revision and invalidates
 * the current Photon operation with an operationId/ownerRevision CAS.
 */
export async function advanceOwnerBindingRevisionInTransaction(
  transaction: Pick<PoolClient, "query">,
  input: {
    deploymentId: string;
    invalidationOperationId: string;
  },
): Promise<number> {
  const lockedRevision = await transaction.query<
    QueryResultRow & { currentRevision: number }
  >(
    `SELECT "owner_revision" AS "currentRevision"
     FROM "owner_binding_revisions"
     WHERE "deployment_id" = $1
     FOR UPDATE`,
    [input.deploymentId],
  );
  const currentRevisionRow = lockedRevision.rows[0];
  if (currentRevisionRow === undefined) {
    throw new Error(
      "Owner binding revision must be initialized before changing the owner.",
    );
  }
  const lockedInstallation = await transaction.query<
    QueryResultRow & {
      installationId: string;
      installationOperationId: string;
      installationOwnerRevision: number;
    }
  >(
    `SELECT
       "installation_id" AS "installationId",
       "operation_id" AS "installationOperationId",
       "owner_revision" AS "installationOwnerRevision"
     FROM "photon_installations"
     WHERE "deployment_id" = $1
     FOR UPDATE`,
    [input.deploymentId],
  );
  const currentInstallation = lockedInstallation.rows[0];
  const currentRevision = requiredInteger(
    currentRevisionRow.currentRevision,
    "owner revision",
  );
  const nextRevision = currentRevision + 1;
  requiredInteger(nextRevision, "next owner revision");

  const bumped = await transaction.query(
    `UPDATE "owner_binding_revisions"
     SET "owner_revision" = $3, "updated_at" = now()
     WHERE "deployment_id" = $1 AND "owner_revision" = $2`,
    [input.deploymentId, currentRevision, nextRevision],
  );
  if (bumped.rowCount !== 1) {
    throw new Error("Owner binding revision CAS was rejected.");
  }

  if (currentInstallation !== undefined) {
    const invalidated = await transaction.query(
      `UPDATE "photon_installations"
       SET
         "owner_revision" = $4,
         "operation_id" = $5,
         "state" = CASE
           WHEN "photon_project_id" IS NOT NULL
             AND "spectrum_secret_ciphertext" IS NOT NULL
             THEN 'needs_owner_rebind'::"photon_installation_state"
           ELSE "state"
         END,
         "safe_failure_code" = NULL,
         "journal_version" = "journal_version" + 1,
         "updated_at" = now()
       WHERE "installation_id" = $1
         AND "operation_id" = $2
         AND "owner_revision" = $3`,
      [
        currentInstallation.installationId,
        currentInstallation.installationOperationId,
        currentInstallation.installationOwnerRevision,
        nextRevision,
        input.invalidationOperationId,
      ],
    );
    if (invalidated.rowCount !== 1) {
      throw new Error("Photon installation owner invalidation CAS was rejected.");
    }
  }

  return nextRevision;
}

export function photonInstallationJournalFromRecord(
  record: PhotonInstallationRecord,
): CheckpointPhotonInstallationInput["next"] {
  return {
    state: record.state,
    ...(record.photonProjectId === undefined
      ? {}
      : { photonProjectId: record.photonProjectId }),
    ...(record.managementTokenCiphertext === undefined
      ? {}
      : { managementTokenCiphertext: record.managementTokenCiphertext }),
    ...(record.spectrumSecretCiphertext === undefined
      ? {}
      : { spectrumSecretCiphertext: record.spectrumSecretCiphertext }),
    ...(record.assignedNumberCiphertext === undefined
      ? {}
      : { assignedNumberCiphertext: record.assignedNumberCiphertext }),
    ...(record.deviceCodeCiphertext === undefined
      ? {}
      : { deviceCodeCiphertext: record.deviceCodeCiphertext }),
    ...(record.deviceUserCode === undefined
      ? {}
      : { deviceUserCode: record.deviceUserCode }),
    ...(record.verificationUrl === undefined
      ? {}
      : { verificationUrl: record.verificationUrl }),
    ...(record.authorizationExpiresAt === undefined
      ? {}
      : { authorizationExpiresAt: record.authorizationExpiresAt }),
    ...(record.pollIntervalMs === undefined
      ? {}
      : { pollIntervalMs: record.pollIntervalMs }),
    lastCompletedStep: record.lastCompletedStep,
    ...(record.safeFailureCode === undefined
      ? {}
      : { safeFailureCode: record.safeFailureCode }),
  };
}
