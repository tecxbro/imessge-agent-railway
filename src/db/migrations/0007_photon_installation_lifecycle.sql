CREATE TYPE "photon_installation_state" AS ENUM (
  'not_started',
  'awaiting_device_authorization',
  'token_acquired',
  'project_claimed',
  'owner_registering',
  'connected',
  'needs_owner_rebind',
  'needs_credential_repair',
  'failed'
);

CREATE TYPE "photon_installation_step" AS ENUM (
  'not_started',
  'device_authorization_requested',
  'token_acquired',
  'project_claimed',
  'project_credential_stored',
  'owner_registered',
  'credential_validated',
  'legacy_credentials_imported'
);

CREATE TABLE "owner_binding_revisions" (
  "deployment_id" uuid PRIMARY KEY NOT NULL,
  "owner_revision" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "owner_binding_revisions_nonnegative_check"
    CHECK ("owner_revision" >= 0)
);

CREATE TABLE "photon_installations" (
  "installation_id" uuid PRIMARY KEY NOT NULL,
  "deployment_id" uuid NOT NULL,
  "owner_revision" integer NOT NULL,
  "operation_id" uuid NOT NULL,
  "state" "photon_installation_state" DEFAULT 'not_started' NOT NULL,
  "photon_project_id" varchar(256),
  "management_token_ciphertext" text,
  "spectrum_secret_ciphertext" text,
  "assigned_number_ciphertext" text,
  "device_code_ciphertext" text,
  "device_user_code" varchar(128),
  "verification_url" text,
  "authorization_expires_at" timestamp with time zone,
  "poll_interval_ms" integer,
  "last_completed_step" "photon_installation_step" DEFAULT 'not_started' NOT NULL,
  "safe_failure_code" varchar(64),
  "journal_version" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "photon_installations_owner_revision_nonnegative_check"
    CHECK ("owner_revision" >= 0),
  CONSTRAINT "photon_installations_poll_interval_check"
    CHECK ("poll_interval_ms" IS NULL OR "poll_interval_ms" BETWEEN 1 AND 300000),
  CONSTRAINT "photon_installations_connected_credential_check"
    CHECK (
      "state" <> 'connected'
      OR (
        "photon_project_id" IS NOT NULL
        AND "management_token_ciphertext" IS NOT NULL
        AND "spectrum_secret_ciphertext" IS NOT NULL
        AND "assigned_number_ciphertext" IS NOT NULL
        AND "last_completed_step" IN ('credential_validated', 'legacy_credentials_imported')
      )
    )
);

ALTER TABLE "owner_binding_revisions"
  ADD CONSTRAINT "owner_binding_revisions_deployment_id_deployments_id_fk"
  FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id")
  ON DELETE cascade ON UPDATE no action;

ALTER TABLE "photon_installations"
  ADD CONSTRAINT "photon_installations_deployment_id_deployments_id_fk"
  FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id")
  ON DELETE cascade ON UPDATE no action;

CREATE UNIQUE INDEX "photon_installations_deployment_unique"
  ON "photon_installations" USING btree ("deployment_id");

CREATE INDEX "photon_installations_state_idx"
  ON "photon_installations" USING btree ("state", "updated_at");

INSERT INTO "owner_binding_revisions" ("deployment_id", "owner_revision")
SELECT "id", 1 FROM "deployments"
ON CONFLICT ("deployment_id") DO NOTHING;
