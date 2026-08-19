# Integration manifest 06: model-settings domain service

## Scope

This leaf adds the isolated model-settings reconciliation domain. It is based
on commit `b731ba6e6435711d21818dbba0773c76023d87d0` and deliberately does not
wire itself into the production bootstrap, HTTP server, readiness registry, or
queue composition.

The service owns this sequence for both ChatGPT account catalogs and static
API-key configuration:

```text
explicit source refresh or final source event
  -> ignore refreshing state
  -> normalize final snapshot and compute stable catalog hash
  -> resolve the deployment preference to one effective pair
  -> probe only when the catalog hash or effective pair changed
  -> atomically persist catalog, effective selection, and probe state once
  -> publish one stable readiness snapshot
```

Capability listeners enqueue and return immediately. They never invoke source
refresh and never await reconciliation, which avoids the App Server listener
deadlock/feedback cycle when a refresh emits `refreshing` and `available`
snapshots from inside the same call.

## Exported classes and interfaces

### `src/agent/model-capability-source.ts`

- `ModelCapabilitySource`
- `ModelCapabilitySourceKind`
- `FinalModelCapabilitySnapshot`
- `ChatGptCapabilityProvider`
- `ChatGptModelCapabilitySource`
- `ApiKeyModelCapabilitySourceOptions`
- `ApiKeyModelCapabilitySource`
- `MODEL_CAPABILITY_SOURCE_KINDS`
- `normalizedModelCatalogSchema`
- `normalizeFinalCapabilitySnapshot()`

`ChatGptModelCapabilitySource` is a narrow structural adapter for the existing
`ChatGptSetupController`. `ApiKeyModelCapabilitySource` exposes the configured
API-key pair as one static available catalog and has no event feedback path.

### `src/agent/model-settings-errors.ts`

- `MODEL_SETTINGS_ERROR_CODES`
- `ModelSettingsErrorCode`
- `ModelSettingsError`
- `isModelSettingsError()`

Domain error codes are:

- `MODEL_SETTINGS_UNAVAILABLE`
- `MODEL_SELECTION_STALE`
- `MODEL_PAIR_UNAVAILABLE`
- `MODEL_CAPABILITY_REFRESH_FAILED`

The domain has no dependency on an HTTP error class.

### `src/agent/model-settings-service.ts`

- `ModelSettingsService`
- `ModelSettingsServiceOptions`
- `ModelSettingsStore`
- `PersistModelSettingsReconciliationInput`
- `ModelSettingsReconciliationRecord`
- `ModelSettingsProbeState`
- `ModelSettingsDashboardSnapshot`
- `ModelSettingsReadinessSnapshot`
- `ModelSettingsReadinessPublisher`

The service exposes `start()`, single-flight `refresh()`, serialized
`updatePreference()`, side-effect-free `readDashboard()` and `readiness()`, and
`close()`.

### `src/http/model-settings-controller.ts`

- `ModelSettingsHttpService`
- `ModelSettingsHttpController`

The adapter preserves the existing `ModelSettingsController` `read()` and
`update()` contract. It is the only new module that maps domain errors to
`ModelSettingsApiError`. A capability-refresh failure is intentionally exposed
through the existing bounded `MODEL_SETTINGS_UNAVAILABLE` HTTP response until
the integration-owned route contract explicitly adds another public code.

### `src/db/repositories/model-settings.ts`

Existing exports, constructor, and methods remain compatible:

- `ModelPreferenceUnavailableError`
- `ModelSettingsRepository(database, deploymentId)`
- `read()`
- `syncAccountCapabilities()`
- `updatePreference()`
- `activateProbedPreference()`

New adapter methods are:

- `readReconciliation()`
- `persistReconciliation()`

The new persistence method transactionally upserts the reconciliation row and
keeps the existing deployment plan/effective-selection columns synchronized
for chain snapshot compatibility. It changes the stored preference only when
the domain explicitly marks the write as a preference replacement.

## Required production wiring

The integration branch must perform all of the following; this leaf performs
none of them:

1. Register migration `0006_model_settings_reconciliation.sql` in the Drizzle
   migration journal after the assigned `0005` migration.
2. Construct `ModelSettingsRepository` after deployment initialization and
   after migration 0006 is confirmed applied.
3. In ChatGPT mode, adapt the existing `ChatGptSetupController` with
   `ChatGptModelCapabilitySource`. In API-key mode, construct
   `ApiKeyModelCapabilitySource` from the deployment preference selected for
   the capability probe.
