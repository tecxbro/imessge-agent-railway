# Deploy the iMessage Codex Agent

This guide takes a new Railway project from resource creation to the first authorized iMessage. The executable production runtime is composed. Clean-account Railway deployment and protected live-provider evidence remain separate release checks.

## 1. Railway project

Create exactly:

- one application service sourced from [`tecxbro/imessge-agent-railway`](https://github.com/tecxbro/imessge-agent-railway), branch `main`;
- one Railway PostgreSQL 18 service; and
- one persistent volume mounted on the application service at `/var/data`.

Configure `/railway.json` as the application service's Railway config file and keep the service at one replica. The build runs `npm ci --include=dev && npm run build`, the pre-deploy phase runs `npm run db:migrate`, and the service starts with `npm start`. The generated Railway URL is a public setup entry point, not an iMessage chat link.

Enable **Wait for CI** before enabling GitHub automatic deployments from `main`.

## 2. Required accounts and credentials

| Requirement | Why it is needed | Where to obtain it |
|---|---|---|
| Railway account | Hosts the service, database, and volume | [Railway](https://railway.com/) |
| Photon account | Creates or connects the Spectrum project, iMessage line, and persistent message stream | Photon dashboard/setup flow |
| Allowed owner phone | Restricts who can command the agent | Your personal phone number |
| ChatGPT device login or OpenAI API key | Authenticates Codex | ChatGPT account security or OpenAI Platform |
| Supermemory API key | Optional semantic memory | Supermemory dashboard |

In the dashboard, U.S. owners enter a normal 10-digit phone number; `+1` is added automatically, though pasting a complete `+1` number also works. International owners select **Not in the U.S.?**, choose their country, and enter either a national or complete international number. The server validates the selected country and stores only normalized E.164. The result becomes the only authorized sender and the phone registered during Photon owner provisioning. Photon separately assigns the iMessage destination displayed at completion.

Never place credentials in source control, screenshots, tickets, database rows, Supermemory, or logs.

## 3. Resources and runtime shape

| Resource | Railway shape | Purpose |
|---|---|---|
| Application service | Source repository, `main`, one replica | Public setup dashboard, health HTTP, queue workers, Codex runtime, Spectrum loop |
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
| `APP_ENCRYPTION_KEY` | Yes | Output of `openssl rand -base64 32` |
| `CODEX_HOME` | Yes | `/var/data/codex` |
| `AGENT_WORKSPACE_ROOT` | Yes | `/var/data/workspaces` |
| `CODEX_AUTH_MODE` | Yes | `chatgpt` or `api_key` |

For migrated installations, preserve the existing `DEPLOYMENT_ID` and `APP_ENCRYPTION_KEY`. A new installation may omit `DEPLOYMENT_ID`; the runtime derives a stable internal UUID from Railway's `RAILWAY_SERVICE_ID`.

Railway injects `PORT`, `RAILWAY_SERVICE_ID`, `RAILWAY_DEPLOYMENT_ID`, and `RAILWAY_VOLUME_MOUNT_PATH`. Do not override them. Fresh deployments do not set an owner phone or dashboard credential service variable; the phone stays in the dashboard. `SUPERMEMORY_API_KEY`, limits, legacy owner inputs, and existing Spectrum credentials are optional/advanced settings documented in [Configuration](./CONFIGURATION.md). Model and reasoning settings are stored through **Advanced** in the dashboard.

## 5. Public setup dashboard

1. Open the deployed Railway application URL in a trusted browser.
2. Save the owner's phone, complete Photon setup, and then complete ChatGPT setup.
3. After ChatGPT connects, open **Advanced** and confirm or change the deployment model and reasoning effort.

There is no dashboard password or operator session. Anyone who can reach the public service URL can view setup status, device codes, verification URLs, assigned number, masked owner status, bounded error codes, and detailed readiness, and can deliberately submit setup changes. A matching `Origin` and non-cross-site fetch context block ordinary drive-by cross-site mutations, but they do not authenticate a visitor.

Owner status returns only a masked phone, and the write route never echoes the submitted raw number. Photon setup is unavailable until an owner is stored. Raw provider credentials, project secrets, Codex credentials, database credentials, and unrestricted provider errors remain server-side.

## 6. ChatGPT device-login flow

The default mode is `CODEX_AUTH_MODE=chatgpt`.

1. Enable device-code login in the ChatGPT account or workspace if required.
2. Open the deployed Railway application URL.
3. Save the owner phone and complete Photon authentication on the public agent dashboard.
4. Select **Connect ChatGPT**, open the device-auth popup, sign in, and enter the one-time code.
5. Keep the dashboard open. It closes the popup when the browser permits, returns focus to setup, and shows Codex preparing.
6. Confirm the dashboard reaches **Your agent is ready** and public `/readyz` returns HTTP 200.

Credentials persist under `/var/data/codex`. Do not print or copy `$CODEX_HOME/auth.json`. A private Railway SSH session remains an operator recovery path:

```bash
railway ssh
test -f "$CODEX_HOME/auth.json"
chmod 600 "$CODEX_HOME/auth.json"
npm run codex:status
```

If authentication must be restarted from the shell, run `npm run codex:login`, complete the displayed device flow, verify with `npm run codex:status`, then restart the service.

## 7. API-key authentication flow

API-key mode uses OpenAI Platform billing and does not use ChatGPT device login.

1. Add `OPENAI_API_KEY` as a private Railway service variable.
2. Set `CODEX_AUTH_MODE=api_key`.
3. Redeploy the application service.
4. Check the public dashboard or `/readyz` for authentication and capability state.

Do not run `npm run codex:login` in this mode. The runtime passes `OPENAI_API_KEY` only to the Codex child process through an explicit allowlist; it must not be written to the volume or logged.

## 8. Readiness verification

Check the generated service URL:

```bash
curl --fail --silent "https://<service-host>/healthz"
curl --silent --show-error "https://<service-host>/readyz"
```

Expected results:

- `/healthz` returns HTTP 200 when the HTTP process is alive.
- `/readyz` returns HTTP 200 only when configuration, storage, PostgreSQL, migrations, queue, owner identity, Codex authentication, Codex capabilities, and Spectrum are ready.
- `/readyz` returns HTTP 503 with a detailed component snapshot and bounded remediation actions when setup is incomplete or a critical dependency is degraded.
- A fresh deployment before owner setup is expected to return `/healthz` 200 and `/readyz` 503.
- Supermemory may be `disabled` or `degraded` without blocking the operational pipeline.

Public readiness includes component states, bounded error codes, and remediation actions. It never includes raw owner phone values, credentials, private paths, or unrestricted provider errors. Do not use `/healthz` as deployment acceptance.

## 9. First-message test

Only start after `/readyz` returns 200.

1. Send a direct iMessage from the configured owner phone number.
2. Confirm one terminal response is delivered.
3. Send from an unauthorized handle and confirm zero Codex child processes start.
4. Restart the Railway application service normally.
5. Wait for `/readyz` to return 200 and send a follow-up.
6. Record the exact commit, Railway deploy ID, timestamps, redacted readiness responses, and provider paths actually exercised in [`../test/e2e/railway-smoke.md`](../test/e2e/railway-smoke.md).

Offline unit, integration, and chaos tests do not prove a live Railway, Photon, Codex, or Supermemory path.

## 10. Updating an existing deployment

1. Review the incoming commit and new migration notes.
2. Confirm a database recovery point exists.
3. Run the repository's required checks, including `npm run docs:check`, `npm run railway:validate`, and the official Railway JSON schema validation.
4. Confirm the reviewed commit is the revision Railway will deploy.
5. Confirm the pre-deploy migration succeeds.
6. Require `/healthz` and `/readyz` to return 200.
7. Run one authorized non-mutating message and one restart follow-up.

For an existing Railway installation:

1. Preserve the existing `DEPLOYMENT_ID`, `APP_ENCRYPTION_KEY`, PostgreSQL state, persistent volume, and provider credentials.
2. Keep the existing owner migration variable for the first deployment of this version. The runtime accepts `OWNER_PHONE_NUMBER`, the former `OWNER_PHONE_NUMBER_E164_EXAMPLE_PLUS19495550123` alias, or one unambiguous E.164 `AGENT_OWNER_HANDLES` value. Conflicting phone variables, multiple handles, or a non-phone handle require dashboard migration.
3. Remove obsolete model-selection service variables from older releases; model selection now lives in PostgreSQL and is managed through **Advanced** in the dashboard.
4. Remove `AGENT_PASSWORD` and `DASHBOARD_SETUP_SECRET` before startup if either key exists, including with an empty value.
5. Deploy the migration and application once, confirm the dashboard shows the masked migrated owner, and verify an authorized message from that owner. Only then remove the old owner environment variable if desired.
6. Keep `DATABASE_URL`, `NODE_ENV`, `APP_ENCRYPTION_KEY`, the existing `DEPLOYMENT_ID`, `CODEX_HOME`, `AGENT_WORKSPACE_ROOT`, and `CODEX_AUTH_MODE`; keep `OPENAI_API_KEY` only for API-key mode, optional Supermemory variables when enabled, and Railway-injected runtime variables.

An active database owner always wins. The runtime never imports authorization from stored Photon metadata and never overwrites a database owner on later restarts.

For a fresh Railway installation, do not set an owner-phone environment variable. Configure the owner after deployment through the dashboard; the runtime derives `DEPLOYMENT_ID` from Railway's service ID when no explicit deployment ID exists.

## 11. Rollback

Application rollback and schema rollback are separate decisions.

1. Stop new execution and allow graceful shutdown to checkpoint state.
2. Record the current and target application commits.
3. Read every intervening migration `.notes.md` file.
4. Deploy the prior revision only if it is compatible with the current schema.
5. Preserve PostgreSQL, pg-boss state, the persistent volume, and outbound cursors.
6. Restart, run reconciliation, verify both health endpoints, and send one authorized non-mutating message.

Do not run an improvised down migration or delete pg-boss tables, durable messages, outbound cursors, Codex credentials, or workspaces. If compatibility is uncertain, roll forward with a fix or restore application and database together to a matched recovery point.

For incident and provider-outage procedures, use [Operations](./OPERATIONS.md). For visible deployment failures, use [Troubleshooting](./TROUBLESHOOTING.md).
