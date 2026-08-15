# Build Your Own iMessage Codex Agent

A production-oriented, single-owner iMessage agent starter built around Photon Spectrum Cloud, Codex, PostgreSQL/pg-boss, and optional Supermemory.

## Repository identity

The canonical GitHub publish target is
[`tecxbro/imessge-agent-railway`](https://github.com/tecxbro/imessge-agent-railway).
After a fresh clone, run `npm run repo:setup-guards`. This enables the versioned
pre-push hook and makes `origin` the default push remote. Before every push, run
`npm run repo:verify-target`; the command and hook both fail closed when the
resolved push URL is any other repository. Never infer the target from a remote
name alone.

## Release status

This branch contains Railway service configuration, database migrations, durable transport/queue/runtime modules, persistent-storage preparation, component readiness, and graceful-shutdown composition. The executable composition is implemented, but this is **not yet a clean-account, zero-to-first-message release**:

- `src/index.ts` defines the final injected boot and shutdown order.
- `src/http/server.ts` implements `/healthz` and `/readyz` for the composed service.
- `src/server.ts`, used by `npm run dev` and `npm start`, now starts the staged PostgreSQL, queue, Codex, optional memory, worker, reconciliation, and Spectrum lifecycle.
- Authorized inbound messages are encrypted and persisted before debounce; plan, execute, synthesize, and outbound jobs run outside the receive loop.
- Offline unit, security, chaos, build, and integration checks cover the composed boundary, but protected Railway/Photon/Codex/Supermemory tests have not been run for this release.
- `spectrum-ts` 12.7 exposes native `space.send(...)` but no caller-supplied delivery GUID. The PostgreSQL cursor prevents normal re-sends, but a process crash after provider acknowledgement and before checkpoint can still duplicate one bubble. Do not claim exactly-once live delivery until Photon exposes and the release validates that capability.

Consequently, the code path is runnable but the release remains gated on clean-account deployment, enrollment, one authorized live turn, restart/replay evidence, and the outbound deduplication limitation above. See [Evidence and release gate](#evidence-and-release-gate).

## Architecture at a glance

```text
Authorized iMessage owner
  ↕
Photon Spectrum Cloud (persistent app.messages gRPC stream)
  ↓
Authorize, deduplicate, persist, and debounce
  ↓
PostgreSQL + pg-boss durable pipeline
  ↓
Interaction Codex thread
  ├─ direct answer
  └─ bounded named execution threads
  ↓
Materialized outbound parts + restart-safe cursor
  ↓
Photon Spectrum Cloud

Successful turn ──> optional curated Supermemory projection
```

PostgreSQL is the operational source of truth. Supermemory is a bounded semantic projection and is never the queue, authorization store, or delivery ledger. Codex credentials and workspaces live in separate directories on the persistent volume.

Read [ARCHITECTURE.md](./ARCHITECTURE.md) for component boundaries, boot/shutdown order, recovery behavior, and extension points.

## Deployment shape

The checked-in [railway.json](./railway.json) configures the application service:

- Railpack with Node.js 22.12.0 pinned in `package.json`;
- `npm ci --include=dev && npm run build`;
- `npm run db:migrate` as the pre-deploy command;
- `npm start` as the start command;
- `/healthz` as the Railway health-check path;
- zero deployment overlap so two versions cannot consume the same Spectrum stream; and
- a 90-second SIGTERM draining window.

Create the project resources in Railway: one application service, one PostgreSQL 18 service, and one volume mounted on the application service at `/var/data`. Set `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `CODEX_HOME=/var/data/codex`, and `AGENT_WORKSPACE_ROOT=/var/data/workspaces`. Keep the application at one replica; the volume-backed credential/workspace design does not support horizontal replication.

The generated Railway URL opens an operator status page—not an iMessage chat link—and shows whether setup is still required. In ChatGPT mode, complete one private Codex device-login step through Railway SSH. Infrastructure provisioning does not authenticate private provider accounts or override the release gate.

## Configuration

Start from [.env.example](./.env.example). The environment loader validates all values together and refuses unsafe or overlapping storage paths.

| Setting | Purpose |
|---|---|
| `SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET` | Photon project with Spectrum Cloud iMessage configured |
| `DATABASE_URL` | PostgreSQL connection; supplied dynamically by Railway |
| `AGENT_OWNER_HANDLES` | Comma-separated E.164 numbers or email addresses allowed to use the private agent |
| `DEPLOYMENT_ID` | Stable installation UUID; preserve the production value during migration; new installs may derive it from `RAILWAY_SERVICE_ID` |
| `APP_ENCRYPTION_KEY` | 32-byte base64 or 64-character hexadecimal application key |
| `CODEX_HOME` | Absolute private directory for Codex config, auth, and sessions |
| `AGENT_WORKSPACE_ROOT` | Separate absolute directory for agent workspaces |
| `CODEX_AUTH_MODE` | `chatgpt` or `api_key` |
| `OPENAI_API_KEY` | Required only in API-key mode |
| `SUPERMEMORY_API_KEY` | Optional; leave empty to disable semantic memory |

Spectrum and `AGENT_OWNER_HANDLES` configure different trust boundaries.
Spectrum's dashboard connects the agent's iMessage line and supplies the project
credentials. `AGENT_OWNER_HANDLES` is this application's separate authorization
allowlist: enter the personal phone number or email address that Spectrum will
report as the sender of an allowed command. Use comma-separated E.164 numbers
and email addresses, such as `+15551234567,owner@example.com`. An unknown sender
is rejected before Codex runs.

Set `SUPERMEMORY_API_KEY` as a Railway service variable to enable semantic memory, or leave it unset to disable memory. For migrated installations, preserve `SUPERMEMORY_CONTAINER_PREFIX` and every non-default model, concurrency, retention, pairing, group, and rate-limit override.

Never commit `.env`, `$CODEX_HOME/auth.json`, provider credentials, database URLs, or workspace data.

## Clean local installation

### Prerequisites

- Node.js 22.12.0.
- PostgreSQL and a database the service can migrate.
- A Photon project configured for Spectrum Cloud iMessage.
- Codex authentication through ChatGPT device auth or an OpenAI API key.
- A Supermemory key only if semantic memory is enabled.

### Install and configure

```bash
git clone https://github.com/tecxbro/imessge-agent-railway.git
cd imessge-agent-railway
cp .env.example .env
npm ci
npm run repo:setup-guards
```

Edit `.env` before continuing:

1. Set the Photon credentials, PostgreSQL URL, and authorized owner handles.
2. Generate `APP_ENCRYPTION_KEY` with `openssl rand -base64 32`.
3. Generate a stable local UUID for `DEPLOYMENT_ID`.
4. Set `CODEX_HOME` and `AGENT_WORKSPACE_ROOT` to two separate, non-overlapping absolute paths. Values such as `$PWD` are not expanded inside `.env`; write the resolved paths.
5. Choose one Codex auth mode below.
6. Leave `SUPERMEMORY_API_KEY` empty if memory should be disabled.

Apply the checked-in forward migrations:

```bash
npm run db:migrate
```

### ChatGPT device-login mode

Set:

```dotenv
CODEX_AUTH_MODE=chatgpt
```

The login script needs the same `CODEX_HOME` as the service. Export its resolved value in the shell, then enroll and verify:

```bash
export CODEX_HOME=/absolute/path/from-your-env-file
npm run codex:login
npm run codex:status
```

The pinned command is `codex login --device-auth`. Treat `$CODEX_HOME/auth.json` as a password. The persistent-storage preparation code requires private directory/file permissions and configures file-backed credentials for headless operation.

### API-key mode

Set:

```dotenv
CODEX_AUTH_MODE=api_key
OPENAI_API_KEY=replace-with-a-secret
```

Do not run device login in this mode. The key is supplied only to the Codex child process through its explicit environment allowlist and must not be written to the persistent volume.

### Validate and start

```bash
npm run typecheck
npm test
npm run test:integration
npm run dev
```

`npm run dev` starts the composed `src/server.ts` entrypoint. It requires the configured PostgreSQL, persistent paths, Codex auth, and Spectrum credentials and exercises the operational startup stages. Check:

```bash
curl --fail http://localhost:10000/healthz
curl --fail http://localhost:10000/readyz
```

`/healthz` means the HTTP process is alive. `/readyz` means all critical components are ready; it remains `503` with redacted remediation while Codex enrollment, database, queue, storage, capabilities, or Spectrum connectivity is incomplete. Do not use a `200` response from `/healthz` as deployment acceptance evidence; `/readyz` must become `200` before message execution.

## Clean Railway deployment

1. Create one Railway project and add a PostgreSQL 18 service.
2. Add the application service from this GitHub repository, select branch `main`, and use `/railway.json` as its config file.
3. Attach one volume to the application service at `/var/data` and keep the service at one replica.
4. Set `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `NODE_ENV=production`, `CODEX_HOME=/var/data/codex`, and `AGENT_WORKSPACE_ROOT=/var/data/workspaces`.
5. Preserve the existing production `DEPLOYMENT_ID` and `APP_ENCRYPTION_KEY`; do not generate replacements during migration.
6. Set the Photon credentials and `AGENT_OWNER_HANDLES` as Railway service variables. Add the optional memory/model/runtime overrides that are enabled in production.
7. For API-key mode, set `CODEX_AUTH_MODE=api_key` and add `OPENAI_API_KEY`; otherwise use `CODEX_AUTH_MODE=chatgpt`.
8. Enable Wait for CI before enabling automatic deployments from `main`.
9. Deploy and verify that the build, pre-deploy migration, start command, and `/healthz` check use the values from `railway.json`.

### Railway post-deploy enrollment

1. Link the Railway project/service locally, then open an interactive session:

   ```bash
   railway ssh
   ```

2. In the Railway SSH session, run:

   ```bash
   npm run codex:login
   ```

3. Open the displayed device-auth URL in a trusted browser, sign in, and enter the one-time code.
4. Back in the Railway SSH session, verify the login:

   ```bash
   npm run codex:status
   ```

5. Restart or redeploy the service so it re-checks Codex authentication and capabilities.

The generated Railway URL is the operator setup and status page, not the iMessage chat endpoint. Chat with the agent through iMessage from an authorized handle.

After enrollment, check `/healthz` and `/readyz`. Do not send a test message until `/readyz` is `200` and the operator page says `Agent ready`. Then send a DM from an authorized handle, confirm exactly one reply, restart the service, and send a follow-up. Record this as protected live evidence; it is not established by the current branch.

In ChatGPT mode, device credentials are stored under `/var/data/codex`. In API-key mode, the key remains a Railway service variable. Railway SSH access should remain private to operators.

## Health, shutdown, and recovery

The root URL is an operator-facing setup/readiness page. It never displays
secrets, handles, provider errors, message content, or filesystem paths. The
final composition boundary starts liveness first, then prepares configuration
and storage, connects the database, checks migrations, starts the queue, probes
Codex auth/capabilities, configures optional memory, and only then starts
Spectrum. Missing or expired Codex auth keeps liveness healthy while readiness
stays false and message execution remains paused.

On `SIGTERM` or `SIGINT`, the shutdown coordinator drops readiness, aborts active work, and runs bounded hooks in this order: Spectrum, Codex, outbound checkpoint, queue, database, then HTTP. A critical cleanup failure produces only a redacted failure code and a nonzero process exit status.

Recovery relies on two durable locations:

- PostgreSQL stores accepted messages, chains, queue state, approvals, thread identifiers/summaries, outbound materialization/cursor state, and memory receipts.
- The persistent volume stores Codex auth/session files and workspaces.

Provider outages must degrade safely: Spectrum reconnects with bounded backoff, PostgreSQL loss makes the service not ready and stops untracked execution, Supermemory recall times out and the turn may continue without memory, memory writes retry independently, and expired Codex auth pauses new execution until re-enrollment.

## Rollback

1. Disable deploys and record the currently running commit and migration level.
2. Back up PostgreSQL before any migration that rewrites encrypted content or identity data.
3. Choose a prior application revision explicitly documented as compatible with the **current** forward schema.
4. Redeploy that revision from Railway. Do not run speculative down migrations and do not delete pg-boss tables, durable messages, outbound cursors, or the persistent volume.
5. Confirm `/healthz`, then inspect `/readyz` and redacted logs before resuming message execution.
6. If Codex credentials were revoked or the volume changed, run `npm run codex:login` and `npm run codex:status` again through Railway SSH.
7. Exercise a non-destructive authorized DM and a restart-recovery turn before calling the rollback healthy.

If an older application is not compatible with the current database schema, roll forward with a compatibility fix instead. Migration-specific compatibility notes live beside the SQL files in `src/db/migrations/`.

## Evidence and release gate

Automated fake/unit/integration tests can establish module invariants such as storage permissions, redacted readiness, bounded shutdown, durable queue singleton keys, stable outbound client GUIDs, and transport reconnect state. They are not substitutes for protected provider tests. Supermemory timeout/outage validation was intentionally skipped by user direction in this release work; the documented behavior remains an expected contract, not evidence.

This branch has no recorded clean-account evidence for:

- a fresh Railway deployment;
- a live Photon/Spectrum authorized DM;
- a live authenticated Codex turn or restart resume; or
- a live Supermemory add/search/delete cycle.

The release gate remains open until a clean-room reviewer completes the local and Railway flows, every failure point in [TEST_PLAN.md](./TEST_PLAN.md), rollback, and restart recovery. Do not describe any provider path as live-working before that evidence exists.

## Documentation

| File | Purpose |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Runtime topology, ownership boundaries, recovery, extension points |
| [DEPLOYMENT_AND_AUTH.md](./DEPLOYMENT_AND_AUTH.md) | Detailed deployment and Codex authentication policy |
| [docs/OPERATIONS.md](./docs/OPERATIONS.md) | Restart, outage, rollback, and credential runbooks |
| [docs/llms.txt](./docs/llms.txt) | LLM-oriented local implementation documentation index |
| [test/e2e/railway-smoke.md](./test/e2e/railway-smoke.md) | Clean local/Railway evidence checklist and release decision |
| [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) | Eight implementation steps and release gates |
| [TEST_PLAN.md](./TEST_PLAN.md) | Unit, integration, protected E2E, chaos, and documentation tests |
| [SECURITY_AND_PRIVACY.md](./SECURITY_AND_PRIVACY.md) | Identity, sandbox, approvals, secrets, retention |
| [SECURITY.md](./SECURITY.md) | Implemented security boundaries, operator checks, and incident response |
| [DATA_MODEL.md](./DATA_MODEL.md) | PostgreSQL schema and durable state model |
| [MODEL_ROUTING.md](./MODEL_ROUTING.md) | Model profiles and capability probing |
| [PROMPTING_AND_ORCHESTRATION.md](./PROMPTING_AND_ORCHESTRATION.md) | Interaction/execution contracts |
| [DECISIONS.md](./DECISIONS.md) | Architecture decision records |
| [DOCS_INDEX.md](./DOCS_INDEX.md) | LLM-friendly primary documentation index |
| [AGENTS.md](./AGENTS.md) | Repository rules for implementation agents |
