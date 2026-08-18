# Operations Runbook

This runbook covers day-two operation of the private single-instance Railway deployment. Initial deployment and enrollment instructions live in [Deployment](./DEPLOYMENT.md). The release smoke record lives in [`../test/e2e/railway-smoke.md`](../test/e2e/railway-smoke.md).

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
- `/readyz` is HTTP 503 during shutdown, missing owner setup, missing/expired Codex auth, database failure, migration/queue failure, invalid volume/workspace storage, or Spectrum disconnect.
- Supermemory may be `disabled` or `degraded` without blocking the operational pipeline.

The public readiness response includes detailed component state, bounded error codes, and remediation actions. The public dashboard also exposes setup status, active device codes and verification URLs, the assigned number, and masked owner state. Treat a raw owner phone, provider credential, database credential, message, unrestricted provider error, or private path in these responses as a security incident.

## Public dashboard access

The dashboard has no login and is public to anyone who can reach the service URL. Same-origin and fetch-metadata checks reduce drive-by cross-site mutations but do not prevent a visitor who opens the dashboard from changing setup. If that exposure is unacceptable, stop the service or put an independently authenticated access-control layer in front of it.

The owner card shows either the setup form or only the masked active phone. The saved personal phone is the only authorized iMessage sender; the separately assigned Photon number is the destination shown at completion. The phone is entered in the dashboard and is not a fresh-deployment environment value.

To replace the owner, open **Change phone number**. U.S. owners can enter a normal 10-digit number without `+1`; international owners select **Not in the U.S.?** and choose their country. Save the new value, then verify one message from the new owner plus rejection of the previous owner. The server stores normalized E.164, and the replacement transaction activates the new encrypted identity and revokes all prior owner-phone identities while leaving collaborator identities unchanged. Never place a phone in a URL, log, or support ticket.

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

Symptoms: `/healthz` 200; public `/readyz` 503; the public dashboard reports Codex authentication needs attention; Spectrum startup remains paused.

ChatGPT mode:

```bash
railway ssh
npm run codex:login
npm run codex:status
```

Complete device login, verify `$CODEX_HOME/auth.json` remains mode `0600`, then restart and rerun capability probes.

API-key mode: replace `OPENAI_API_KEY` in Railway, restart, and rerun capability probes. Do not change `CODEX_AUTH_MODE` as a fallback unless that is an explicit operator decision.

### Owner identity missing or legacy migration required

Symptoms: `/healthz` 200; public `/readyz` 503; Spectrum intake remains stopped; the public dashboard asks for an owner phone.

For a fresh deployment, save the personal owner phone in the dashboard and continue to Photon. U.S. entry defaults to national format; international entry requires a selected country, and the server normalizes both to E.164. For an existing deployment, first verify whether `OWNER_PHONE_NUMBER` or `AGENT_OWNER_HANDLES` is present. The runtime imports only one unambiguous E.164 value and never imports from Photon credentials. If multiple handles or an email-only handle caused migration-required state, open the dashboard and save the intended phone explicitly. Verify the masked status and an authorized message before manually removing old environment values.

### Spectrum disconnect

Symptoms: public `/readyz` 503; the public dashboard or private logs report `SPECTRUM_STREAM_DISCONNECTED` or `SPECTRUM_STREAM_RESTART_EXHAUSTED`.

1. Check Photon provider status and the application service's Spectrum credentials without printing them.
2. Allow the bounded supervised reconnect policy to run.
3. If exhausted, restart after provider recovery.
4. Verify reconciliation and route rehydration from persisted space GUID/route phone.
5. Confirm one authorized DM and check for duplicate outbound parts.

### PostgreSQL timeout/outage

Symptoms: `/healthz` 200; public `/readyz` 503; public readiness or private logs report `DATABASE_UNAVAILABLE`; downstream startup stages do not run.

1. Stop manual message execution.
2. Check Railway PostgreSQL health and the `DATABASE_URL=${{Postgres.DATABASE_URL}}` reference.
3. Restore connectivity and verify migrations.
4. Restart the service.
5. Run reconciliation and inspect safe failure counts/correlation IDs.
6. Confirm queued work resumes exactly once.

### Supermemory timeout/outage

Symptoms: the public dashboard or private logs report memory recall unavailable/degraded; core readiness can remain healthy.

This is the required operating policy. The dedicated memory-provider outage exercise has not been recorded as protected release evidence. Incidental fake-provider coverage in a broad offline suite is not accepted as outage validation.

1. Do not stop operational messaging solely for memory unavailability.
2. Verify planning used an empty memory context rather than stale cross-owner data.
3. Leave projection jobs retryable; inspect redacted receipt/failure codes.
4. After recovery, verify a bounded recall and one temporary add/search/delete smoke item in a test owner container.
5. Never replay raw messages into Supermemory.

### Persistent volume missing or invalid

Symptoms: public `/readyz` 503; public readiness or private logs report `PERSISTENT_STORAGE_INVALID`.

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

## Remove obsolete dashboard credential variables

This release has no dashboard password. Before upgrading an existing service:

1. Open the Railway application service's private **Variables** page.
2. Delete both former dashboard credential variables without exposing their values.
3. Deploy this release. Startup intentionally rejects either obsolete key, even when it is empty.
4. Open the public dashboard and verify owner, Photon, and ChatGPT state.

## Evidence and escalation

Record timestamps, commit, Railway deploy ID, public readiness, redacted diagnostic states, correlation IDs, tests run, and whether a live provider was actually exercised. Never paste raw messages, device codes, secrets, auth files, phone/email handles, or full provider exceptions into incident tickets.

Escalate and keep execution paused when:

- authorization or outbound routing cannot be proven;
- PostgreSQL state is unavailable or inconsistent;
- a stale/canceled chain sends;
- an outbound retry changes client GUID;
- credentials appear in logs or health responses;
- the old application/schema compatibility is unknown; or
- executable composition does not match the reviewed `src/server.ts` and `production-bootstrap.ts` release.
