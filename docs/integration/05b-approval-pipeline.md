# Worktree 5B integration manifest: durable approval pipeline

This branch is an isolated leaf. It defines and tests approval request and
exact-action execution, but does not register queues, workers, commands,
provider adapters, bootstrap stages, or readiness components in production.

## Exported classes and interfaces

### Exact action adapters

- `ActionExecutor`, `ActionExecutorInput`, `ActionExecutorResult`,
  `ActionExecutorError`, `actionExecutorInputSchema`, and
  `actionExecutorResultSchema` from `src/actions/action-executor.ts`.
- `ActionExecutorRegistry` and `UnsupportedActionTypeError` from
  `src/actions/action-executor-registry.ts`.
- `normalizedApprovedActionSchema`, `NormalizedApprovedAction`,
  `storedActionEnvelopeSchema`, and `StoredActionEnvelope` from
  `src/security/action-schema.ts`.

Provider adapters must register one code-owned `ActionType`, honor
`actionExecutionId` as their idempotency key, and return only bounded safe
receipt metadata. They must not call Codex or reinterpret the approved payload.

### Approval service and repositories

- `ApprovalService.create()` creates an exact request idempotently by
  `(executionTaskId, actionHash)`.
- `ApprovalService.respondWithProgression()` returns rejection progression.
- `ApprovalService.expireWithProgression()` returns expiry progressions.
- `ApprovalService.consume()` revalidates the durable binding and approving
  owner identity through `ApprovalPersistence`, consumes once, and returns the
  newly created `actionExecutionId` plus the normalized action.
- `decryptStoredApprovedAction()`, `ApprovalChainProgression`,
  `ApprovalResponseOutcome`, `ApprovalExpiryOutcome`, and
  `ApprovalRunnableTask` are exported from `src/security/approvals.ts`.
- `ApprovalResponsePersistenceInput`,
  `ConsumeApprovedActionPersistenceInput`, `EncryptedStoredActionBinding`, and
  `ConsumedApprovedAction` define the new service/persistence boundary in that
  same module. Existing approval exports and the `ApprovalService` constructor
  remain compatible.
- `ApprovalRepository`, `ApprovalRepositoryOptions`, and
  `DurableApprovalRequestContext` are exported alongside the existing
  `CreateApprovalInput`, `ApprovalResponseInput`, and
  `ConsumeApprovedActionInput` repository contracts.
- `ActionExecutionRepository`, `ActionExecutionRepositoryOptions`,
  `ClaimActionExecutionInput`, `StoredActionExecution`,
  `RecordActionExecutionFailureInput`, and
  `ActionExecutionFailureOutcome` are exported from
  `src/db/repositories/action-executions.ts`.

Pass the application data cipher as
`ApprovalRepositoryOptions.encryptExecutionResult` so rejection/expiry writes
terminal encrypted task results. Pass the same operation to
`ActionExecutionRepositoryOptions.encryptExecutionResult` for action success,
non-retryable failure, and blocked-dependent results.

### Worker factories and local ports

- `createApprovalRequestHandler`, `ApprovalRequestRepository`,
  `ApprovalRequestPublisher`, `ApprovalRequestMessage`,
  `ApprovalRequestDependencies`, `DurableApprovalProposal`, and
  `formatApprovalRequestMessage` from
  `src/queue/handlers/approval-request.ts`.
- `createApprovalExecuteHandler`, `ApprovalActionExecutionRepository`,
  `ApprovalProgressionPublisher`, and `ApprovalExecuteDependencies` from
  `src/queue/handlers/approval-execute.ts`.
- `ApprovalQueuePublisher` and the queue schemas/types described below from
  `src/queue/extensions/approval-queues.ts`.

## Required production wiring

The integration owner must perform all wiring in integration-owned files:

1. When `task.execute` durably commits a `needs_approval` result, enqueue only
   `{ executionTaskId }` to `approval.request`. Do not include an action or raw
   content in the job.
2. Register `approval.request` and construct its handler with
   `ApprovalRepository`, the application data decryptor, `ApprovalService`, the
   final `ActionExecutorRegistry`, and an idempotent owner-message publisher.
   The publisher must deduplicate by `ApprovalRequestMessage.idempotencyKey`.
