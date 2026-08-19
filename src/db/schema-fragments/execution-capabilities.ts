import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import type { PermissionProfileName } from "../../security/permissions.js";

export const executionCapabilityBindings = pgTable(
  "execution_capability_bindings",
  {
    deploymentId: uuid("deployment_id").notNull(),
    workspaceBinding: varchar("workspace_binding", { length: 128 }).notNull(),
    relativeWorkspacePath: varchar("relative_workspace_path", {
      length: 4_096,
    }).notNull(),
    allowedPermissionProfiles: jsonb("allowed_permission_profiles")
      .$type<PermissionProfileName[]>()
      .notNull(),
    enabled: boolean("enabled").default(false).notNull(),
    revision: integer("revision").default(1).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      name: "execution_capability_bindings_pkey",
      columns: [table.deploymentId, table.workspaceBinding],
    }),
    check(
      "execution_capability_bindings_revision_positive",
      sql`${table.revision} > 0`,
    ),
    check(
      "execution_capability_bindings_profiles_array",
      sql`jsonb_typeof(${table.allowedPermissionProfiles}) = 'array' and jsonb_array_length(${table.allowedPermissionProfiles}) between 1 and 4`,
    ),
  ],
);

export type ExecutionCapabilityBindingRow =
  typeof executionCapabilityBindings.$inferSelect;
