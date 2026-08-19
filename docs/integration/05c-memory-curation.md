# Worktree 5C: durable memory curation integration

## Boundary

This worktree adds an isolated PostgreSQL projection pipeline. PostgreSQL owns
candidate inputs, run state, recovery, and provider receipts. Supermemory is an
optional external projection and never changes whether the operational turn
completed.

The queue payload is the existing strict `MemoryCuratePayload`:

```ts
{
  chainId: string;
  expectedChainVersion: number;
  expectedState: "complete";
}
```

Candidate content never belongs in pg-boss data, logs, run failure codes, or
reconciliation reports. `chain_memory_candidates.encrypted_candidate` is the
only durable candidate body; `content_hash` is its normalized deduplication
identity.

Current provider guidance uses a stable container identity to scope a user's
memories and a provider/custom identity for an individual document. This
pipeline preserves the existing opaque deployment/owner container and uses
PostgreSQL receipts plus the content hash to recover safely around the
non-idempotent provider create boundary. See the official [Supermemory
SDK](https://supermemory.ai/docs/integrations/supermemory-sdk) and [add-document
API](https://supermemory.ai/docs/api-reference/ingest/add-document).

## Required integration wiring

The integrator must merge the schema fragment into the central Drizzle schema,
add `0010_memory_curation_pipeline` to `src/db/migrations/meta/_journal.json`,
and reconcile its number against migrations merged from Worktrees 5A/5B. Do
not edit or renumber an already-applied migration. Apply the migration before
installing any hooks or worker registration.

Construct one `MemoryCurationRepository` with the application data cipher:

```ts
const memoryCuration = new MemoryCurationRepository(database, {
  encrypt: cipher.encrypt,
  decrypt: cipher.decrypt,
});
```

Inject a `Pick<MemoryCurationRepository, "recordCandidatesInTransaction">`
into `OrchestrationRepository`. Every hook below must run inside the same
transaction as its authoritative decision/result. Calling
`recordCandidates()` after the orchestration transaction commits creates a
crash gap and is not an acceptable substitute.

### 1. Direct decision commit hook

In `OrchestrationRepository.commitFinal`, after the chain row has been locked
and validated but before inserting the outbound batch, use the non-synthesis
branch (`!("terminalResults" in input)`). Call the hook even when the candidate
array is empty so the chain receives exactly one pending run:

```ts
const ownerId = await this.ownerIdForChain(transaction, chain.id);
await this.memoryCuration.recordCandidatesInTransaction(transaction, {
  chainId: chain.id,
  ownerId,
  spaceId: chain.spaceId,
  sourceStage: "direct",
  sourceTaskId: null,
  candidates: decision.memoryCandidates,
});
```

This hook covers direct and confirmation decisions. Slash-command decisions
carry an empty candidate array and therefore create a run without inventing
memory content. Do not attach a hook to `turn-plan.ts` after `commitFinal`; the
database commit boundary belongs in the repository transaction.

### 2. Task result commit hook

In `OrchestrationRepository.completeTask`, after the locked task/chain state and
logical task ID have been validated but before updating
`execution_tasks.result_json`, record the validated `ExecutionResult` candidates:

```ts
const ownerId = await this.ownerIdForChain(transaction, input.payload.chainId);
await this.memoryCuration.recordCandidatesInTransaction(transaction, {
  chainId: input.payload.chainId,
  ownerId,
  spaceId: row.spaceId, // add chains.spaceId to the locked row selection
  sourceStage: "task",
  sourceTaskId: input.payload.taskId,
  candidates: result.memoryCandidates,
});
```

Use the persisted execution-task UUID from the queue payload, not the model's
logical task name. Do not add candidates from `failTaskAttempt`; only the
accepted terminal task-result transaction is a source. The worker will still
reject the whole projection if the parent chain later fails or is canceled.

### 3. Synthesis result commit hook

In the synthesis branch of `OrchestrationRepository.commitFinal`
(`"terminalResults" in input`), after the chain check and before the outbound
batch insert, record only the synthesis decision's candidates:

```ts
const ownerId = await this.ownerIdForChain(transaction, chain.id);
await this.memoryCuration.recordCandidatesInTransaction(transaction, {
  chainId: chain.id,
  ownerId,
  spaceId: chain.spaceId,
  sourceStage: "synthesis",
  sourceTaskId: null,
  candidates: decision.memoryCandidates,
});
```

Do not append `input.terminalResults[*].memoryCandidates` here; the task commit
hook already stored those candidates, and replaying them would erase exact
source-task provenance.

## Publisher, worker, and completion trigger

Register the existing `memory.curate` queue with
`createMemoryCurateHandler(...)` and `PgBossMemoryQueuePublisher`. Pass `null`
as the provider when `SUPERMEMORY_API_KEY` is not configured. The claim then
transitions to `deferred_provider_disabled`, returns normally, and consumes no
pg-boss retries.

After `OutboundRepository.checkpointSentPart()` reports
`batchComplete: true`, trigger `PgBossMemoryQueuePublisher.reconcile(...)` only
after that transaction commits. The reconciliation query supplies the exact
chain version and completed-state payload. Also run reconciliation once after
migrations and pg-boss startup, before accepting inbound work. It finds:

- completed chains with no run (including a crash before a commit hook was
  integrated);
- pending runs whose singleton job is absent;
- retryable failed runs after pg-boss retries are exhausted;
- provider-disabled runs after the provider becomes enabled; and
- stale `running` runs left by worker/process interruption.

The publisher inspects active pg-boss jobs and sends only missing singleton
jobs. Do not add candidate JSON to this completion trigger.

## Worker state and retry contract

The worker locks and reloads the chain/run, requires the exact chain version
and authoritative `complete` state, rejects failed/canceled chains, decrypts
every candidate, validates it with `memoryCandidateSchema`, and recomputes its
content hash before any provider call.

`curateMemories()` returns a `failed` item with `failureCode` and `retryable`
for each failed candidate. The handler processes candidates in bounded groups
of 20 and:

- marks the run `failed_retryable` and throws only when at least one candidate
  failure is retryable;
- marks it `failed_terminal` when failures exist but none are retryable;
- marks it `succeeded` when every candidate was written, updated,
  deduplicated, or deterministically filtered; and
- leaves an already-completed operational response unchanged in every case.

A successful local receipt short-circuits provider search/write. If the
provider accepted a create but the receipt checkpoint failed, retry searches
by the content hash, records the provider duplicate as succeeded, and does not
issue a second create.

## Evidence boundary

The unit and chaos tests use injected provider/receipt fakes. The PostgreSQL
integration test requires `POSTGRES_PIPELINE_TEST_DATABASE_URL` and exercises
the migration, encrypted persistence, three source stages, run uniqueness,
reconciliation classes, and failed/superseded rejection. No protected live
Supermemory add/search/delete was run by this worktree; offline success is not
live-provider evidence.
