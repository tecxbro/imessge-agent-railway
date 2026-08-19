import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import {
  chains,
  executionTasks,
  owners,
  spaces,
} from "../schema.js";

export const memoryCandidateSourceStage = pgEnum(
  "memory_candidate_source_stage",
  ["direct", "task", "synthesis"],
);

export const memoryCurationState = pgEnum("memory_curation_state", [
  "pending",
  "running",
  "succeeded",
  "failed_retryable",
  "failed_terminal",
  "deferred_provider_disabled",
]);

export const chainMemoryCandidates = pgTable(
  "chain_memory_candidates",
  {
    chainId: uuid("chain_id")
      .notNull()
      .references(() => chains.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => owners.id, { onDelete: "cascade" }),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    sourceStage: memoryCandidateSourceStage("source_stage").notNull(),
    sourceTaskId: uuid("source_task_id").references(() => executionTasks.id, {
      onDelete: "cascade",
    }),
    encryptedCandidate: text("encrypted_candidate").notNull(),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.chainId, table.contentHash] }),
    index("chain_memory_candidates_owner_space_idx").on(
      table.ownerId,
      table.spaceId,
    ),
    index("chain_memory_candidates_source_task_idx").on(table.sourceTaskId),
    check(
      "chain_memory_candidates_hash_sha256",
      sql`${table.contentHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "chain_memory_candidates_source_task_consistent",
      sql`(${table.sourceStage} = 'task' and ${table.sourceTaskId} is not null) or (${table.sourceStage} in ('direct', 'synthesis') and ${table.sourceTaskId} is null)`,
    ),
    check(
      "chain_memory_candidates_ciphertext_nonempty",
      sql`length(${table.encryptedCandidate}) > 0`,
    ),
  ],
);

export const memoryCurationRuns = pgTable(
  "memory_curation_runs",
  {
    chainId: uuid("chain_id")
      .primaryKey()
      .references(() => chains.id, { onDelete: "cascade" }),
    state: memoryCurationState("state").default("pending").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    lastFailureCode: varchar("last_failure_code", { length: 128 }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("memory_curation_runs_reconcile_idx").on(
      table.state,
      table.updatedAt,
    ),
    check(
      "memory_curation_runs_attempt_nonnegative",
      sql`${table.attemptCount} >= 0`,
    ),
  ],
);

export type MemoryCandidateSourceStage =
  (typeof memoryCandidateSourceStage.enumValues)[number];
export type MemoryCurationState =
  (typeof memoryCurationState.enumValues)[number];
