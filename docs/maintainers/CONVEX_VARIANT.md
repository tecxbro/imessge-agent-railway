# Convex Variant

## 1. When to choose Convex

Choose Convex instead of PostgreSQL when:

- The project already has a Convex deployment and team expertise.
- Realtime dashboard queries are important.
- Convex functions/scheduling are preferred over a PostgreSQL queue.
- A separate Convex project setup is acceptable.

Do not choose it merely because it is an agent-related database. The default Railway PostgreSQL design is simpler for a private deployment.

## 2. Architectural rule

A deployment should have **one operational source of truth**:

```text
Option A: PostgreSQL + pg-boss + Supermemory
Option B: Convex functions/scheduler + Supermemory
```

Do not dual-write all operational state to both and hope to reconcile it. During migration, designate one writer per entity and use an explicit cutover plan.

## 3. Mapping

| PostgreSQL concept | Convex equivalent |
|---|---|
| Tables and indexes | Convex schema tables and indexes |
| Transactional repositories | Queries/mutations |
| pg-boss jobs | Scheduled functions and durable task records |
| Singleton/debounce job | Per-space schedule record + canceled/replaced scheduled function |
| Advisory lock/version | Versioned chain record checked in mutations |
| Failure events | Convex failure/audit table |
| Retention job | Cron/scheduled cleanup function |
| Readiness DB check | Convex client/function health probe |

Supermemory remains the semantic-memory layer in both variants.

## 4. Proposed Convex files

```text
convex/
├── schema.ts
├── messages.ts
├── spaces.ts
├── chains.ts
├── tasks.ts
├── approvals.ts
├── outbound.ts
├── memoryReceipts.ts
├── failures.ts
├── scheduler.ts
└── crons.ts
src/
├── state/convex-client.ts
└── queue/convex-dispatch.ts
```

Transport and Codex runtime contracts should remain unchanged.

## 5. Debounce and cancellation

- Inbound mutation inserts message and updates a per-space pending batch.
- Cancel the prior scheduled flush when possible and write a new schedule identifier.
- Flush function checks schedule/version before draining.
- New messages increment chain version and mark old chain canceled.
- Every action/function re-reads chain version before committing results.
- Carried messages are stored before a canceled drained chain terminates.

Do not rely only on scheduled-function cancellation; version checks remain necessary because a function may already be running.

## 6. Outbound idempotency

Keep the same materialized batch, stable client GUID, and send-cursor design. A Convex action may call Spectrum, but cursor advancement must be performed through mutations with compare-and-set semantics.

## 7. Deployment impact

A Railway project cannot silently create and configure a separate Convex project as part of the application service deployment. The deployer must:

1. Create/select a Convex project.
2. Deploy Convex functions/schema.
3. Supply deployment URL and deploy credentials as required.
4. Configure the Railway application service.
5. Verify Convex and Railway releases are compatible.

This makes the experience “guided multi-provider setup,” not one-click infrastructure.

## 8. Environment variables

```dotenv
STATE_BACKEND=convex
CONVEX_URL=
CONVEX_DEPLOY_KEY=
```

The deploy key should be used only by deployment tooling, not the long-running runtime when a narrower runtime credential is available.

## 9. Migration from PostgreSQL

1. Freeze shared state interfaces.
2. Implement Convex repositories behind those interfaces.
3. Backfill static owner/space/thread metadata.
4. Stop new PostgreSQL ingest briefly.
5. Migrate nonterminal chains/tasks/outbound batches carefully or drain them first.
6. Switch `STATE_BACKEND`.
7. Verify sender identity, message order, thread IDs, approvals, and memory receipts.
8. Keep old database read-only for a bounded rollback window.
9. Remove old writer only after recovery tests pass.

## 10. Decision checkpoint

Use Convex when its realtime developer experience materially benefits the product. Use PostgreSQL when deployability, SQL auditability, and one Railway project are the priority. Both are valid; mixing them without a clear boundary is not.
