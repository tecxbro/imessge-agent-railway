# Migration 0008 compatibility and rollback

## Compatibility

- This numbered migration is the leaf branch's assigned slot. It depends only
  on the existing `deployments` table; the integration branch must order it
  after the collected `0005`–`0007` migrations in Drizzle migration metadata.
- The new table is additive. Existing application revisions ignore it, and no
  production row is seeded by this branch.
- New rows default to disabled so an incomplete insert cannot authorize
  execution. Enabling a row requires a reviewed workspace path and an explicit
  non-empty set drawn from the four registered permission profiles.
- The composite primary key gives each deployment one revisioned definition per
  workspace binding. The foreign key is intentionally declared here rather
  than in the isolated schema fragment.
- Application code validates the JSON profile array again at runtime, rejects
  duplicates, and resolves the workspace through the filesystem before use.

## Rollback

The table is isolated from the existing runtime and queue schema. Prefer
rolling the application back while leaving the table in place. If a schema
rollback is mandatory, stop execution workers first, confirm no integrated
runtime reads capability bindings, and run:

```sql
DROP TABLE IF EXISTS execution_capability_bindings;
```

Dropping the table permanently removes reviewed workspace/profile bindings.
It does not remove deployments, owners, Codex credentials, workspaces, chains,
tasks, messages, approvals, queue state, or outbound cursors.
