CREATE TABLE "action_executions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"approval_id" uuid NOT NULL,
	"execution_task_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"action_type" varchar(128) NOT NULL,
	"normalized_payload_ciphertext" text NOT NULL,
	"action_hash" varchar(64) NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"last_error_code" varchar(64),
	"safe_result_json" jsonb,
	"provider_reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "action_executions_status_registered" CHECK ("status" in ('pending', 'running', 'succeeded', 'failed')),
	CONSTRAINT "action_executions_attempt_nonnegative" CHECK ("attempt_count" >= 0),
	CONSTRAINT "action_executions_action_hash_sha256" CHECK ("action_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "action_executions_action_type_registered" CHECK ("action_type" in ('filesystem.destructive', 'external.send', 'purchase', 'authentication.change', 'permission.change', 'deployment.change', 'secret.access', 'network.broad', 'dependency.install', 'other.consequential')),
	CONSTRAINT "action_executions_completion_consistent" CHECK (("status" in ('succeeded', 'failed') and "completed_at" is not null) or ("status" in ('pending', 'running') and "completed_at" is null)),
	CONSTRAINT "action_executions_claim_consistent" CHECK ("status" <> 'running' or "claimed_at" is not null)
);--> statement-breakpoint
ALTER TABLE "action_executions" ADD CONSTRAINT "action_executions_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_executions" ADD CONSTRAINT "action_executions_execution_task_id_execution_tasks_id_fk" FOREIGN KEY ("execution_task_id") REFERENCES "public"."execution_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_executions" ADD CONSTRAINT "action_executions_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_executions" ADD CONSTRAINT "action_executions_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "action_executions_approval_unique" ON "action_executions" USING btree ("approval_id");--> statement-breakpoint
CREATE INDEX "action_executions_pending_idx" ON "action_executions" USING btree ("status", "updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_task_action_hash_unique" ON "approvals" USING btree ("execution_task_id", "action_hash");
