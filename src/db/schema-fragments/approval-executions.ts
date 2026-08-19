import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export type ActionExecutionStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed";

/**
 * Feature-local table definition. Foreign keys intentionally live only in the
 * assigned SQL migration so this fragment does not import the central schema.
 */
export const actionExecutions = pgTable(
  "action_executions",
  {
    id: uuid("id").primaryKey(),
    approvalId: uuid("approval_id").notNull(),
    executionTaskId: uuid("execution_task_id").notNull(),
    ownerId: uuid("owner_id").notNull(),
    spaceId: uuid("space_id").notNull(),
    actionType: varchar("action_type", { length: 128 }).notNull(),
    normalizedPayloadCiphertext: text("normalized_payload_ciphertext").notNull(),
    actionHash: varchar("action_hash", { length: 64 }).notNull(),
    status: varchar("status", { length: 32 })
      .$type<ActionExecutionStatus>()
      .default("pending")
      .notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastErrorCode: varchar("last_error_code", { length: 64 }),
    safeResultJson: jsonb("safe_result_json").$type<Record<string, unknown>>(),
    providerReference: text("provider_reference"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("action_executions_approval_unique").on(table.approvalId),
    index("action_executions_pending_idx").on(table.status, table.updatedAt),
    check(
      "action_executions_status_registered",
      sql`${table.status} in ('pending', 'running', 'succeeded', 'failed')`,
    ),
    check(
      "action_executions_attempt_nonnegative",
      sql`${table.attemptCount} >= 0`,
    ),
    check(
      "action_executions_action_hash_sha256",
      sql`${table.actionHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "action_executions_action_type_registered",
      sql`${table.actionType} in ('filesystem.destructive', 'external.send', 'purchase', 'authentication.change', 'permission.change', 'deployment.change', 'secret.access', 'network.broad', 'dependency.install', 'other.consequential')`,
    ),
    check(
      "action_executions_completion_consistent",
      sql`(${table.status} in ('succeeded', 'failed') and ${table.completedAt} is not null) or (${table.status} in ('pending', 'running') and ${table.completedAt} is null)`,
    ),
    check(
      "action_executions_claim_consistent",
      sql`${table.status} <> 'running' or ${table.claimedAt} is not null`,
    ),
  ],
);
