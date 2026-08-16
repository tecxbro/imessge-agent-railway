# Deploy the iMessage Codex Agent

This guide takes a new Railway project from resource creation to the first authorized iMessage. The executable production runtime is composed. Clean-account Railway deployment and protected live-provider evidence remain separate release checks.

## 1. Railway project

Create exactly:

- one application service sourced from [`tecxbro/imessge-agent-railway`](https://github.com/tecxbro/imessge-agent-railway), branch `main`;
- one Railway PostgreSQL 18 service; and
- one persistent volume mounted on the application service at `/var/data`.

Configure `/railway.json` as the application service's Railway config file and keep the service at one replica. The build runs `npm ci --include=dev && npm run build`, the pre-deploy phase runs `npm run db:migrate`, and the service starts with `npm start`. The generated Railway URL is an operator setup/status page, not an iMessage chat link.

Enable **Wait for CI** before enabling GitHub automatic deployments from `main`.

## 2. Required accounts and credentials

| Requirement | Why it is needed | Where to obtain it |
|---|---|---|
| Railway account | Hosts the service, database, and volume | [Railway](https://railway.com/) |
| Photon account | Creates or connects the Spectrum project, iMessage line, and persistent message stream | Photon dashboard/setup flow |
| Allowed owner phone | Restricts who can command the agent | Your E.164 phone number |
| ChatGPT device login or OpenAI API key | Authenticates Codex | ChatGPT account security or OpenAI Platform |
| Supermemory API key | Optional semantic memory | Supermemory dashboard |

Enter the owner's phone number in E.164 format, such as `+19495550123`. After deployment, the dashboard authenticates Photon, provisions or connects the provider project and line, and persists its private credentials separately from the owner allowlist.

Never place credentials in source control, screenshots, tickets, database rows, Supermemory, or logs.

## 3. Resources and runtime shape

| Resource | Railway shape | Purpose |
|---|---|---|
| Application service | Source repository, `main`, one replica | HTTP setup/status page, queue workers, Codex runtime, Spectrum loop |
| PostgreSQL | PostgreSQL 18 service | Operational source of truth and pg-boss queue |
| Persistent volume | Mounted at `/var/data` | Codex credentials, sessions, Photon credentials, and workspaces |

Review current Railway pricing and quotas before deployment. The volume makes this version single-instance; do not add replicas or remove the volume without redesigning credential and workspace ownership.

`railway.json` controls only the application service's build and deploy behavior. The project owns services, variables, networking, and the volume.

## 4. Application service variables

Set:

| Variable | Required | Value |
|---|---:|---|
| `DATABASE_URL` | Yes | `${{Postgres.DATABASE_URL}}` |
| `NODE_ENV` | Yes | `production` |
| `OWNER_PHONE_NUMBER` | Yes | The owner's actual E.164 phone number |
| `APP_ENCRYPTION_KEY` | Yes | Output of `openssl rand -base64 32` |
| `CODEX_HOME` | Yes | `/var/data/codex` |
| `AGENT_WORKSPACE_ROOT` | Yes | `/var/data/workspaces` |
| `CODEX_AUTH_MODE` | Yes | `chatgpt` or `api_key` |

For migrated installations, preserve the existing `DEPLOYMENT_ID` and `APP_ENCRYPTION_KEY`. A new installation may omit `DEPLOYMENT_ID`; the runtime derives a stable internal UUID from Railway's `RAILWAY_SERVICE_ID`.

Railway injects `PORT`, `RAILWAY_SERVICE_ID`, `RAILWAY_DEPLOYMENT_ID`, and `RAILWAY_VOLUME_MOUNT_PATH`. Do not override them. `SUPERMEMORY_API_KEY`, model profiles, limits, legacy owner handles, and existing Spectrum credentials are optional/advanced settings documented in [Configuration](./CONFIGURATION.md).

## 5. ChatGPT device-login flow

The default mode is `CODEX_AUTH_MODE=chatgpt`.

1. Enable device-code login in the ChatGPT account or workspace if required.
2. Open the deployed Railway application URL.
3. Complete Photon authentication on the agent dashboard.
4. Select **Connect ChatGPT**, open the device-auth popup, sign in, and enter the one-time code.
5. Keep the dashboard open while it verifies the login and prepares Codex.
6. Confirm the dashboard reaches **Your agent is ready** and `/readyz` reports both `codexAuth` and `codexCapabilities` as `ok`.

Credentials persist under `/var/data/codex`. Do not print or copy `$CODEX_HOME/auth.json`. A private Railway SSH session remains an operator recovery path:

```bash
railway ssh
test -f "$CODEX_HOME/auth.json"
chmod 600 "$CODEX_HOME/auth.json"
npm run codex:status
```

If authentication must be restarted from the shell, run `npm run codex:login`, complete the displayed device flow, verify with `npm run codex:status`, then restart the service.

## 6. API-key authentication flow

API-key mode uses OpenAI Platform billing and does not use ChatGPT device login.

1. Add `OPENAI_API_KEY` as a private Railway service variable.
2. Set `CODEX_AUTH_MODE=api_key`.
3. Redeploy the application service.
4. Check `/readyz` for redacted authentication and capability states.

Do not run `npm run codex:login` in this mode. The runtime passes `OPENAI_API_KEY` only to the Codex child process through an explicit allowlist; it must not be written to the volume or logged.

## 7. Readiness verification

Check the generated service URL:

```bash
curl --fail --silent "https://<service-host>/healthz"
curl --silent --show-error "https://<service-host>/readyz"
```

Expected results:

- `/healthz` returns HTTP 200 when the HTTP process is alive.
- `/readyz` returns HTTP 200 only when configuration, storage, PostgreSQL, migrations, queue, Codex authentication, Codex capabilities, and Spectrum are ready.
- `/readyz` returns HTTP 503 with redacted component states when setup is incomplete or a critical dependency is degraded.
- Supermemory may be `disabled` or `degraded` without blocking the operational pipeline.

Do not use `/healthz` as deployment acceptance. Do not expose the full response if it ever includes a credential, owner handle, message, database URL, provider exception, or private filesystem path.

## 8. First-message test

Only start after `/readyz` returns 200.

1. Send a direct iMessage from the configured owner phone number.
2. Confirm one terminal response is delivered.
3. Send from an unauthorized handle and confirm zero Codex child processes start.
4. Restart the Railway application service normally.
5. Wait for `/readyz` to return 200 and send a follow-up.
6. Record the exact commit, Railway deploy ID, timestamps, redacted readiness responses, and provider paths actually exercised in [`../test/e2e/railway-smoke.md`](../test/e2e/railway-smoke.md).

Offline unit, integration, and chaos tests do not prove a live Railway, Photon, Codex, or Supermemory path.

## 9. Updating an existing deployment

1. Review the incoming commit and new migration notes.
2. Confirm a database recovery point exists.
3. Run the repository's required checks, including `npm run docs:check`, `npm run railway:validate`, and the official Railway JSON schema validation.
4. Confirm the reviewed commit is the revision Railway will deploy.
5. Confirm the pre-deploy migration succeeds.
6. Require `/healthz` and `/readyz` to return 200.
7. Run one authorized non-mutating message and one restart follow-up.

Add new service variables before deploying. Preserve installation identity, encryption keys, provider credentials, PostgreSQL state, and the persistent volume during updates.

## 10. Rollback

Application rollback and schema rollback are separate decisions.

1. Stop new execution and allow graceful shutdown to checkpoint state.
2. Record the current and target application commits.
3. Read every intervening migration `.notes.md` file.
4. Deploy the prior revision only if it is compatible with the current schema.
5. Preserve PostgreSQL, pg-boss state, the persistent volume, and outbound cursors.
6. Restart, run reconciliation, verify both health endpoints, and send one authorized non-mutating message.

Do not run an improvised down migration or delete pg-boss tables, durable messages, outbound cursors, Codex credentials, or workspaces. If compatibility is uncertain, roll forward with a fix or restore application and database together to a matched recovery point.

For incident and provider-outage procedures, use [Operations](./OPERATIONS.md). For visible deployment failures, use [Troubleshooting](./TROUBLESHOOTING.md).