3. Route authenticated owner approve/reject commands to
   `ApprovalService.respondWithProgression()`. Publish rejection progression
   immediately. For approval, call `ApprovalService.consume()` with the exact
   approval/owner/space/task binding, then enqueue only its
   `{ actionExecutionId }` to `approval.execute`.
4. Register `approval.execute` with `ActionExecutionRepository`, the approval
   payload cipher, the same executor registry used by the request worker, and a
   local progression publisher that maps `newlyRunnableTasks` to existing
   `task.execute` jobs and `shouldSynthesize` to one `turn.synthesize` job.
   Those publishers must retain their task/chain singleton keys: duplicate
   action delivery deliberately re-publishes completed progression to recover
   a crash after the terminal database commit.
5. Add an expiry sweep that calls `expireWithProgression()` and publishes every
   returned progression. Reconcile durable `needs_approval` tasks without a
   request job, pending `action_executions` without an execute job, and stale
   running rows reset by `requeueStaleRunning()` before accepting intake.
6. Register only reviewed provider adapters. An action type without an adapter
   must remain unsupported; do not create a placeholder executor or send the
   payload back to Codex.

## Database changes

- `src/db/migrations/0009_approval_action_execution.sql` adds
  `action_executions`, its four foreign keys, one-execution-per-approval
  uniqueness, pending recovery index, state/hash/attempt checks, and the unique
  approval idempotency index on `(execution_task_id, action_hash)`.
  Action target and normalized payload remain inside the copied authenticated
  ciphertext; the execution table does not duplicate them in plaintext.
- `src/db/migrations/0009_approval_action_execution.notes.md` records ordering,
  compatibility, duplicate preflight, deployment order, and destructive
  rollback impact.
- `src/db/schema-fragments/approval-executions.ts` defines the feature-local
  Drizzle `actionExecutions` table and `ActionExecutionStatus` type without
  importing `src/db/schema.ts`. Foreign keys remain in the SQL migration.
- This leaf intentionally does not edit `src/db/schema.ts`, `drizzle.config.ts`,
  or `src/db/migrations/meta/**`. The integration owner must reconcile migration
  numbering and journal metadata after merging parallel leaves.

## Queue changes

`src/queue/extensions/approval-queues.ts` exports:

- `APPROVAL_QUEUE_NAMES.request = "approval.request"` with strict payload
  `{ executionTaskId: uuid }`;
- `APPROVAL_QUEUE_NAMES.execute = "approval.execute"` with strict payload
  `{ actionExecutionId: uuid }`;
- both payload schemas/types, `parseApprovalQueuePayload()`, and the local
  `ApprovalQueuePublisher` interface.

No central queue name, payload, publisher, or pg-boss file is changed on this
branch.

## Readiness changes

None are wired here. Integration must add a critical readiness check that stays
not ready when migration `0009` is absent, either approval queue is unavailable,
or a production-enabled action type lacks a registered executor. Provider
health should remain adapter-specific and redacted. Offline tests do not prove
any live provider action.

## Exact tests added

- `test/unit/approval-request-handler.test.ts`
  - identifier-only strict local queue payloads;
  - duplicate request delivery and `(executionTaskId, actionHash)` idempotency;
  - deterministic code-owned message/idempotency key;
  - non-owner rejection and one-time consumption;
  - rejected and expired progression outcomes;
  - unsupported action type before approval creation;
  - exactly one proposed action for `needs_approval`.
- `test/unit/approval-execute-handler.test.ts`
  - exact stored payload/hash binding;
  - duplicate worker delivery;
  - provider retry with the same `actionExecutionId`;
  - no model summary or reinterpretation input at the adapter boundary.
- `test/integration/approval-action-execution.test.ts`
  - PostgreSQL request idempotency, one-time atomic consume/action row creation,
    exact execution, and duplicate delivery;
  - approving owner identity revocation before consumption.

The PostgreSQL test uses `POSTGRES_PIPELINE_TEST_DATABASE_URL` and skips when no
disposable integration database is configured. Protected/live provider tests
are not added because this branch contains only fake adapters and no production
wiring.
