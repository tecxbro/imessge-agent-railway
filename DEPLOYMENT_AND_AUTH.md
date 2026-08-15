# Deployment and Codex Authentication

**Last verified against official documentation:** August 15, 2026

## 1. Deployment contract and present limitation

The intended deployment is one private Railway application service, one Railway PostgreSQL 18 service, and one persistent volume mounted at `/var/data`. [`railway.json`](./railway.json) controls the application service build/deploy settings; Railway project resources, variables, replica count, GitHub source, and volume attachment are configured in the Railway project. The operator still provides private provider credentials and, in ChatGPT mode, completes one Codex device-login flow.

This branch does **not** yet prove a clean first-message Railway deployment. `npm start` runs the composed `src/server.ts` lifecycle, but production acceptance still requires migrated data, preserved installation secrets, live provider credentials, `/readyz`, one authorized message, and restart evidence.

Current verification boundaries:

- No clean Railway deployment was performed from this branch.
- No live Photon, Codex, or Supermemory path was exercised as part of this hosting migration.
- The dedicated memory-provider outage/Supermemory-timeout resilience exercise was intentionally not run by user direction. Any fake-provider assertion reached by a broad offline suite is not accepted as outage validation; the behavior in this guide remains required policy.
- The Railway CLI is not installed in the current local environment. `railway.json` is validated by unit tests and CI against Railway's official JSON schema; no Railway project was created or linked in this migration pass.
- Passing fake-provider, unit, integration, or chaos tests is not evidence that a provider works live.

Use [`test/e2e/railway-smoke.md`](./test/e2e/railway-smoke.md) to capture reviewer-owned evidence rather than turning an expected behavior into an unsupported claim.

## 2. Provisioned topology

The checked-in service configuration declares:

- Railpack and the exact build command.
- `npm run db:migrate` as the pre-deploy command.
- `npm start` as the start command.
- `/healthz` as Railway's health-check path.
- Zero overlap between old and new deployments.
- A 90-second SIGTERM draining window.

The Railway project must separately contain exactly one application service, one PostgreSQL 18 service, and one volume attached to the application at `/var/data`. Configure one application replica. Do not remove the volume or increase replicas without redesigning credential and workspace ownership.

## 3. Configuration and secret inventory

Start from [`.env.example`](./.env.example). Required values are validated at process start.

| Variable | Local source | Railway source | Secret |
|---|---|---|---|
| `SPECTRUM_PROJECT_ID` | operator | service variable | yes |
| `SPECTRUM_PROJECT_SECRET` | operator | service variable | yes |
| `DATABASE_URL` | local PostgreSQL | `${{Postgres.DATABASE_URL}}` | yes |
| `AGENT_OWNER_HANDLES` | operator | service variable | private |
| `DEPLOYMENT_ID` | operator-generated UUID | preserve existing value; new installs may derive it from `RAILWAY_SERVICE_ID` | no |
| `APP_ENCRYPTION_KEY` | `openssl rand -base64 32` | preserve existing exact value | yes |
| `CODEX_HOME` | absolute private path | `/var/data/codex` | contains secrets |
| `AGENT_WORKSPACE_ROOT` | separate absolute path | `/var/data/workspaces` | may contain private data |
| `CODEX_AUTH_MODE` | `chatgpt` or `api_key` | service variable | no |
| `OPENAI_API_KEY` | only for API-key mode | service variable, only for API-key mode | yes |
| `SUPERMEMORY_API_KEY` | optional | service variable; absence disables memory | yes |

`CODEX_HOME` and `AGENT_WORKSPACE_ROOT` must be absolute, separate, non-overlapping directories. Startup creates them with mode `0700`, validates directory type/mode plus read/write/execute access, and maintains `$CODEX_HOME/config.toml` with mode `0600`. File-based Codex credentials are required in a headless container.

The Spectrum dashboard and `AGENT_OWNER_HANDLES` do not configure the same
identity. Spectrum connects the agent's iMessage line. `AGENT_OWNER_HANDLES`
configures the application's sender allowlist and must contain the personal
E.164 phone number or email address that Spectrum reports for each person
allowed to command the agent. Multiple entries are comma-separated. The
application rejects any other sender before a model or child process runs.

