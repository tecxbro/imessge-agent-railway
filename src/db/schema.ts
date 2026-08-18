import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

export const deploymentStatus = pgEnum("deployment_status", [
  "active",
  "disabled",
  "maintenance",
]);
export const ownerStatus = pgEnum("owner_status", ["active", "disabled"]);
export const platform = pgEnum("platform", ["imessage"]);
export const identityRole = pgEnum("identity_role", ["owner", "collaborator"]);
export const spaceType = pgEnum("space_type", ["dm", "group"]);
export const messageDirection = pgEnum("message_direction", [
  "inbound",
  "outbound",
]);
export const contentType = pgEnum("content_type", ["text"]);
export const chainState = pgEnum("chain_state", [
  "queued",
  "planning",
  "executing",
  "awaiting_approval",
  "synthesizing",
  "sending",
  "complete",
  "failed",
  "canceled",
]);
export const agentThreadStatus = pgEnum("agent_thread_status", [
  "active",
  "reset",
  "disabled",
]);
export const executionTaskState = pgEnum("execution_task_state", [
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
  "needs_approval",
]);
export const approvalStatus = pgEnum("approval_status", [
  "pending",
  "approved",
  "rejected",
  "expired",
  "consumed",
]);
export const pairingStatus = pgEnum("pairing_status", [
  "pending",
  "consumed",
  "expired",
]);
export const outboundBatchState = pgEnum("outbound_batch_state", [
  "queued",
  "sending",
  "sent",
  "failed",
  "canceled",
]);
export const outboundPartState = pgEnum("outbound_part_state", [
  "pending",
  "sent",
  "failed",
]);
export const memoryOperation = pgEnum("memory_operation", [
  "add",
  "update",
  "delete",
  "recall",
]);
export const projectionStatus = pgEnum("projection_status", [
  "pending",
  "succeeded",
  "failed",
]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
};

export const deployments = pgTable("deployments", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  ...timestamps,
  status: deploymentStatus("status").default("active").notNull(),
  defaultModelProfile: varchar("default_model_profile", { length: 64 }).notNull(),
  chatgptPlanType: varchar("chatgpt_plan_type", { length: 64 }),
  preferredModelId: varchar("preferred_model_id", { length: 128 })
    .default("gpt-5.6-luna")
    .notNull(),
  preferredReasoningEffort: varchar("preferred_reasoning_effort", {
    length: 32,
  })
    .default("high")
    .notNull(),
  effectiveModelId: varchar("effective_model_id", { length: 128 }),
  effectiveReasoningEffort: varchar("effective_reasoning_effort", {
    length: 32,
  }),
  modelSelectionState: varchar("model_selection_state", { length: 32 })
    .default("pending")
    .notNull(),
  modelCatalogRefreshedAt: timestamp("model_catalog_refreshed_at", {
    withTimezone: true,
  }),
  settingsJson: jsonb("settings_json").$type<Record<string, unknown>>().default({}).notNull(),
});

export const owners = pgTable(
  "owners",
  {
    id: uuid("id").primaryKey(),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    displayName: text("display_name"),
    timezone: text("timezone").notNull(),
    locale: text("locale"),
    status: ownerStatus("status").default("active").notNull(),
    ...timestamps,
  },
  (table) => [index("owners_deployment_idx").on(table.deploymentId)],
);

export const channelIdentities = pgTable(
  "channel_identities",
  {
    id: uuid("id").primaryKey(),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => owners.id, { onDelete: "cascade" }),
    platform: platform("platform").default("imessage").notNull(),
    normalizedHandleCiphertext: text("normalized_handle_ciphertext").notNull(),
    handleFingerprint: varchar("handle_fingerprint", { length: 128 }).notNull(),
    role: identityRole("role").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("channel_identities_handle_unique").on(
      table.deploymentId,
      table.platform,
      table.handleFingerprint,
    ),
    index("channel_identities_owner_idx").on(table.ownerId),
  ],
);

