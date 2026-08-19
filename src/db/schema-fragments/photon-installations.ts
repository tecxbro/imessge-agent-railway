import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const photonInstallationState = pgEnum("photon_installation_state", [
  "not_started",
  "awaiting_device_authorization",
  "token_acquired",
  "project_claimed",
  "owner_registering",
  "connected",
  "needs_owner_rebind",
  "needs_credential_repair",
  "failed",
]);

export const photonInstallationStep = pgEnum("photon_installation_step", [
  "not_started",
  "device_authorization_requested",
  "token_acquired",
  "project_claimed",
  "project_credential_stored",
  "owner_registered",
  "credential_validated",
  "legacy_credentials_imported",
]);

export const ownerBindingRevisions = pgTable("owner_binding_revisions", {
  deploymentId: uuid("deployment_id").primaryKey(),
  ownerRevision: integer("owner_revision").default(0).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const photonInstallations = pgTable(
  "photon_installations",
  {
    installationId: uuid("installation_id").primaryKey(),
    deploymentId: uuid("deployment_id").notNull(),
    ownerRevision: integer("owner_revision").notNull(),
    operationId: uuid("operation_id").notNull(),
    state: photonInstallationState("state")
      .default("not_started")
      .notNull(),
    photonProjectId: varchar("photon_project_id", { length: 256 }),
    managementTokenCiphertext: text("management_token_ciphertext"),
    spectrumSecretCiphertext: text("spectrum_secret_ciphertext"),
    assignedNumberCiphertext: text("assigned_number_ciphertext"),
    deviceCodeCiphertext: text("device_code_ciphertext"),
    deviceUserCode: varchar("device_user_code", { length: 128 }),
    verificationUrl: text("verification_url"),
    authorizationExpiresAt: timestamp("authorization_expires_at", {
      withTimezone: true,
    }),
    pollIntervalMs: integer("poll_interval_ms"),
    lastCompletedStep: photonInstallationStep("last_completed_step")
      .default("not_started")
      .notNull(),
    safeFailureCode: varchar("safe_failure_code", { length: 64 }),
    journalVersion: integer("journal_version").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("photon_installations_deployment_unique").on(
      table.deploymentId,
    ),
    index("photon_installations_state_idx").on(table.state, table.updatedAt),
  ],
);