Supermemory is disabled when `SUPERMEMORY_API_KEY` is absent. Add or rotate the service variable and redeploy to change this. Core readiness does not depend on it. Preserve `SUPERMEMORY_CONTAINER_PREFIX` during migration so the installation continues to use the same memory namespace.

Do not put credentials in PostgreSQL, Supermemory, job payloads, or logs. Do not print `auth.json` to diagnose authentication.

## 4. Codex authentication modes

Codex supports ChatGPT subscription authentication and OpenAI API-key authentication. The application never silently changes modes.

### 4.1 ChatGPT device login

Device-code authentication is the preferred headless flow and is currently marked beta in the official Codex documentation.

1. Enable device-code login in the ChatGPT account security settings, or have the ChatGPT workspace administrator enable it.
2. Ensure `CODEX_AUTH_MODE=chatgpt` and `CODEX_HOME` points to private persistent storage.
3. In the same environment as the service, run:

   ```bash
   npm run codex:login
   npm run codex:status
   ```

   `npm run codex:login` invokes `codex login --device-auth`. Open the displayed URL in a trusted browser, sign in, and enter the one-time code.
4. Confirm `$CODEX_HOME/auth.json` exists and is restricted:

   ```bash
   test -f "$CODEX_HOME/auth.json"
   chmod 600 "$CODEX_HOME/auth.json"
   npm run codex:status
   ```

5. Restart the service. In the fully composed service, `/readyz` must show both `codexAuth` and `codexCapabilities` as `ok` before Spectrum intake begins.

Codex normally refreshes active ChatGPT tokens automatically. A revoked or unusable session still requires re-enrollment. Treat `auth.json` like a password: do not copy it into source control, tickets, chat, logs, PostgreSQL, or Supermemory.

### 4.2 API-key mode

API-key mode uses OpenAI Platform usage-based billing and the API organization's data controls. It does not use included ChatGPT subscription credits.

Set:

```dotenv
CODEX_AUTH_MODE=api_key
OPENAI_API_KEY=<Railway service variable or local secret>
```

The application passes `OPENAI_API_KEY` only across the explicit Codex child-process boundary. It does not require a ChatGPT device login and must not pass the key to unrelated subprocesses. Do not put the value directly in `railway.json` or commit it to `.env`.

The official Codex CLI also supports `printenv OPENAI_API_KEY | codex login --with-api-key`, but this starter does not require that cache-writing flow in application API-key mode. The runtime supplies the key directly. Use `codex login status` only when diagnosing an intentionally cached standalone CLI login.

To change a Railway deployment from ChatGPT mode to API-key mode:

1. Add `OPENAI_API_KEY` as a Railway service variable.
2. Set `CODEX_AUTH_MODE=api_key`.
3. Redeploy/restart the service.
4. Verify the redacted capability probe and `/readyz`; never verify by printing the key.

To rotate the key, replace the secret, restart, run the protected Codex capability test, and revoke the old key after the replacement succeeds.

## 5. Clean local installation

### Prerequisites

- Node.js 22.12.0.
- npm compatible with the checked-in lockfile.
- PostgreSQL 13 or newer; PostgreSQL 18 matches the Railway target.
- A Photon project with Spectrum Cloud iMessage configured for any live transport test.
- A ChatGPT account/workspace with device login enabled, or an OpenAI Platform API key.
- A Supermemory API key only when semantic memory is enabled.

### Install and configure

From a fresh checkout of the release under review:

```bash
npm ci
cp .env.example .env
pwd -P
mkdir -p .codex-agent .agent-workspaces
chmod 700 .codex-agent .agent-workspaces
openssl rand -base64 32
```

Edit `.env` once. Set `CODEX_HOME` and `AGENT_WORKSPACE_ROOT` to the absolute paths printed by `pwd -P`; `.env` does not expand `$HOME`, `$PWD`, or shell command substitutions. Generate `DEPLOYMENT_ID` with an operating-system UUID utility or a trusted UUID v4/v5 generator. Set the generated encryption key, owner handles, Photon values, and database URL.

