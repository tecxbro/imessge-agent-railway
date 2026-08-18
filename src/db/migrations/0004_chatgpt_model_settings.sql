ALTER TABLE "chains" ADD COLUMN "model_id" varchar(128);--> statement-breakpoint
ALTER TABLE "chains" ADD COLUMN "reasoning_effort" varchar(32);--> statement-breakpoint
ALTER TABLE "chains" ADD COLUMN "model_selection_source" varchar(32);--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "chatgpt_plan_type" varchar(64);--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "preferred_model_id" varchar(128) DEFAULT 'gpt-5.6-luna' NOT NULL;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "preferred_reasoning_effort" varchar(32) DEFAULT 'high' NOT NULL;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "effective_model_id" varchar(128);--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "effective_reasoning_effort" varchar(32);--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "model_selection_state" varchar(32) DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "model_catalog_refreshed_at" timestamp with time zone;--> statement-breakpoint
UPDATE "deployments"
SET
	"preferred_model_id" = 'gpt-5.6-luna',
	"preferred_reasoning_effort" = 'high',
	"model_selection_state" = 'pending';
