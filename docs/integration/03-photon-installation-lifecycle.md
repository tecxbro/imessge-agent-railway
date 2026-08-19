# Integration manifest 03: durable Photon installation lifecycle

## Scope and compatibility

This branch is a parallel shadow implementation. It does not replace or wire
the existing `PhotonSetupService`, `PhotonCredentialsStore`, dashboard routes,
production bootstrap, readiness composer, or Spectrum transport. Existing
exports and constructors remain unchanged.

The integration branch must choose one lifecycle implementation. Do not run
the legacy setup service and `PhotonInstallationService` concurrently for the
same deployment.

## Exported classes and interfaces

### `src/transport/photon-installation-contracts.ts`

- `PhotonInstallationState` and `PHOTON_INSTALLATION_STATES`
- `PhotonInstallationStep` and `PHOTON_INSTALLATION_STEPS`
- `PhotonInstallationFailureCode` and
  `PHOTON_INSTALLATION_FAILURE_CODES`
- `PhotonInstallationRecord`, `PhotonInstallationJournal`, and
  `PhotonInstallationStatus`
- `PhotonInstallationRepositoryPort`
- `OwnerBindingRevisionPort` and `OwnerBindingSnapshot`
- `PhotonInstallationCipher`
- `PhotonInstallationProviderPort`
- `PhotonDeviceAuthorization` and `PhotonDeviceTokenExchange`
- `LegacyPhotonInstallationCredentials`
- `photonInstallationProjectName()`

The provider port intentionally has no project-list or find-by-name method.
`createProject()` receives a name containing the stable `installationId`.
After the project-claim checkpoint, every provider call receives only the
stored `photonProjectId`.

`provisionInitialProjectSecret()` is only for the first credential of a newly
stored project ID. Its production adapter must make an ambiguous retry
idempotent by `installationId`; it must not become an unconditional call to
the Photon secret-regeneration endpoint. `rotateProjectSecret()` is the only
rotation operation and is called only by explicit `repairCredentials()`.

### `src/transport/photon-installation-service.ts`

- `PhotonInstallationService`
- `PhotonInstallationLifecycleError`
- `PhotonInstallationStaleOperationError`

The service exposes `status()`, `start()`, `resume()`, `cancel()`, `close()`,
`repairCredentials()`, and `importLegacyCredentials()`. Each mutating attempt
owns one operation ID, one `AbortController`, and one awaited promise.
Concurrent normal starts share the same promise. Shutdown aborts and awaits
the work without discarding its last durable checkpoint.

Every Photon provider call is surrounded by owner phone/revision checks. Every
journal checkpoint compares installation ID, operation ID, owner revision,
and expected state. A losing operation cannot store returned credentials.

### Internal lifecycle modules

- `src/transport/photon-installation-state.ts` exports the narrow journal,
  resume-state, validation, abort, and lifecycle-error helpers used by the
  public service.
- `src/transport/photon-installation-workflow.ts` exports
  `PhotonInstallationWorkflow`, the injected one-attempt state machine used by
  `PhotonInstallationService`. Integrators should construct the service, not
  this internal workflow directly.

### `src/runtime/owner-binding-revision.ts`

- `OwnerBindingRevisionStore`
- `OwnerBindingRevisionUnavailableError`
- `createOwnerBindingRevisionPort()`

The adapter reads revision, owner phone, and revision again. It retries a
racing snapshot and fails closed when no stable pair exists.

### `src/db/repositories/photon-installations.ts`

- `PostgresPhotonInstallationRepository`
- `advanceOwnerBindingRevisionInTransaction()`
- `photonInstallationJournalFromRecord()`

The repository uses narrow SQL against the extension tables and does not
import or modify `src/db/schema.ts`.

### `src/db/schema-fragments/photon-installations.ts`

- `photonInstallationState`
- `photonInstallationStep`
- `ownerBindingRevisions`
- `photonInstallations`

The fragment deliberately has no foreign-key imports. Foreign keys are owned
by migration `0007`.

## Required production wiring

The integration branch must:

1. Construct `PostgresPhotonInstallationRepository` from the application
   PostgreSQL pool after migration `0007` is available.
2. Construct `createOwnerBindingRevisionPort()` with the canonical
   `DeploymentIdentityController` and the repository revision reader.
3. Adapt the existing application data cipher to `PhotonInstallationCipher`.
   Do not introduce another encryption key.
4. Implement `PhotonInstallationProviderPort` with the existing bounded
   Photon device-flow and Spectrum management calls. Preserve strict response
   validation and request timeouts. The create adapter must never list or
   select a project by display name.
5. Derive the stable `installationId` from the canonical deployment/platform
   installation identity, not a deploy/restart identifier.
6. Call `resume()` under the application lifecycle supervisor after database
   startup. Do not detach it from graceful shutdown. Call and await `close()`
   before closing PostgreSQL.
