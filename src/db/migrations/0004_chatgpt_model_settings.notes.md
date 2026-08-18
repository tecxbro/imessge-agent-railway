# Migration 0004 compatibility and rollback

## Compatibility

- Apply after `0003_tranquil_arclight`. The new deployment columns retain the
  owner preference separately from the currently effective Codex pair.
- Existing deployments are explicitly backfilled to the stored preference
  `gpt-5.6-luna` / `high` and the `pending` selection state. The non-null
  defaults apply the same values to deployments created after migration.
- The former deployment, space, chain, task, and agent-thread profile columns
  remain in place. This release writes compatibility value `main` where an old
  non-null column requires it, but runtime selection no longer reads those
  columns.
- New application code requires an effective pair before creating a message
  chain. During a rolling deploy, complete the migration and capability sync
  before enabling intake on the new revision.
- The model catalog is deliberately not persisted. A successful account
  capability refresh repopulates the effective pair after startup.

## Rollback

The added columns are forward-compatible with the preceding application, so
prefer rolling the application back while leaving this migration applied. If a
schema rollback is mandatory, stop all application and queue workers first,
confirm no newer application revision will restart, and run:

```sql
ALTER TABLE chains DROP COLUMN IF EXISTS model_selection_source;
ALTER TABLE chains DROP COLUMN IF EXISTS reasoning_effort;
ALTER TABLE chains DROP COLUMN IF EXISTS model_id;
ALTER TABLE deployments DROP COLUMN IF EXISTS model_catalog_refreshed_at;
ALTER TABLE deployments DROP COLUMN IF EXISTS model_selection_state;
ALTER TABLE deployments DROP COLUMN IF EXISTS effective_reasoning_effort;
ALTER TABLE deployments DROP COLUMN IF EXISTS effective_model_id;
ALTER TABLE deployments DROP COLUMN IF EXISTS preferred_reasoning_effort;
ALTER TABLE deployments DROP COLUMN IF EXISTS preferred_model_id;
ALTER TABLE deployments DROP COLUMN IF EXISTS chatgpt_plan_type;
```

Dropping these columns deletes the saved deployment preference and account-plan
metadata. It does not delete legacy profile columns, chains, messages, queue
state, credentials, or outbound cursors.
