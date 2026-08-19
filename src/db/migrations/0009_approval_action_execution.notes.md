# Migration 0009 compatibility and rollback

## Compatibility

- Apply after the integration branch has reconciled migrations `0005` through
  `0008`. This leaf branch intentionally does not edit Drizzle migration
  metadata; the integration owner must add `0009` to the final journal.
- `action_executions` is additive. Older application revisions ignore it and
  continue to read existing approval rows.
- The unique approval foreign key guarantees one durable action execution per
  consumed approval. The `(execution_task_id, action_hash)` approval index makes
  exact approval creation idempotent across duplicate worker deliveries.
- Before applying to a database that accepted approvals through older code,
  check for duplicate `(execution_task_id, action_hash)` rows. Resolve any such
  historical duplicate deliberately before creating the unique index; do not
  delete approval history automatically.
- Deploy the migration before wiring `approval.request` or `approval.execute`
  workers. Keep both queues paused until every production action type has a
  reviewed executor adapter.

## Rollback

Prefer rolling the application back while leaving this additive table and
index in place. If schema rollback is mandatory, stop approval request and
action execution workers, confirm no jobs remain runnable, preserve an audit
export, and run:

```sql
DROP INDEX IF EXISTS approvals_task_action_hash_unique;
DROP TABLE IF EXISTS action_executions;
```

Dropping `action_executions` deletes provider execution receipts and retry
state. It does not restore a consumed approval to an executable state, so any
affected operation must be reviewed and requested again rather than replayed.
