CREATE TABLE "execution_capability_bindings" (
	"deployment_id" uuid NOT NULL,
	"workspace_binding" varchar(128) NOT NULL,
	"relative_workspace_path" varchar(4096) NOT NULL,
	"allowed_permission_profiles" jsonb NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_capability_bindings_pkey" PRIMARY KEY("deployment_id", "workspace_binding"),
	CONSTRAINT "execution_capability_bindings_deployment_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade,
	CONSTRAINT "execution_capability_bindings_name_valid" CHECK ("workspace_binding" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
	CONSTRAINT "execution_capability_bindings_path_present" CHECK (length(btrim("relative_workspace_path")) > 0),
	CONSTRAINT "execution_capability_bindings_revision_positive" CHECK ("revision" > 0),
	CONSTRAINT "execution_capability_bindings_profiles_array" CHECK (jsonb_typeof("allowed_permission_profiles") = 'array' AND jsonb_array_length("allowed_permission_profiles") BETWEEN 1 AND 4),
	CONSTRAINT "execution_capability_bindings_profiles_known" CHECK ("allowed_permission_profiles" <@ '["read", "workspace-write", "network-read", "approval-required"]'::jsonb)
);
