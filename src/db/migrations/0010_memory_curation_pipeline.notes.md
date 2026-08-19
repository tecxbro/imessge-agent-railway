# Migration 0010 compatibility and rollback

## Compatibility

- Apply after every migration through `0009`. The new tables are additive and do
  not change existing chain, task, outbound, receipt, or provider records.
- Deploy the migration before installing any memory-candidate commit hooks or
  registering the `memory.curate` publisher/worker.
- Older application revisions ignore both tables and remain compatible while
  the migration is present. New code treats PostgreSQL as authoritative and
  never reconstructs candidate content from pg-boss payloads.
- The migration does not backfill historical candidate content. Reconciliation
  creates a pending run for a historical completed chain, but an absent
  candidate row remains absent rather than uploading raw historical messages.
- The schema fragment is intentionally isolated from `src/db/schema.ts` for
  Worktree 5C. During integration, regenerate or merge the central Drizzle
  schema metadata and add this migration to `meta/_journal.json` without
  renumbering migrations already merged by other worktrees.

## Rollback

Stop the memory publisher and worker first. Confirm there are no active
`memory.curate` jobs and preserve any PostgreSQL receipt rows needed for
provider-side audit. The preceding application remains compatible with the
tables in place, so an application-only rollback is preferred.

If a schema rollback is mandatory, run:

```sql
DROP TABLE IF EXISTS memory_curation_runs;
DROP TABLE IF EXISTS chain_memory_candidates;
DROP TYPE IF EXISTS memory_curation_state;
DROP TYPE IF EXISTS memory_candidate_source_stage;
```

Dropping `chain_memory_candidates` permanently deletes encrypted, not-yet-
curated candidate inputs. It does not delete existing `memory_sync_events` or
external Supermemory records. Reapply the migration and let reconciliation
recreate runs before re-enabling the worker.