export const spaces = pgTable(
  "spaces",
  {
    id: uuid("id").primaryKey(),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    platform: platform("platform").default("imessage").notNull(),
    externalSpaceGuid: text("external_space_guid").notNull(),
    routePhoneCiphertext: text("route_phone_ciphertext"),
    routePhoneFingerprint: varchar("route_phone_fingerprint", { length: 128 }),
    type: spaceType("type").notNull(),
    modelProfileOverride: varchar("model_profile_override", { length: 64 }),
    interactionThreadId: text("interaction_thread_id"),
    interactionSummary: text("interaction_summary"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("spaces_external_route_unique").on(
      table.deploymentId,
      table.platform,
      table.externalSpaceGuid,
      sql`coalesce(${table.routePhoneFingerprint}, '')`,
    ),
    index("spaces_recent_idx").on(table.deploymentId, table.lastMessageAt),
  ],
);

export const spaceMembers = pgTable(
  "space_members",
  {
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    observedHandleFingerprint: varchar("observed_handle_fingerprint", {
      length: 128,
    }).notNull(),
    channelIdentityId: uuid("channel_identity_id").references(
      () => channelIdentities.id,
      { onDelete: "set null" },
    ),
    isAuthorized: boolean("is_authorized").default(false).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.spaceId, table.observedHandleFingerprint] }),
    index("space_members_identity_idx").on(table.channelIdentityId),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    externalMessageId: text("external_message_id"),
    direction: messageDirection("direction").notNull(),
    senderIdentityId: uuid("sender_identity_id").references(
      () => channelIdentities.id,
      { onDelete: "set null" },
    ),
    contentType: contentType("content_type").default("text").notNull(),
    contentCiphertext: text("content_ciphertext"),
    contentHash: varchar("content_hash", { length: 128 }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    drainedChainId: uuid("drained_chain_id").references(
      (): AnyPgColumn => chains.id,
      { onDelete: "set null" },
    ),
    retentionExpiresAt: timestamp("retention_expires_at", {
      withTimezone: true,
    }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("messages_external_identity_unique")
      .on(table.spaceId, table.externalMessageId)
      .where(sql`${table.externalMessageId} is not null`),
    index("messages_undrained_inbound_idx")
      .on(table.spaceId, table.receivedAt, table.id)
      .where(
        sql`${table.direction} = 'inbound' and ${table.drainedChainId} is null`,
      ),
    index("messages_retention_idx").on(table.retentionExpiresAt),
    check(
      "messages_direction_timestamp_check",
      sql`(${table.direction} = 'inbound' and ${table.receivedAt} is not null) or (${table.direction} = 'outbound' and ${table.sentAt} is not null)`,
    ),
  ],
);

