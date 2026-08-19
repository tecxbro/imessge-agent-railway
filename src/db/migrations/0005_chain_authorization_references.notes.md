# Migration 0005 compatibility and rollback

## Compatibility

- Apply after `0004_chatgpt_model_settings` and before enabling the final queued
  Codex authorization boundary.
- Existing chains remain readable, but they have no captured authorization
  reference. The secure runner intentionally rejects such chains with
  `CODEX_START_AUTHORIZATION_INVALID`; drain or cancel pre-migration queued work
  before enabling the wrapper.
- `chain_id` cascades on chain deletion. `identity_id` uses `ON DELETE RESTRICT`
  so a captured contributor cannot disappear while queued work still refers to
  that identity; revoke identities instead of deleting them.
- The composite primary key makes each chain/identity pair unique. The partial
  unique index permits at most one principal per chain, while the repository
  captures the principal and contributors in one transaction and requires
  exactly one principal.
- This leaf does not edit `src/db/migrations/meta/**`. The integration owner must
  register `0005_chain_authorization_references` in the Drizzle migration
  journal before production deployment.

## Rollback

Stop intake and queued Codex workers before rollback. Code using the secure
runner must be removed or disabled first because it fails closed without this
table. Then run:

```sql
DROP TABLE IF EXISTS chain_authorization_identities;
```

Dropping the table deletes captured chain authorization references only. It
does not delete chains, messages, owners, channel identities, Codex threads, or
queue jobs.