4. Inject the existing `CapabilityPairRunner` into one `ModelSettingsService`
   instance, call `start()`, and use its single-flight `refresh()` for startup
   and explicit dashboard refreshes.
5. Replace direct capability-listener persistence, direct dashboard refresh /
   probe / persistence, and startup refresh/probe duplication with the one
   service. Do not keep parallel model-settings writers.
6. Adapt the service with `ModelSettingsHttpController` and pass that adapter
   through the existing injected HTTP controller boundary.
7. Map `ModelSettingsReadinessPublisher` snapshots to the integration-owned
   `codexCapabilities` readiness component without calling refresh or writing
   from `/readyz` reads.
8. Unsubscribe/close the service during normal shutdown.

The existing ADR/model-routing text that says the full account catalog is not
persisted predates this assigned reconciliation requirement. Integration docs
must be updated deliberately when this leaf is composed; this branch does not
edit shared architecture or ADR files.

## Database changes

Migration `src/db/migrations/0006_model_settings_reconciliation.sql` creates
one `model_settings_reconciliation` row per deployment with:

- capability source kind and final source state;
- plan metadata, normalized catalog JSON, and SHA-256 catalog hash;
- effective model/effort and selection state;
- probe state and the exact catalog/model/effort tuple probed;
- source/probe timestamps; and
- one bounded domain error code.

The table contains no credentials, message content, prompts, model output, or
raw provider error text. The deployment foreign key and consistency checks are
defined in SQL. The independent schema fragment is
`src/db/schema-fragments/model-settings-reconciliation.ts`; it does not import
or modify integration-owned `src/db/schema.ts`.

Because this worker is prohibited from editing `src/db/migrations/meta/**`,
normal `runDatabaseMigrations()` does not discover 0006 on this leaf alone.
The integration test conditionally applies the assigned SQL directly. The
integration branch must add the journal metadata before production use.

Rollback and rolling-compatibility details are in
`0006_model_settings_reconciliation.notes.md`.

## Queue changes

None. The service uses an in-process serialized promise queue for domain
reconciliation. It defines no pg-boss queue name or payload and does not edit
the central queue name, payload, publisher, or boss modules.

## Readiness changes

No production readiness file is changed. `ModelSettingsService` caches and
publishes only stable final readiness:

- `ready` only when the source is available and a supported probe tuple
  matches both the current catalog hash and effective pair;
- `MODEL_SETTINGS_UNAVAILABLE` when no effective catalog selection exists;
- `MODEL_PAIR_UNAVAILABLE` when the effective probe is unsupported or failed;
  and
- `MODEL_CAPABILITY_REFRESH_FAILED` when an explicit source refresh throws or
  returns no final snapshot.

`readiness()` is synchronous and performs no refresh, probe, read, or write.
`readDashboard()` reads persisted settings/catalog only and performs no
refresh, probe, or write.

## Exact tests added

`test/unit/model-settings-service.test.ts` adds:

- `single-flights refresh and avoids recursive listener feedback`
- `ignores refreshing snapshots and coalesces identical final catalogs`
- `coalesces one emitted and returned final even when persistence fails`
- `probes once for a changed catalog and once for a changed effective pair`
- `persists plan metadata without reprobing an unchanged catalog and pair`
- `serializes concurrently emitted final snapshots`
- `keeps readiness and dashboard reads side-effect free`
- `retries startup after a persistence read fails without leaking a listener`
- `settles an active refresh before close returns and prevents post-close writes`
- `retries a failed readiness publication on an identical stable snapshot`
- `publishes failed and recovered readiness in reconciliation order`
- `reports stale selections without probing or persisting them`
- `persists an unsupported effective probe once and does not retry an unchanged pair`
- `distinguishes capability refresh failure from unavailable stable settings`
- `uses the same reconciliation path for an API-key static source`
- four parameterized domain-to-HTTP error mapping cases
- `preserves the existing controller read and update snapshot contract`

The recursive-feedback fake awaits every listener and emits `refreshing` and
`available` from inside `refresh()`, matching the existing App Server source
behavior. The test fails on a nested source refresh and proves one source
refresh, one persistence call, and one pair probe.

`test/integration/model-settings-reconciliation.test.ts` adds:

- `survives restart and coalesces the same final catalog without another write or probe`

The PostgreSQL test is gated by `POSTGRES_PIPELINE_TEST_DATABASE_URL`. It uses
the real repository and migration/table, fake source and probe ports, then
constructs a second repository/service instance to prove the persisted stable
hash and probe tuple suppress duplicate persistence/probing after restart.
