# Operations Runbook

This runbook covers day-two operation of the private single-instance Railway deployment. Deployment and enrollment instructions live in [`../DEPLOYMENT_AND_AUTH.md`](../DEPLOYMENT_AND_AUTH.md). The release smoke record lives in [`../test/e2e/railway-smoke.md`](../test/e2e/railway-smoke.md).

## Current release gate

`npm start` runs the composed lifecycle through `src/server.ts` and `src/runtime/production-bootstrap.ts`. Keep the release blocked until `/readyz` is `200`, an authorized live DM receives one reply, restart/replay checks are recorded, and the remaining Spectrum 12.7 outbound GUID limitation is accepted or removed. A healthy `/healthz` alone is insufficient.

## Routine checks

Run from a trusted operator environment:

```bash
curl --fail --silent "https://<service-host>/healthz"
curl --silent --show-error "https://<service-host>/readyz"
```

Expected composed-service states:

- `/healthz` is HTTP 200 whenever the Node process can serve diagnostics.
- `/readyz` is HTTP 200 only when every critical component is `ok`.
- `/readyz` is HTTP 503 during shutdown, missing/expired Codex auth, database failure, migration/queue failure, invalid volume/workspace storage, or Spectrum disconnect.
- Supermemory may be `disabled` or `degraded` without blocking the operational pipeline.

Readiness responses are public and redacted. If a response contains a credential, owner handle, provider error, message, database URL, or private path, treat that as a security incident.

## Deploy procedure

1. Record the outgoing application commit and current `/readyz` response.
2. Read new migration notes and confirm backward compatibility.
3. Confirm a database recovery point exists.
4. Validate `railway.json` behavior and the official schema:

   ```bash
   npm run railway:validate
   check-jsonschema --schemafile https://railway.com/railway.schema.json railway.json
   ```

5. Confirm Wait for CI is enabled for the `main` deployment trigger.
6. Run the required local test suite and record skipped tests.
7. Deploy the reviewed commit. Confirm the pre-deploy migration succeeds before the service starts.
8. Require `/healthz` HTTP 200 and `/readyz` HTTP 200.
9. Send one authorized, non-mutating test message only after readiness passes.
10. Restart the service and repeat readiness plus one follow-up turn.

## Graceful restart

Railway sends `SIGTERM`; `railway.json` allows 90 seconds before `SIGKILL`. The composed bootstrap marks readiness false and aborts active work before running stop hooks in this order:

1. Spectrum receive loop.
2. Active Codex work.
3. Outbound cursor checkpoint.
4. pg-boss workers.
5. PostgreSQL connections.
6. HTTP listener.

After restart, require reconciliation of undrained inbound messages, queued planning chains, and resumable outbound batches before readiness returns to 200. Verify no stale chain sends and no outbound cursor moves backward.

## Incident playbooks

### Codex auth missing or expired

Symptoms: `/healthz` 200; `/readyz` 503; `codexAuth` is `missing` or `failed`; Spectrum startup remains paused.

ChatGPT mode:

```bash
railway ssh
npm run codex:login
npm run codex:status
```

Complete device login, verify `$CODEX_HOME/auth.json` remains mode `0600`, then restart and rerun capability probes.

API-key mode: replace `OPENAI_API_KEY` in Railway, restart, and rerun capability probes. Do not change `CODEX_AUTH_MODE` as a fallback unless that is an explicit operator decision.

### Spectrum disconnect

Symptoms: `/readyz` 503; `spectrum` is `degraded`; code is `SPECTRUM_STREAM_DISCONNECTED` or `SPECTRUM_STREAM_RESTART_EXHAUSTED`.

1. Check Photon provider status and the application service's Spectrum credentials without printing them.
2. Allow the bounded supervised reconnect policy to run.
3. If exhausted, restart after provider recovery.
4. Verify reconciliation and route rehydration from persisted space GUID/route phone.
5. Confirm one authorized DM and check for duplicate outbound parts.

### PostgreSQL timeout/outage

Symptoms: `/healthz` 200; `/readyz` 503 with `DATABASE_UNAVAILABLE`; downstream startup stages do not run.

1. Stop manual message execution.
2. Check Railway PostgreSQL health and the `DATABASE_URL=${{Postgres.DATABASE_URL}}` reference.
3. Restore connectivity and verify migrations.
4. Restart the service.
5. Run reconciliation and inspect safe failure counts/correlation IDs.
6. Confirm queued work resumes exactly once.

### Supermemory timeout/outage

Symptoms: memory recall is explicitly unavailable/degraded; core readiness can remain healthy.

This is the required operating policy. The dedicated Step 8 memory-provider outage exercise was intentionally skipped by user direction. Incidental fake-provider coverage in a broad offline suite is not accepted as outage validation.

1. Do not stop operational messaging solely for memory unavailability.
2. Verify planning used an empty memory context rather than stale cross-owner data.
3. Leave projection jobs retryable; inspect redacted receipt/failure codes.
4. After recovery, verify a bounded recall and one temporary add/search/delete smoke item in a test owner container.
5. Never replay raw messages into Supermemory.

### Persistent volume missing or invalid

Symptoms: `/readyz` 503 with `PERSISTENT_STORAGE_INVALID`.

1. Stop execution; do not create replacement Codex threads on ephemeral storage.
2. Verify the `/var/data` mount, ownership, space, and directory permissions.
3. If the volume is lost, revoke potentially exposed credentials, attach replacement storage, and re-enroll Codex.
4. Recreate workspaces from trusted remotes/backups.
5. Resume from bounded PostgreSQL summaries.

### Partial outbound batch

1. Do not reset the outbound cursor manually.
2. Restore Spectrum connectivity.
3. Let the resumable batch job claim the persisted `start_index`.
4. Confirm every retry uses the materialized part's original client GUID.
5. Compare database part states with visible provider results; preserve evidence of any provider-level duplicate.

## Rollback

Roll back application and schema independently.

1. Stop new execution and let graceful shutdown checkpoint state.
2. Select the last known-good application commit compatible with the **current** schema.
3. Roll back the Railway deploy to that commit.
4. Do not undo forward-compatible migrations merely to match code.
5. If schema rollback is mandatory, stop all workers, verify a backup/recovery point, and use only the SQL in the migration's `.notes.md`.
6. Restart, reconcile, verify both health endpoints, and run a non-mutating authorized turn.

If compatibility is uncertain, roll forward with a fix or restore the application and database together to a matched recovery point. The initial migration rollback is destructive and must not be used on a live database without an explicit data-loss decision.

## Auth transfer and re-enrollment

When ownership changes or a credential may be exposed:

1. Stop the service.
2. Revoke the old ChatGPT session/API key and rotate Photon, Supermemory, encryption, and database credentials as applicable.
3. Remove only the compromised Codex auth file after confirming the exact persistent path; do not delete the volume or workspace tree.
4. Run the appropriate enrollment flow.
5. Verify credential file permissions, status, capability probes, restart persistence, and readiness.
6. Review failure/audit logs for unexpected use, without copying private payloads.

## Evidence and escalation

Record timestamps, commit, Railway deploy ID, redacted readiness states, correlation IDs, tests run, and whether a live provider was actually exercised. Never paste raw messages, secrets, auth files, phone/email handles, or full provider exceptions into incident tickets.

Escalate and keep execution paused when:

- authorization or outbound routing cannot be proven;
- PostgreSQL state is unavailable or inconsistent;
- a stale/canceled chain sends;
- an outbound retry changes client GUID;
- credentials appear in logs or health responses;
- the old application/schema compatibility is unknown;
