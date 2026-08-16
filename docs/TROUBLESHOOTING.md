# Troubleshooting

Start with the visible symptom. Run commands only in a trusted local terminal or a private Railway SSH session. Redact output before sharing it.

## Deploy failed during build

**What it means:** Dependencies did not install or TypeScript did not compile.

**Where to check:** Railway build logs for the first failed command and the exact commit being built.

**Exact safe command:**

```bash
npm ci --include=dev && npm run build
```

**Expected result:** Both commands exit 0 and `dist/server.js` exists.

**Do not:** Print environment variables, remove `package-lock.json`, or bypass the pinned toolchain to make the build green.

## Pre-deploy migration failed

**What it means:** The new service was not started because `npm run db:migrate` could not apply or verify the checked-in migrations.

**Where to check:** Railway pre-deploy logs and the matching `src/db/migrations/*.notes.md` files.

**Exact safe command:**

```bash
npm run db:migrate
```

**Expected result:** The command exits 0 against the intended database.

**Do not:** Print `DATABASE_URL`, drop application or pg-boss tables, edit an already-applied migration, or improvise a down migration.

## `/healthz` returns an error

**What it means:** The HTTP process is not reachable or could not serve liveness.

**Where to check:** Railway service status, start logs, port binding, and the deployed commit.

**Exact safe command:**

```bash
curl --fail --silent --show-error "https://<service-host>/healthz"
```

**Expected result:** HTTP 200 with `{"status":"ok"}`.

**Do not:** Expose the service environment or treat repeated blind restarts as a diagnosis.

## `/readyz` remains 503

**What it means:** One or more critical components are missing, starting, failed, or degraded.

**Where to check:** The redacted `components` and `actions` in `/readyz`, then the corresponding Railway service logs.

**Exact safe command:**

```bash
curl --silent --show-error "https://<service-host>/readyz"
```

**Expected result:** HTTP 200 only when configuration, database, migrations, queue, Codex, storage, and Spectrum are ready. HTTP 503 during incomplete setup is truthful.

**Do not:** Use `/healthz` as acceptance, paste raw provider errors into tickets, or weaken readiness checks.

## Codex authentication is missing

**What it means:** ChatGPT device credentials are absent/expired, or API-key mode lacks a valid secret.

**Where to check:** `/readyz` for `codexAuth` and the private service shell.

**Exact safe command:**

```bash
npm run codex:status
```

For ChatGPT mode, enroll with `npm run codex:login`, then rerun the status command.

**Expected result:** Codex reports an authenticated session without printing credentials.

**Do not:** Print, copy, or upload `$CODEX_HOME/auth.json`; do not switch auth modes as an unreviewed fallback.

## Codex capability probe failed

**What it means:** Authentication succeeded, but a configured model/effort/permission pair could not run.

**Where to check:** `/readyz` for `CODEX_CAPABILITY_FAILED`, model variables, and redacted startup logs.

**Exact safe command:**

```bash
npm run typecheck && npm test -- test/unit/capabilities.test.ts
```

**Expected result:** Configuration and offline routing/probe contracts pass. A protected live probe is still required to prove the account/model pair.

**Do not:** Silently downgrade the model or effort, enable reasoning fallback, or broaden sandbox/network permissions.

## Spectrum is disconnected

**What it means:** The persistent `app.messages` stream is not connected or exhausted its bounded restart policy.

**Where to check:** `/readyz` for `SPECTRUM_STREAM_DISCONNECTED` or `SPECTRUM_STREAM_RESTART_EXHAUSTED`, Photon provider status, and redacted logs.

**Exact safe command:**

```bash
npm test -- test/unit/transport/message-loop.test.ts test/unit/transport/spectrum.test.ts
```

**Expected result:** Offline reconnect and provider-narrowing contracts pass. After live credentials recover, `/readyz` returns 200.

**Do not:** Print the Spectrum secret or line address, restore a webhook transport, or create a second messaging SDK.

## Authorized number is rejected

**What it means:** The sender reported by Spectrum does not match an enabled application owner identity or group policy.