7. Switch dashboard start/status projections to the durable service only
   after authenticated setup-route work is merged. Do not run both setup
   services.
8. Resolve runtime Spectrum credentials from a connected durable record only
   after the exact stored credential has validated for the current owner
   revision.
9. Keep legacy disk/environment credentials read-only until the explicit,
   conservative import succeeds. Never overwrite an existing durable project
   record with legacy data.

## Exact owner phone transaction hook

The owner-phone replacement transaction in
`OperationalRepository.replaceOwnerPhoneNumber()` must add one hook before
commit, using the same PostgreSQL transaction as the channel-identity upsert
and revocation:

```ts
await advanceOwnerBindingRevisionInTransaction(transactionClient, {
  deploymentId,
  invalidationOperationId: randomUUID(),
});
```

`transactionClient` must be the checked-out client that owns the surrounding
`BEGIN`/`COMMIT`; calling the helper through the pool or in a second
transaction is incorrect. If the integration keeps the current Drizzle
transaction callback, port the helper's four statements to
`transaction.execute(...)` without changing their order or predicates:

1. `SELECT ... FOR UPDATE` the deployment's owner-binding revision.
2. `SELECT ... FOR UPDATE` its Photon installation operation/revision, if one
   exists.
3. Increment `owner_binding_revisions` with a current-revision CAS.
4. Update `photon_installations` with the locked operation ID and owner
   revision as CAS predicates; set the new revision, a new invalidation
   operation ID, and `needs_owner_rebind` when a project credential exists.

Any zero-row CAS result aborts the owner transaction. The new phone binding,
old identity revocation, revision increment, and Photon operation invalidation
must commit atomically. This is what closes the race between the service's
post-provider owner check and its credential checkpoint.

## Database changes

Migration `0007_photon_installation_lifecycle.sql` adds:

- enum `photon_installation_state` with the nine assigned states;
- enum `photon_installation_step` for restart checkpoints;
- `owner_binding_revisions`, keyed by deployment;
- `photon_installations`, keyed by installation with a unique deployment;
- encrypted management-token, Spectrum-secret, assigned-number, and pending
  device-code columns;
- project ID, authorization expiry, public device-flow projection, last step,
  safe failure code, operation/owner CAS fields, and journal version;
- migration-owned foreign keys to `deployments`; and
- a connected-state credential constraint.

The matching compatibility and rollback notes are in
`0007_photon_installation_lifecycle.notes.md`. This leaf does not edit Drizzle
metadata. The integration branch owns metadata reconciliation across parallel
migrations `0005`, `0006`, and `0007`.

## Queue changes

None. This service owns its in-process attempt and durable PostgreSQL journal.
No central queue name, payload, publisher, or pg-boss file was changed. If the
integration branch later schedules repair work, it must add a feature-specific
contract under `src/queue/extensions/` instead of editing central queue
contracts in this leaf.

## Readiness changes

None are wired in this branch. The integration branch must make Photon
readiness false for every state except a freshly validated `connected` record
whose stored owner revision equals the current owner revision. In particular,
`needs_owner_rebind`, `needs_credential_repair`, `failed`, an expired device
authorization, or an unvalidated restart must not start Spectrum or report
ready. `/healthz` remains liveness-only.

## Exact tests added

- `test/unit/photon-installation-service.test.ts`
  - identical cosmetic names across two installations produce distinct names
    containing each installation ID;
  - owner change during provisioning blocks the project/credential commit;
  - shutdown aborts and awaits polling while preserving the checkpoint;
  - explicit cancellation aborts, awaits, and journals a safe failure;
  - concurrent starts share one attempt;
  - a stolen operation rejects the secret checkpoint;
  - reconnect validates the exact stored credential without rotation;
  - owner rebinding reuses the stored secret without rotation;
  - failed explicit repair leaves the old stored valid credential unchanged;
  - conservative legacy import validates owner, token, and exact credential.
  - legacy import never overwrites an existing durable installation.
- `test/integration/photon-installation-repository.test.ts`
  - real PostgreSQL CAS rejects the old operation/revision after the atomic
    owner-binding invalidation hook. It is skipped unless
    `POSTGRES_PIPELINE_TEST_DATABASE_URL` names a disposable database.
- `test/chaos/photon-installation-recovery.test.ts`
  - simulated process loss immediately after each of seven journal
    checkpoints resumes to connected without duplicate project creation,
    initial-secret issuance, owner registration, or any rotation.

## Evidence boundary

These tests use injected provider/cipher/owner ports. They prove lifecycle and
repository contracts locally, not live Photon idempotency, actual credential
rotation semantics, PostgreSQL behavior when the integration database is not
configured, Spectrum connection, Railway deployment, or physical iMessage
delivery. Protected provider and deployment evidence remains an integration
and release responsibility.
