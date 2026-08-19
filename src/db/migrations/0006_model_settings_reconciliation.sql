CREATE TABLE "model_settings_reconciliation" (
	"deployment_id" uuid PRIMARY KEY NOT NULL,
	"source_kind" varchar(32) NOT NULL,
	"source_state" varchar(32) NOT NULL,
	"plan_type" varchar(64),
	"catalog_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"catalog_hash" varchar(64) NOT NULL,
	"effective_model_id" varchar(128),
	"effective_reasoning_effort" varchar(32),
	"selection_state" varchar(32) NOT NULL,
	"probe_state" varchar(32) DEFAULT 'not_probed' NOT NULL,
	"probed_catalog_hash" varchar(64),
	"probed_model_id" varchar(128),
	"probed_reasoning_effort" varchar(32),
	"source_refreshed_at" timestamp with time zone,
	"probed_at" timestamp with time zone,
	"last_error_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_settings_reconciliation_source_kind_check" CHECK ("source_kind" IN ('chatgpt', 'api_key')),
	CONSTRAINT "model_settings_reconciliation_source_state_check" CHECK ("source_state" IN ('available', 'unavailable')),
	CONSTRAINT "model_settings_reconciliation_selection_state_check" CHECK ("selection_state" IN ('preferred', 'fallback', 'unavailable')),
	CONSTRAINT "model_settings_reconciliation_probe_state_check" CHECK ("probe_state" IN ('not_probed', 'supported', 'unsupported', 'failed')),
	CONSTRAINT "model_settings_reconciliation_catalog_check" CHECK (jsonb_typeof("catalog_json") = 'array' AND "catalog_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "model_settings_reconciliation_effective_pair_check" CHECK (("effective_model_id" IS NULL) = ("effective_reasoning_effort" IS NULL)),
	CONSTRAINT "model_settings_reconciliation_probe_tuple_check" CHECK (
		(
			"probe_state" = 'not_probed'
			AND "probed_catalog_hash" IS NULL
			AND "probed_model_id" IS NULL
			AND "probed_reasoning_effort" IS NULL
			AND "probed_at" IS NULL
		)
		OR
		(
			"probe_state" IN ('supported', 'unsupported', 'failed')
			AND "probed_catalog_hash" ~ '^[0-9a-f]{64}$'
			AND "probed_model_id" IS NOT NULL
			AND "probed_reasoning_effort" IS NOT NULL
			AND "probed_at" IS NOT NULL
		)
	),
	CONSTRAINT "model_settings_reconciliation_supported_pair_check" CHECK (
		"probe_state" <> 'supported'
		OR (
			"last_error_code" IS NULL
			AND "probed_catalog_hash" = "catalog_hash"
			AND "probed_model_id" = "effective_model_id"
			AND "probed_reasoning_effort" = "effective_reasoning_effort"
		)
	),
	CONSTRAINT "model_settings_reconciliation_unavailable_check" CHECK (
		"source_state" <> 'unavailable'
		OR (
			"effective_model_id" IS NULL
			AND "effective_reasoning_effort" IS NULL
			AND "selection_state" = 'unavailable'
		)
	)
);--> statement-breakpoint
ALTER TABLE "model_settings_reconciliation" ADD CONSTRAINT "model_settings_reconciliation_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;