**Where to check:** `AGENT_OWNER_HANDLES` format, the sender identity reported through protected diagnostics, and authorization tests.

**Exact safe command:**

```bash
npm test -- test/security/authorization-boundaries.test.ts test/unit/transport/sender-identity.test.ts
```

**Expected result:** E.164/email normalization and both authorization gates pass.

**Do not:** Log or paste the raw handle, authorize every sender, or bypass the second authorization check before process start.

## Agent receives messages but does not reply

**What it means:** Inbound persistence succeeded, but planning, execution, synthesis, or outbound delivery is pending, failed, canceled, or rate-limited.

**Where to check:** `/readyz`, safe correlation IDs in logs, queue/failure counts, and the release smoke record.

**Exact safe command:**

```bash
npm test -- test/chaos/durable-stage-recovery.test.ts test/chaos/outbound-restart.test.ts
```

**Expected result:** Durable reconciliation and outbound cursor invariants pass offline. A live message still requires protected provider evidence.

**Do not:** Manually advance outbound cursors, replay raw queue payloads, delete durable rows, or run Codex inline to bypass the queue.

## Database is unavailable

**What it means:** PostgreSQL could not connect or respond; readiness closes to prevent untracked work.

**Where to check:** Railway PostgreSQL status, the dynamic `DATABASE_URL` reference, and redacted `DATABASE_UNAVAILABLE` logs.

**Exact safe command:**

```bash
npm test -- test/chaos/database-timeout.test.ts
```

**Expected result:** Liveness stays available, readiness becomes 503, and downstream startup does not proceed while the database is unavailable.

**Do not:** Print the database URL, start manual Codex work, truncate tables, or replace PostgreSQL with Supermemory.

## Persistent disk is unavailable

**What it means:** `CODEX_HOME` or the workspace root is missing, overlapping, incorrectly permissioned, or not backed by the intended disk.

**Where to check:** Railway volume attachment and private SSH path metadata.

**Exact safe command:**

```bash
test -d "$CODEX_HOME" && test -d "$AGENT_WORKSPACE_ROOT" && npm test -- test/unit/persistent-storage.test.ts
```

**Expected result:** Both directories exist as separate private paths and storage policy tests pass.

**Do not:** Print directory contents, create credentials on ephemeral storage, recursively change broad filesystem permissions, or delete the disk/workspace tree.

## Supermemory is disabled or degraded

**What it means:** The optional API key is absent, or bounded recall/write operations are unavailable. Operational PostgreSQL state is unaffected.

**Where to check:** `/readyz` for `supermemory: disabled|degraded` and redacted memory receipt/failure codes.

**Exact safe command:**

```bash
npm test -- test/unit/supermemory-client.test.ts test/integration/memory-isolation.test.ts
```

**Expected result:** Disabled mode remains explicit; offline timeout/isolation contracts pass. Live add/search/delete evidence remains separate.

**Do not:** Upload raw messages, use another owner's container, or move queue, authorization, approval, or delivery state into memory.

## Duplicate or partially sent response

**What it means:** An outbound batch stopped between provider acknowledgement and cursor checkpoint, or provider-visible deduplication did not occur.

**Where to check:** Materialized outbound part state, persisted cursor, safe batch/correlation IDs, and provider-visible results.

**Exact safe command:**

```bash
npm test -- test/chaos/outbound-restart.test.ts
```

**Expected result:** Offline retries preserve the same logical client GUID and the cursor only advances after acknowledgement.

**Do not:** Reset the cursor, delete the batch, resend manually, or claim exactly-once delivery. The pinned Spectrum API does not currently accept the application's stable GUID, so a post-acknowledgement crash can duplicate one bubble.

## Still blocked

Record the exact commit, timestamp, redacted readiness state, safe correlation IDs, commands run, and whether any live provider was exercised. Use [Operations](./OPERATIONS.md) for recovery and escalation rules. Never include secrets, owner handles, raw messages, database URLs, private paths, auth files, or full provider exceptions.