export const chains = pgTable(
  "chains",
  {
    id: uuid("id").primaryKey(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    state: chainState("state").default("queued").notNull(),
    chainStartedAt: timestamp("chain_started_at", { withTimezone: true }).notNull(),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    canceledByMessageId: uuid("canceled_by_message_id").references(
      () => messages.id,
      { onDelete: "set null" },
    ),
    modelProfile: varchar("model_profile", { length: 64 }),
    modelId: varchar("model_id", { length: 128 }),
    reasoningEffort: varchar("reasoning_effort", { length: 32 }),
    modelSelectionSource: varchar("model_selection_source", { length: 32 }),
    promptVersion: varchar("prompt_version", { length: 128 }),
    decisionJson: jsonb("decision_json").$type<Record<string, unknown>>(),
    terminalErrorCode: varchar("terminal_error_code", { length: 128 }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("chains_space_version_unique").on(table.spaceId, table.version),
    index("chains_active_space_idx")
      .on(table.spaceId, table.version)
      .where(
        sql`${table.state} in ('queued', 'planning', 'executing', 'awaiting_approval', 'synthesizing', 'sending')`,
      ),
    check("chains_version_positive", sql`${table.version} > 0`),
    check(
      "chains_cancellation_consistent",
      sql`(${table.state} = 'canceled' and ${table.canceledAt} is not null) or (${table.state} <> 'canceled')`,
    ),
  ],
);

export const carriedMessages = pgTable(
  "carried_messages",
  {
    id: uuid("id").primaryKey(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    sourceChainId: uuid("source_chain_id")
      .notNull()
      .references(() => chains.id, { onDelete: "cascade" }),
    sourceMessageId: uuid("source_message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    consumedByChainId: uuid("consumed_by_chain_id").references(() => chains.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("carried_messages_source_unique").on(
      table.sourceChainId,
      table.sourceMessageId,
    ),
    index("carried_messages_pending_idx").on(
      table.spaceId,
      table.consumedByChainId,
      table.position,
    ),
    check("carried_messages_position_nonnegative", sql`${table.position} >= 0`),
  ],
);

export const agentThreads = pgTable(
  "agent_threads",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => owners.id, { onDelete: "cascade" }),
    agentName: varchar("agent_name", { length: 128 }).notNull(),
    workspaceBinding: text("workspace_binding").notNull(),
    codexThreadId: text("codex_thread_id"),
    summary: text("summary"),
    lastModelProfile: varchar("last_model_profile", { length: 64 }),
    status: agentThreadStatus("status").default("active").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("agent_threads_binding_unique").on(
      table.ownerId,
      table.agentName,
      table.workspaceBinding,
    ),
  ],
);

export const executionTasks = pgTable(
  "execution_tasks",
  {
    id: uuid("id").primaryKey(),
    chainId: uuid("chain_id")
      .notNull()
      .references(() => chains.id, { onDelete: "cascade" }),
    agentThreadId: uuid("agent_thread_id").references(() => agentThreads.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    purpose: text("purpose").notNull(),
    instructionsCiphertext: text("instructions_ciphertext"),
    modelProfile: varchar("model_profile", { length: 64 }).notNull(),
    permissionProfile: varchar("permission_profile", { length: 64 }).notNull(),
    state: executionTaskState("state").default("queued").notNull(),
    dependsOnJson: jsonb("depends_on_json").$type<string[]>().default([]).notNull(),
    resultJson: jsonb("result_json").$type<Record<string, unknown>>(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").default(0).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("execution_tasks_chain_name_unique").on(
      table.chainId,
      table.name,
    ),
    index("execution_tasks_chain_state_idx").on(table.chainId, table.state),
    check("execution_tasks_attempt_nonnegative", sql`${table.attemptCount} >= 0`),
  ],
);

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey(),
    chainId: uuid("chain_id")
      .notNull()
      .references(() => chains.id, { onDelete: "cascade" }),
    executionTaskId: uuid("execution_task_id")
      .notNull()
      .references(() => executionTasks.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => owners.id, { onDelete: "cascade" }),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    actionType: varchar("action_type", { length: 128 }).notNull(),
    normalizedPayloadCiphertext: text("normalized_payload_ciphertext"),
    actionHash: varchar("action_hash", { length: 128 }).notNull(),
    humanSummary: text("human_summary").notNull(),
    status: approvalStatus("status").default("pending").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    approvedByIdentityId: uuid("approved_by_identity_id").references(
      () => channelIdentities.id,
      { onDelete: "set null" },
    ),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("approvals_pending_scope_idx")
      .on(table.ownerId, table.spaceId, table.expiresAt)
      .where(sql`${table.status} = 'pending'`),
    uniqueIndex("approvals_active_task_unique")
      .on(table.executionTaskId)
      .where(sql`${table.status} in ('pending', 'approved')`),
    check(
      "approvals_action_hash_sha256",
      sql`${table.actionHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "approvals_action_type_registered",
      sql`${table.actionType} in ('filesystem.destructive', 'external.send', 'purchase', 'authentication.change', 'permission.change', 'deployment.change', 'secret.access', 'network.broad', 'dependency.install', 'other.consequential')`,
    ),
    check(
      "approvals_consumption_consistent",
      sql`(${table.status} = 'consumed' and ${table.consumedAt} is not null) or (${table.status} <> 'consumed' and ${table.consumedAt} is null)`,
    ),
  ],
);

export const pairingChallenges = pgTable(
  "pairing_challenges",
  {
    id: uuid("id").primaryKey(),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => owners.id, { onDelete: "cascade" }),
    role: identityRole("role").default("collaborator").notNull(),
    salt: varchar("salt", { length: 128 }).notNull(),
    codeHash: varchar("code_hash", { length: 64 }).notNull(),
    status: pairingStatus("status").default("pending").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("pairing_challenges_pending_idx")
      .on(table.deploymentId, table.expiresAt)
      .where(sql`${table.status} = 'pending'`),
    check("pairing_challenges_collaborator_role", sql`${table.role} = 'collaborator'`),
    check("pairing_challenges_code_hash", sql`${table.codeHash} ~ '^[a-f0-9]{64}$'`),
    check(
      "pairing_challenges_consumption_consistent",
      sql`(${table.status} = 'consumed' and ${table.consumedAt} is not null) or (${table.status} <> 'consumed' and ${table.consumedAt} is null)`,
    ),
  ],
);

export const pairingAttempts = pgTable(
  "pairing_attempts",
  {
    id: uuid("id").primaryKey(),
    deploymentId: uuid("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    handleFingerprint: varchar("handle_fingerprint", { length: 128 }).notNull(),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("pairing_attempts_handle_window_idx").on(
      table.deploymentId,
      table.handleFingerprint,
      table.attemptedAt,
    ),
    index("pairing_attempts_deployment_window_idx").on(
      table.deploymentId,
      table.attemptedAt,
    ),
  ],
);

export const outboundBatches = pgTable(
  "outbound_batches",
  {
    id: uuid("id").primaryKey(),
    chainId: uuid("chain_id")
      .notNull()
      .references(() => chains.id, { onDelete: "cascade" }),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    state: outboundBatchState("state").default("queued").notNull(),
    startIndex: integer("start_index").default(0).notNull(),
    partCount: integer("part_count").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("outbound_batches_chain_unique").on(table.chainId),
    index("outbound_batches_resume_idx").on(table.state, table.updatedAt),
    check(
      "outbound_batches_cursor_bounds",
      sql`${table.startIndex} >= 0 and ${table.partCount} >= 0 and ${table.startIndex} <= ${table.partCount}`,
    ),
  ],
);

export const outboundParts = pgTable(
  "outbound_parts",
  {
    id: uuid("id").primaryKey(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => outboundBatches.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    clientGuid: varchar("client_guid", { length: 64 }).notNull(),
    contentCiphertext: text("content_ciphertext").notNull(),
    state: outboundPartState("state").default("pending").notNull(),
    externalMessageId: text("external_message_id"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("outbound_parts_batch_position_unique").on(
      table.batchId,
      table.position,
    ),
    uniqueIndex("outbound_parts_client_guid_unique").on(table.clientGuid),
    check("outbound_parts_position_nonnegative", sql`${table.position} >= 0`),
  ],
);

export const memorySyncEvents = pgTable(
  "memory_sync_events",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => owners.id, { onDelete: "cascade" }),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    chainId: uuid("chain_id")
      .notNull()
      .references(() => chains.id, { onDelete: "cascade" }),
    operation: memoryOperation("operation").notNull(),
    externalMemoryId: text("external_memory_id"),
    contentHash: varchar("content_hash", { length: 128 }).notNull(),
    status: projectionStatus("status").default("pending").notNull(),
    safeSummary: text("safe_summary").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("memory_sync_events_scope_idx").on(table.ownerId, table.createdAt),
    uniqueIndex("memory_sync_events_projection_unique")
      .on(table.ownerId, table.contentHash)
      .where(sql`${table.operation} in ('add', 'update')`),
  ],
);

export const usageEvents = pgTable(
  "usage_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    chainId: uuid("chain_id").references(() => chains.id, { onDelete: "set null" }),
    executionTaskId: uuid("execution_task_id").references(() => executionTasks.id, {
      onDelete: "set null",
    }),
    eventType: varchar("event_type", { length: 128 }).notNull(),
    model: varchar("model", { length: 128 }),
    effort: varchar("effort", { length: 32 }),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    latencyMs: integer("latency_ms"),
    estimatedCostMicrounits: bigint("estimated_cost_microunits", {
      mode: "number",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("usage_events_created_idx").on(table.createdAt)],
);

export const failureEvents = pgTable(
  "failure_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    correlationType: varchar("correlation_type", { length: 64 }).notNull(),
    correlationId: text("correlation_id").notNull(),
    component: varchar("component", { length: 64 }).notNull(),
    errorCode: varchar("error_code", { length: 128 }).notNull(),
    retryable: boolean("retryable").notNull(),
    safeMessage: text("safe_message").notNull(),
    payloadSummaryJson: jsonb("payload_summary_json")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    retentionExpiresAt: timestamp("retention_expires_at", {
      withTimezone: true,
    }).notNull(),
  },
  (table) => [index("failure_events_retention_idx").on(table.retentionExpiresAt)],
);

export type ChainState = (typeof chainState.enumValues)[number];
export type OutboundBatchState = (typeof outboundBatchState.enumValues)[number];
