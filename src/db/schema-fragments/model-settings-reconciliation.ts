import {
  jsonb,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import type { CodexModelOption } from "../../agent/codex-account-capabilities.js";

export const modelSettingsReconciliation = pgTable(
  "model_settings_reconciliation",
  {
    deploymentId: uuid("deployment_id").primaryKey(),
    sourceKind: varchar("source_kind", { length: 32 }).notNull(),
    sourceState: varchar("source_state", { length: 32 }).notNull(),
    planType: varchar("plan_type", { length: 64 }),
    catalogJson: jsonb("catalog_json")
      .$type<readonly CodexModelOption[]>()
      .default([])
      .notNull(),
    catalogHash: varchar("catalog_hash", { length: 64 }).notNull(),
    effectiveModelId: varchar("effective_model_id", { length: 128 }),
    effectiveReasoningEffort: varchar("effective_reasoning_effort", {
      length: 32,
    }),
    selectionState: varchar("selection_state", { length: 32 }).notNull(),
    probeState: varchar("probe_state", { length: 32 })
      .default("not_probed")
      .notNull(),
    probedCatalogHash: varchar("probed_catalog_hash", { length: 64 }),
    probedModelId: varchar("probed_model_id", { length: 128 }),
    probedReasoningEffort: varchar("probed_reasoning_effort", { length: 32 }),
    sourceRefreshedAt: timestamp("source_refreshed_at", {
      withTimezone: true,
    }),
    probedAt: timestamp("probed_at", { withTimezone: true }),
    lastErrorCode: varchar("last_error_code", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
);
