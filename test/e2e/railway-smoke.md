# Clean Local and Railway Release Smoke

Use this file as an evidence record, not as a statement that a check passed. Mark every row `PASS`, `FAIL`, `BLOCKED`, or `NOT RUN`, then attach redacted output. Never store secrets, auth files, owner handles, raw messages, database URLs, or full provider errors here.

## Release identity

| Field | Evidence |
|---|---|
| Reviewer | |
| UTC date/time | |
| Commit SHA | |
| Branch/tag | |
| Node/npm versions | |
| PostgreSQL version | |
| Railway CLI version/workspace | |
| Railway deploy ID | |

## Runtime status and evidence boundary

The executable production runtime is composed. `npm start` executes `dist/server.js`, built from `src/server.ts`, which loads `createProductionRuntime()` and starts the PostgreSQL, queue, Codex, optional memory, worker, reconciliation, authorization, and Spectrum lifecycle. Clean-account Railway deployment and protected live-provider evidence remain separate release checks and must stay blank, `BLOCKED`, or `NOT RUN` until exercised.

## A. Offline preflight

Run from a clean checkout:

```bash
git status --short --branch
npm ci
npm run repo:verify-target
npm run typecheck
npm test
npm run test:security
npm run test:integration
npm run test:chaos
npm run build
npm run docs:check
npm run railway:validate
git diff --check
```

Database integration tests require a disposable database and truncate application tables:

```bash
POSTGRES_PIPELINE_TEST_DATABASE_URL=postgresql://<test-user>:<test-password>@127.0.0.1:5432/<disposable-test-db> npm run test:integration
```

Official schema validation requires `check-jsonschema`:

```bash
check-jsonschema --schemafile https://railway.com/railway.schema.json railway.json
```

| Check | Status | Evidence/notes |
|---|---|---|
| Clean dependency install | | |
| Canonical repository target | | |
| Typecheck | | |
| Unit/contract tests | | |
| Database integration tests (not skipped) | | |
| Chaos suite | | |
| Production build | | |
| Documentation contract | | |
| `git diff --check` | | |
| Railway configuration unit validation | | |
| Official Railway JSON schema validation | | |
| Secret scan | | |

If the official schema cannot be fetched, mark schema validation `BLOCKED`; unit tests do not substitute for the live official schema.

## B. Clean local install

Follow [`../../docs/DEPLOYMENT.md`](../../docs/DEPLOYMENT.md), including a dedicated PostgreSQL database, absolute non-overlapping storage paths, and one explicit Codex auth mode.

```bash
npm run db:migrate
npm run codex:status
npm run dev
curl --fail --silent http://127.0.0.1:10000/
curl --fail --silent http://127.0.0.1:10000/healthz
curl --silent --show-error http://127.0.0.1:10000/readyz
```

| Check | Expected | Status | Evidence/notes |
|---|---|---|---|
| Migration | exits 0; checked-in migrations applied once | | |
| `CODEX_HOME` | absolute directory, mode `0700` | | |
| Workspace root | separate absolute directory, mode `0700` | | |
| Codex auth | chosen mode reported; no secret printed | | |
| Public setup page | HTTP 200 without a password; phone setup remains in the dashboard; readiness is claimed only after critical checks pass | | |
| `/healthz` | HTTP 200 | | |
| `/readyz` | HTTP 200 only after every critical component is ready | | |
| Authorized first message | one terminal response | | |
| Unknown sender | zero Codex child processes | | |

## C. Clean Railway deployment

`/readyz` may return HTTP 503 during incomplete setup or a dependency outage. Record the returned redacted component state; do not pre-mark ready-state or message checks based on code composition alone.

Create a Railway project from the exact commit above.