For a disposable local PostgreSQL 18 container:

```bash
docker run --name imessage-agent-postgres \
  -e POSTGRES_DB=imessage_agent \
  -e POSTGRES_USER=agent \
  -e POSTGRES_PASSWORD=local-only-change-me \
  -p 127.0.0.1:5432:5432 \
  -d postgres:18
```

Use this matching local URL in `.env`:

```dotenv
DATABASE_URL=postgresql://agent:local-only-change-me@127.0.0.1:5432/imessage_agent
```

Then run:

```bash
npm run typecheck
npm test
npm run db:migrate
```

For database-backed integration tests, use a separate disposable database because the suite truncates application tables:

```bash
createdb -h 127.0.0.1 -U agent imessage_agent_test
POSTGRES_PIPELINE_TEST_DATABASE_URL=postgresql://agent:local-only-change-me@127.0.0.1:5432/imessage_agent_test npm run test:integration
```

Enroll ChatGPT with the commands in section 4.1, or configure API-key mode. Start the service:

```bash
npm run dev
curl --fail --silent http://127.0.0.1:10000/healthz
curl --silent --show-error http://127.0.0.1:10000/readyz
```

The second request returns HTTP 200 only when every critical component is ready. Do not treat a 200 from `/healthz` as proof that the queue, Codex, Spectrum, or memory path is ready.

## 6. Clean Railway deployment

