# Migration 0006 compatibility and rollback

## Compatibility

- Apply after the integration-owned `0005` migration. This leaf intentionally
  does not edit Drizzle metadata, so the integration branch must register
  `0006_model_settings_reconciliation.sql` in the migration journal before
  production wiring can depend on it.
- The table stores one reconciliation record per deployment: the normalized
  capability catalog and stable hash, the effective pair, and the exact probe
  tuple that established readiness. It contains no credentials, message
  content, prompts, model output, or raw provider errors.
- Existing deployment preference/effective columns remain in place for
  backward compatibility. The new repository adapter updates those columns in
  the same transaction as the reconciliation row, so old chain-snapshot reads
  keep their current contract during later integration.
- The existing runtime ignores this table until the integration branch wires
  `ModelSettingsService`. Applying the migration alone does not change model
  selection, capability refreshes, dashboard behavior, or readiness.
- The foreign key is defined in SQL rather than the schema fragment so the
  fragment remains independent of integration-owned `src/db/schema.ts`.

## Recovery

- Reconciliation is single-row and idempotent by deployment ID. Replaying the
  latest final source snapshot repairs a missing row without changing the
  stored owner preference.
- Readiness is valid only when the supported probe tuple matches both the
  current catalog hash and effective pair. A stale probe cannot establish
  readiness for a different catalog or pair.

## Rollback

The preceding application ignores this table, so prefer rolling application
code back while leaving the migration applied. If a schema rollback is
required, stop application and queue workers, then run:

```sql
DROP TABLE IF EXISTS model_settings_reconciliation;
```

Dropping the table deletes only the cached catalog and probe reconciliation
state. It does not delete deployment preferences, effective deployment
columns, chains, messages, credentials, or queue state. A later forward deploy
must refresh and probe the effective pair before becoming ready.