| Check | Expected | Status | Evidence/notes |
|---|---|---|---|
| Resource count | one application service, one PostgreSQL 18 service | | |
| Application replicas | exactly one | | |
| Volume | one volume at `/var/data` | | |
| Codex path | `CODEX_HOME=/var/data/codex` | | |
| Workspace path | `AGENT_WORKSPACE_ROOT=/var/data/workspaces` | | |
| Database wiring | `DATABASE_URL` dynamic reference; no manual URL | | |
| Required variables | encryption key and storage paths; preserved deployment ID for migrations; no literal secrets in source | | |
| Owner setup | no owner phone or dashboard credential required in fresh service variables; owner is saved through the public dashboard | | |
| Optional Supermemory | `SUPERMEMORY_API_KEY` absent disables memory; migrated prefix is preserved | | |
| GitHub trigger | `main`, Wait for CI enabled before autodeploy | | |
| Build | `npm ci --include=dev && npm run build` exits 0 | | |
| Pre-deploy | `npm run db:migrate` exits 0 | | |
| Start | `npm start` binds Railway `PORT` | | |
| Public setup page | generated URL opens directly, identifies public setup exposure, and reports truthful readiness | | |
| Pre-setup liveness | external `/healthz` returns HTTP 200 before owner, Photon, or Codex setup is complete | | |
| Pre-setup readiness | external `/readyz` remains HTTP 503 before owner, Photon, and Codex setup are all complete | | |
| Owner dashboard | accepts the test U.S. or international number, returns only its masked form, and never echoes the raw input | | |
| Photon setup | dashboard reaches the completed Photon state and shows the assigned iMessage number | | |
| ChatGPT setup | dashboard device flow reaches the completed ChatGPT state | | |
| Advanced model settings | shows the account-advertised catalog, stored preference, and effective model/effort | | |
| Final readiness | external `/readyz` becomes HTTP 200 after owner, Photon, ChatGPT, and all other critical checks pass | | |
| Authorized durable acceptance | a safe database identifier proves durable acceptance before the inbound iMessage changes to read | | |
| Authorized response | agent sends exactly one short response matching the predeclared non-sensitive fixture; record only match/no-match | | |
| Unauthorized sender | an unauthorized inbound starts no Codex child or durable model work | | |
| Restart persistence | a normal service restart preserves masked owner status, Photon setup, ChatGPT setup, and preferred/effective model settings | | |
| Redeploy durability | a redeploy preserves the existing Railway volume and PostgreSQL records; no replacement volume or database is used | | |

Do not record the Railway deployment as cleanly functional until this exact production entrypoint reaches `/readyz` 200 and the protected first-message checks pass.

## D. Codex enrollment and restart persistence

### ChatGPT mode

Open the Railway service URL, enter the owner phone, authenticate Photon, choose **Connect ChatGPT**, and complete the device-code flow. Open **Advanced** and confirm or change the deployment model and reasoning effort. As an operator fallback, use Railway SSH:

```bash
railway ssh
npm run codex:login
npm run codex:status
test -f "$CODEX_HOME/auth.json"
chmod 600 "$CODEX_HOME/auth.json"
```

Restart/redeploy, then rerun `npm run codex:status` and inspect `/readyz`. Device login must be enabled by the ChatGPT account/workspace. Do not attach the URL code, token, or `auth.json`.

### API-key mode

Add `OPENAI_API_KEY` as a Railway service variable, set `CODEX_AUTH_MODE=api_key`, restart, and run the protected capability probe. Do not run device login and do not print the key.

| Check | Status | Evidence/notes |
|---|---|---|
| Chosen auth mode enforced | | |
| Advanced shows the preferred and effective model pair | | |
| Status/capability probe passes | | |
| Credentials survive restart (ChatGPT mode) | | |
| `/readyz` becomes 200 after all critical components | | |
| Expired/revoked auth pauses execution | | |
| Re-enrollment restores readiness | | |

## E. Protected live provider tests

These are opt-in and must stay `NOT RUN` unless real credentials/accounts and an authorized test recipient are configured.

Codex account smoke:

```bash
RUN_CODEX_LIVE=1 npm test -- test/e2e/codex-live.test.ts
```

Spectrum authorized DM smoke:

```bash
SPECTRUM_LIVE_TEST=true npm test -- test/live/spectrum-dm.test.ts
```

The Spectrum test also requires every documented `SPECTRUM_LIVE_*` value in a protected environment. Supermemory requires a separate add/search/delete item in a test owner container; no protected Supermemory live script is currently checked in, so mark it `BLOCKED` or `NOT RUN` rather than substituting fake-provider results.

The dedicated memory-provider outage/Supermemory-timeout resilience exercise is not recorded in the current release evidence. Preserve it as `NOT RUN`; incidental fake-provider coverage in a broad offline suite is not accepted as outage validation, and the expected invariant below remains policy unless a later authorized run supplies evidence.

| Provider | Status | Exact test/evidence | Live claim allowed? |
|---|---|---|---|
| Railway | | clean deploy/restart record | only if passed |
| Photon/Spectrum | | protected authorized DM | only if passed |
| Codex | | protected schema-bound run | only if passed |
| Supermemory | | protected add/search/delete | only if passed |