Use the [official Railway service setup](https://docs.railway.com/guides/services) against the reviewed commit containing `railway.json`.

1. Create a Railway project with one application service sourced from this repository's `main` branch.
2. Set the application config file path to `/railway.json` and keep one replica.
3. Add one PostgreSQL 18 service. Verify its major version before migration; do not change database majors during this hosting cutover.
4. Attach one volume to the application service at `/var/data`.
5. Set `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `NODE_ENV=production`, `CODEX_HOME=/var/data/codex`, and `AGENT_WORKSPACE_ROOT=/var/data/workspaces`.
6. Set `DEPLOYMENT_ID` and `APP_ENCRYPTION_KEY` to the exact existing production values. Copy the Photon, owner, auth, memory, model, concurrency, retention, pairing, group, and rate-limit configuration that is active in production.
7. Enable Wait for CI before enabling automatic deployments from `main`.
8. Deploy. The build must run `npm ci --include=dev && npm run build`; pre-deploy must run `npm run db:migrate`; start must run `npm start`; and the deployment health check must use `/healthz`.
9. Confirm the application has one replica and `/var/data/codex` plus `/var/data/workspaces` are writable only by the service account.
10. Open the generated Railway URL. It must identify itself as the operator status page and must not claim `Agent ready` before enrollment is complete.
11. Verify `GET /healthz` returns HTTP 200. Do not expect `/readyz` to pass before Codex authentication and all critical dependencies are ready.
12. For ChatGPT mode, open Railway SSH:

   ```bash
   railway ssh
   npm run codex:login
   npm run codex:status
   ```

   Complete the device-code flow in a trusted browser, restart the application service, and verify authentication survives the restart.
13. For API-key mode, add `OPENAI_API_KEY` as a Railway service variable, set `CODEX_AUTH_MODE=api_key`, and redeploy. Do not run device login.
14. Require `/readyz` HTTP 200 before sending the first authorized message.

## 7. Health and readiness

The composed health application defines:

```text
GET /         -> 200 operator setup/readiness page; never the iMessage conversation
GET /healthz -> 200 {"status":"ok"}
GET /readyz  -> 200 when all critical components are ready
GET /readyz  -> 503 with redacted component states and safe operator actions otherwise
```

Critical readiness components are configuration, database, migrations, queue, Spectrum, Codex authentication, Codex capabilities, persistent volume, and workspace. Supermemory is optional at turn time and may be `disabled` or `degraded` without making operational state unsafe.

Railway intentionally probes `/healthz`, not `/readyz`. Missing Codex enrollment or a provider outage should keep the process available for private remediation while `/readyz` refuses message execution. The generated public URL is therefore only an operator status surface; it explicitly distinguishes infrastructure liveness from agent readiness. None of these endpoints may include secrets, raw provider errors, handles, database URLs, arbitrary filesystem paths, or message content.

Useful checks:

```bash
curl --fail --silent "https://<service-host>/healthz"
curl --silent --show-error "https://<service-host>/readyz"
```

Save the response after redaction. HTTP 503 from `/readyz` is expected during initial ChatGPT enrollment or a critical outage; follow the returned `actions` without exposing provider diagnostics.

## 8. Migrations and application rollback

`npm run db:migrate` applies checked-in Drizzle migrations. Railway runs it as `preDeployCommand`, after build and before the new process starts. Migration failure must stop deployment.

Before each release:

1. Record the outgoing application commit.
2. Read every new `src/db/migrations/*.notes.md` file.
3. Confirm the outgoing release is compatible with the post-migration schema.
4. Create or verify a Railway PostgreSQL backup according to the database plan.
5. Run the migration in staging and record duration/locks.

### Hosting cutover

Before changing providers, capture the exact production `DEPLOYMENT_ID`, `APP_ENCRYPTION_KEY`, Photon credentials, owner handles, auth mode, optional provider keys, memory namespace, and every non-default runtime override. When the configured deployment ID is uncertain, read the installation identity from the production database:

```sql
SELECT id
FROM deployments
ORDER BY created_at ASC
LIMIT 1;
```

Never generate a replacement encryption key for migrated data. A different key makes retained encrypted messages, route data, and thread data unreadable.

Perform a dry run before cutover:

1. Create the Railway PostgreSQL target.
2. Export the production database in custom format with `pg_dump`.
3. Restore it with `pg_restore`.
4. Compare schema, extensions, migrations, deployment identity, and table row counts.
5. Discard or reset the dry-run target before the final restore.

For the final cutover:

1. Stop the legacy application service and confirm its Spectrum consumer is gone.
2. Take the final database dump.
3. Restore it into a clean Railway PostgreSQL database.
4. Verify deployment, owner, space, undrained-message, active-chain, queued-job, and outbound-cursor state.
5. Deploy the Railway application with the preserved values.
6. Require `/healthz` HTTP 200, complete ChatGPT enrollment through Railway SSH when needed, restart, and require `/readyz` HTTP 200.
7. Send one message from an authorized owner and confirm exactly one inbound message, one chain, and one outbound delivery.
8. Redeploy once and confirm Codex authentication and workspace storage survive.

Never run the legacy and Railway application services against the same Spectrum project at the same time. If acceptance fails, stop Railway and confirm its Spectrum process is gone before restarting the legacy service. Keep the legacy database untouched until Railway acceptance and a final backup are complete.

After acceptance, remove the legacy custom domains, deploy hooks, repository integration, tokens, application service, persistent storage, database, and retained secret copies. Verify the retired platform no longer has repository access.

Application rollback:

1. Set the service unavailable for new execution and wait for graceful shutdown.
2. Roll back to the recorded Railway deploy/commit **only if its migration notes declare compatibility with the current schema**.
3. Leave forward-compatible schema additions in place.
4. Restart and verify `/healthz`, `/readyz`, queue reconciliation, outbound cursors, and one authorized non-mutating turn.

Schema rollback is separate and is never implied by application rollback. Use the exact SQL in the affected migration's `.notes.md` only after stopping workers and taking a verified backup/recovery point. Migration `0000` rollback is destructive and abandons application state; do not drop the `pgboss` schema unless queued work is intentionally abandoned. Migration `0001` rebuilds an index and briefly locks `memory_sync_events`.

If the old application is not compatible with the current schema, roll forward with a fixed release or restore the database and application together to a matched recovery point. Never improvise a down migration in production.

## 9. Restart and provider-outage behavior

The durable source of truth is PostgreSQL. Codex files and workspaces on the volume support continuity but do not replace database recovery records.

### Graceful restart

On `SIGTERM`/`SIGINT`, the composed bootstrap marks readiness false and aborts active work. Registered hooks then stop Spectrum, stop Codex work, checkpoint outbound state, stop the queue, close the database, and close HTTP. `railway.json` configures a 90-second draining window, but recovery must remain safe if the platform terminates the process before every hook completes. A critical cleanup failure makes the shutdown result non-clean.

After restart, run durable pipeline reconciliation before accepting new work. It reschedules undrained inbound spaces, queued planning chains, and resumable outbound batches using stable singleton keys.

### Hard process loss

- An accepted inbound row remains durable even if debounce scheduling fails; reconciliation reschedules it.
- Repeated debounce/plan/synthesis/send enqueue attempts reuse singleton keys.
- Outbound batches resume from the persisted cursor. A retry after provider acknowledgement reuses the same stable client GUID.
- A missing Codex session starts a replacement thread from the bounded PostgreSQL recovery summary; it must not delete unrelated threads or memory.

These are tested invariants in fakes and database tests, not proof of live provider deduplication.

### Spectrum/Photon disconnect

Readiness becomes degraded. The supervised stream retries with bounded backoff. Durable accepted work remains in PostgreSQL. After retries are exhausted, inspect Photon status/credentials and restart; never log the provider error or line address. No live Photon outage was exercised in this documentation pass.

### PostgreSQL timeout/outage

`/healthz` stays live, `/readyz` becomes 503 with `DATABASE_UNAVAILABLE`, and startup does not continue to migrations, queues, Codex, memory, or Spectrum. Restore connectivity, verify the database, rerun migrations if required, then restart and reconcile. Do not run untracked Codex work while PostgreSQL is unavailable.

### Supermemory timeout/outage

Recall degrades to an empty, explicitly unavailable memory context and planning continues. Post-response projection failures are recorded with safe error codes and retried according to queue policy; they do not roll back a delivered operational response. Never move authorization, delivery, or retry state into Supermemory.

The dedicated resilience exercise was intentionally skipped by user direction. Keep the release evidence for this item `NOT RUN` unless a later authorized run executes it; incidental fake-provider coverage in a broad suite is not live or outage validation.

### Expired/revoked Codex authentication

The composed service stays live but not ready, does not start Spectrum intake, and surfaces `CODEX_AUTH_EXPIRED` with a safe action. Durable queued state remains. In ChatGPT mode, rerun `npm run codex:login` and `npm run codex:status`; in API-key mode, replace the secret. Restart and require the configured model/effort capability probes to pass before resuming.

### Persistent volume loss

Stop execution. Attach or repair the correct volume, or provision replacement private storage, then re-enroll Codex and recreate workspaces from trusted remotes/backups. Resume threads from bounded PostgreSQL summaries. Rotate or revoke credentials if volume exposure is possible.

## 10. Release evidence

Before release, attach:

- The exact reviewed commit and `railway.json` validation output.
- Clean local and clean Railway evidence from [`test/e2e/railway-smoke.md`](./test/e2e/railway-smoke.md).
- `npm run typecheck`, `npm test`, `npm run test:integration`, and `npm run test:chaos` output, with skipped database/live tests identified.
- Migration and rollback compatibility notes.
- Redacted `/healthz` and `/readyz` responses before and after restart.
- Protected live test output only for providers actually exercised.
- Known limitations, especially any untested live-provider or database-backed path.

Do not state that Railway, Photon, Codex, or Supermemory works live unless the corresponding protected live test was executed and its redacted evidence is attached.

## 11. Primary sources

- [Official Codex authentication](https://learn.chatgpt.com/docs/auth.md)
- [Official Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference.md)
- [Railway Config as Code reference](https://docs.railway.com/config-as-code/reference)
- [Railway volumes](https://docs.railway.com/volumes/reference)
- [Railway health checks](https://docs.railway.com/deployments/healthchecks)
- [Railway PostgreSQL](https://docs.railway.com/databases/postgresql)
- [Railway GitHub autodeploys and Wait for CI](https://docs.railway.com/deployments/github-autodeploys)
- [Photon Spectrum documentation index](https://photon.codes/docs/llms.txt)
- [Supermemory documentation index](https://supermemory.ai/docs/llms.txt)
