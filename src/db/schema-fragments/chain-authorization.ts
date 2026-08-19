import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  pgTable,
  primaryKey,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Leaf schema fragment. Foreign keys intentionally live in migration 0005 so
 * this fragment remains independent from the integration-owned schema module.
 */
export const chainAuthorizationIdentities = pgTable(
  "chain_authorization_identities",
  {
    chainId: uuid("chain_id").notNull(),
    identityId: uuid("identity_id").notNull(),
    isPrincipal: boolean("is_principal").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      name: "chain_authorization_identities_pk",
      columns: [table.chainId, table.identityId],
    }),
    uniqueIndex("chain_authorization_one_principal_unique")
      .on(table.chainId)
      .where(sql`${table.isPrincipal} = true`),
    index("chain_authorization_identity_idx").on(table.identityId),
  ],
);

export type ChainAuthorizationIdentityRow =
  typeof chainAuthorizationIdentities.$inferSelect;
