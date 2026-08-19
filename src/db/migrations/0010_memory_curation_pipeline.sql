CREATE TYPE "public"."memory_candidate_source_stage" AS ENUM('direct', 'task', 'synthesis');--> statement-breakpoint
CREATE TYPE "public"."memory_curation_state" AS ENUM('pending', 'running', 'succeeded', 'failed_retryable', 'failed_terminal', 'deferred_provider_disabled');--> statement-breakpoint
CREATE TABLE "chain_memory_candidates" (
	"chain_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"source_stage" "memory_candidate_source_stage" NOT NULL,
	"source_task_id" uuid,
	"encrypted_candidate" text NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	CONSTRAINT "chain_memory_candidates_chain_id_content_hash_pk" PRIMARY KEY("chain_id","content_hash"),
	CONSTRAINT "chain_memory_candidates_hash_sha256" CHECK ("chain_memory_candidates"."content_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "chain_memory_candidates_source_task_consistent" CHECK (("chain_memory_candidates"."source_stage" = 'task' and "chain_memory_candidates"."source_task_id" is not null) or ("chain_memory_candidates"."source_stage" in ('direct', 'synthesis') and "chain_memory_candidates"."source_task_id" is null)),
	CONSTRAINT "chain_memory_candidates_ciphertext_nonempty" CHECK (length("chain_memory_candidates"."encrypted_candidate") > 0)
);
--> statement-breakpoint
CREATE TABLE "memory_curation_runs" (
	"chain_id" uuid PRIMARY KEY NOT NULL,
	"state" "memory_curation_state" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_failure_code" varchar(128),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_curation_runs_attempt_nonnegative" CHECK ("memory_curation_runs"."attempt_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "chain_memory_candidates" ADD CONSTRAINT "chain_memory_candidates_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chain_memory_candidates" ADD CONSTRAINT "chain_memory_candidates_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chain_memory_candidates" ADD CONSTRAINT "chain_memory_candidates_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chain_memory_candidates" ADD CONSTRAINT "chain_memory_candidates_source_task_id_execution_tasks_id_fk" FOREIGN KEY ("source_task_id") REFERENCES "public"."execution_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_curation_runs" ADD CONSTRAINT "memory_curation_runs_chain_id_chains_id_fk" FOREIGN KEY ("chain_id") REFERENCES "public"."chains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chain_memory_candidates_owner_space_idx" ON "chain_memory_candidates" USING btree ("owner_id","space_id");--> statement-breakpoint
CREATE INDEX "chain_memory_candidates_source_task_idx" ON "chain_memory_candidates" USING btree ("source_task_id");--> statement-breakpoint
CREATE INDEX "memory_curation_runs_reconcile_idx" ON "memory_curation_runs" USING btree ("state","updated_at");