## F. Failure and recovery matrix

For process-kill tests, use a staging deployment/test database. Record the durable row/job state immediately before the kill, kill only the application process/instance, restart it, and capture the reconciled terminal state. A test-only failure hook must be deterministic and excluded from production. If the integrated release has no hook at a stage, mark that stage `BLOCKED`; do not simulate it only in prose.

| Failure point | Injection/evidence requirement | Expected invariant | Status |
|---|---|---|---|
| Receive | fail queue schedule after accepted DB insert; run `npx vitest run test/chaos/durable-stage-recovery.test.ts` | durable message is reconciled into one flush | |
| Debounce | kill after accepted rows exist while flush is delayed | rows remain undrained; one movable per-space flush resumes | |
| Planning | kill after chain enters planning and before decision commit | same chain/version retries or is superseded; no stale outbound | |
| Execution | kill one active execution worker | bounded retry/failure; canceled chain cannot synthesize/send | |
| Synthesis | kill after terminal task scan and before/after singleton enqueue | exactly one synthesis job/outbound batch | |
| Outbound part 1..N | for every materialized part, kill after provider acknowledgement and before cursor checkpoint; run `npx vitest run test/chaos/outbound-restart.test.ts` | retry uses identical client GUID; cursor only advances after checkpoint | |
| Memory write | timeout/fail after operational response completes | response remains complete; safe receipt/failure is retryable | |
| Spectrum disconnect | run `npx vitest run test/chaos/service-lifecycle.test.ts -t "surfaces a Spectrum disconnect"` | readiness 503; bounded reconnect; no leaked provider data | |
| Database timeout | run `npx vitest run test/chaos/database-timeout.test.ts` | liveness 200, readiness 503, no downstream startup | |
| Supermemory timeout | intentionally skipped by user direction; optional later command: `npx vitest run test/integration/memory-isolation.test.ts -t "MEMORY_PROVIDER_TIMEOUT"` | policy: planning continues with explicit empty degraded context | NOT RUN |
| Expired Codex auth | run `npx vitest run test/chaos/service-lifecycle.test.ts -t "Codex auth expires"` | Spectrum intake paused; safe re-enrollment action | |
| Graceful SIGTERM | run `npx vitest run test/chaos/service-lifecycle.test.ts -t "gracefully checkpoints"` | readiness false; abort/checkpoint/close order completes | |

The fake transport verifies stable retry GUIDs; only a live provider test can establish the provider's visible deduplication behavior.

## G. End-to-end restart

After Railway readiness passes:

1. Send an authorized turn that establishes a Codex thread and one non-sensitive durable preference.
2. Record terminal chain/outbound state using safe IDs only.
3. Restart the Railway application service normally.
4. Require `/healthz` and `/readyz` HTTP 200.
5. Send a follow-up that requires prior context.
6. Verify the persisted thread or bounded recovery summary is used, the memory remains owner-scoped, and no outbound part duplicates.
7. Repeat after a hard process kill during each stage in section F.

| Check | Status | Evidence/notes |
|---|---|---|
| Graceful restart recovery | | |
| Hard restart recovery | | |
| Codex auth persistence | | |
| Workspace persistence | | |
| Queue reconciliation | | |
| Outbound no-duplicate evidence | | |
| Owner-scoped memory continuity | | |

## H. Rollback drill

1. Record current and prior commits.
2. Read all intervening migration notes.
3. Verify a database recovery point.
4. Stop new execution and allow graceful shutdown.
5. Deploy the prior commit only if it supports the current schema.
6. Reconcile, verify both health endpoints, and send one authorized non-mutating turn.
7. If schema rollback is required, stop all workers and use only the checked-in migration rollback SQL.

| Check | Status | Evidence/notes |
|---|---|---|
| Prior app/schema compatibility proven | | |
| Graceful stop/checkpoint | | |
| Prior application deploy | | |
| Reconciliation | | |
| Post-rollback authorized turn | | |
| No queue/outbound corruption | | |

## Final release decision

| Gate | Status | Reason/evidence |
|---|---|---|
| Clean local | | |
| Clean Railway | | |
| Restart recovery | | |
| Every failure stage | | |
| Security/secret boundary | | |
| Documentation commands copied exactly | | |

**Decision:** `GO` / `NO-GO`

A `GO` requires every required gate to pass. Any composition mismatch, skipped required database test, missing failure-stage evidence, or unsupported live-provider claim is `NO-GO`.
