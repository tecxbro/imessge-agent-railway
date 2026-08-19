# Secure Codex boundary integration manifest

This branch is an isolated leaf. It deliberately does not change handlers,
`ThreadStore`, production bootstrap, runtime composition, central queue
contracts, the central Drizzle schema, or readiness code.

## Exported classes and interfaces

### `src/security/queued-authorization.ts`

- `QueuedAuthorizationReference` identifies the deployment, owner, chain,
  principal identity, and complete contributor identity set captured when the
  chain was accepted.
- `QueuedAuthorizationReferenceStore` reloads a reference by chain ID.
- `CodexStartDeniedCode` is the five-code safe denial union.
- `CodexStartDeniedError` is a typed error with `retryable === false`.
- `QueuedCodexStartGate` reloads every referenced identity in one batch, checks
  current revocation/owner/deployment state and ownership, consumes the task
  rate limit, and only then invokes the child callback.
- `isQueuedAuthorizationReferenceValid()` validates the bounded, unique
  reference shape.

### `src/security/secure-codex-runner.ts`

- `SecureCodexProgressEvent`, `SecureCodexRunRequest`, `SecureCodexUsage`, and
  `SecureCodexRunResult` mirror the existing runner's structural boundary
  without creating the forbidden `security -> agent` import.
- `SecureStructuredCodexRunnerPort` is structurally compatible with the
  agent-layer `StructuredCodexRunner` interface; the unit test includes a
  compile-time assignment proving compatibility.
- `SecureStructuredCodexRunnerOptions` supplies a chain ID, reference store,
  reference-based start gate, and delegated `StructuredCodexRunner`.
- `SecureStructuredCodexRunner` structurally implements
  `StructuredCodexRunner`. Every `runStructured()` call reloads the stored
  reference before invoking the gate, including ThreadStore recovery calls.

### `src/security/authorize-sender.ts`

- `BatchedAuthorizationDirectory` extends the existing directory contract with
  `findByIds(deploymentId, ownerId, identityIds)`.
- `DatabaseAuthorizationDirectory.findByIds()` performs one live query and
  returns identity revocation, owner status, deployment status, role, and
  verified owner/deployment ownership. The method remains optional on the old
  `AuthorizationDirectory` interface so existing adapters and the current
  `SecureCodexStartGate` constructor/`start()` API remain compatible.

### Database exports

- `chainAuthorizationIdentities` and `ChainAuthorizationIdentityRow` from
  `src/db/schema-fragments/chain-authorization.ts`.
- `ChainAuthorizationRepository` from
  `src/db/repositories/chain-authorization.ts`, with `capture()`,
  `captureInTransaction()`, and `load()`.

## Required production wiring

1. Register `0005_chain_authorization_references` in the integration-owned
   Drizzle migration journal. This branch intentionally does not edit
   `src/db/migrations/meta/**`.
2. In the integration-owned chain-creation transaction, call
   `ChainAuthorizationRepository.captureInTransaction()` before publishing the
   first chain job. Use the accepted author as `principalIdentityId` and capture
   every authorized group contributor as `contributorIdentityIds`.
3. Do not enqueue Codex work for a chain unless its authorization reference was
   captured successfully. Existing pre-migration queued chains have no safe
   reference and must be drained or canceled before enabling this boundary.
4. For each queued chain, construct `SecureStructuredCodexRunner` around the
   existing structured runner and inject that decorator below `ThreadStore`.
   This ensures both the normal call and a recovery call pass through live
   authorization.
5. Supply `DatabaseAuthorizationDirectory`, the existing owner task-rate-limit
   policy, and `ChainAuthorizationRepository` to `QueuedCodexStartGate` and the
   runner. Do not catch and retry `CodexStartDeniedError`; the existing queue
   worker recognizes its `retryable: false` property.
6. Leave the legacy `SecureCodexStartGate` API in place for existing callers,
   but do not use it as a substitute for the stored multi-identity reference on
   the final queued path.

## Database changes

Migration `0005_chain_authorization_references.sql` creates
`chain_authorization_identities` with:

- `chain_id uuid NOT NULL`, cascading from `chains`;
- `identity_id uuid NOT NULL`, restricted from deletion while referenced;
- `is_principal boolean NOT NULL`;
- `accepted_at timestamptz NOT NULL DEFAULT now()`;
- composite primary key `(chain_id, identity_id)`; and
- partial unique index on `chain_id` where `is_principal = true`.

The fragment defines the table and indexes without importing the central
schema. Foreign keys exist only in the SQL migration. The repository enforces
exactly one principal and captures all rows transactionally.

## Queue changes

No queue names, payloads, publishers, boss code, handlers, or extension
contracts change in this leaf. Queue payloads remain ID-only. The integration
owner must use the payload's chain ID to scope the secure runner and reload the
authorization reference from PostgreSQL.

## Readiness changes

No new readiness component is required. The existing migration readiness gate
must observe registered migration `0005` before workers or Spectrum intake are
enabled. Missing chain references fail individual queued starts closed with
`CODEX_START_AUTHORIZATION_INVALID`; they are not a provider-readiness signal.

## Exact tests added

- `test/unit/secure-codex-runner.test.ts`
  - proves a live principal revocation prevents another child call;
  - proves one revoked contributor blocks the whole chain;
  - proves a denied task rate limit prevents the child;
  - proves two runner invocations perform two reference loads and two live
    batched identity checks;
  - proves a missing contributor is rejected as stale authorization; and
  - proves invalid, revoked, disabled-owner, unavailable-deployment, and
    rate-limited denials are typed and non-retryable.
- `test/integration/chain-authorization-repository.test.ts`
  - proves transactional, idempotent principal/contributor capture and reload;
  - proves unique chain/identity and one-principal database constraints;
  - proves cross-owner capture is rejected and the database authorization
    directory reloads current contributor revocation state.

The PostgreSQL integration file runs only when
`POSTGRES_PIPELINE_TEST_DATABASE_URL` points to the documented disposable test
database. It applies the assigned SQL directly for leaf validation because the
integration-owned migration journal is intentionally untouched.
