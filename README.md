# Build Your Own iMessage Codex Agent

Deploy a private iMessage agent powered by Photon Spectrum, Codex, PostgreSQL, and optional Supermemory.

The canonical repository is [`tecxbro/imessge-agent-railway`](https://github.com/tecxbro/imessge-agent-railway). The Railway service URL opens the public setup dashboard; conversations happen through iMessage.

## Before you deploy

You need:

- a Railway account;
- a Photon account for Spectrum Cloud iMessage setup;
- the owner's personal phone number allowed to message the agent;
- either a ChatGPT account with Codex device login enabled or an OpenAI API key; and
- an optional Supermemory API key if you want semantic memory.

The production shape uses one Railway application service, one PostgreSQL 18 service, and one persistent volume. Keep the application at one replica because its Codex credentials and workspaces live on the attached volume. Review current Railway pricing before provisioning resources.

## Deploy on Railway

1. Create a Railway project and add a PostgreSQL 18 service.
2. Add an application service from this repository, select branch `main`, and configure `/railway.json` as its Railway config file.
3. Attach one volume to the application service at `/var/data` and keep the service at one replica.
4. Set `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `NODE_ENV=production`, `CODEX_HOME=/var/data/codex`, and `AGENT_WORKSPACE_ROOT=/var/data/workspaces`.
5. Generate `APP_ENCRYPTION_KEY` with `openssl rand -base64 32` and store it as a Railway service variable. Existing installations must preserve both this key and their explicit `DEPLOYMENT_ID`; a new installation may derive its stable internal ID from Railway's `RAILWAY_SERVICE_ID`.
6. Choose `CODEX_AUTH_MODE=chatgpt` or `CODEX_AUTH_MODE=api_key`. For API-key mode, add `OPENAI_API_KEY` as a private Railway service variable.
7. Enable **Wait for CI** before enabling GitHub automatic deployments from `main`, deploy, and wait for the build, pre-deploy migration, start, and `/healthz` check to finish.
8. Open the public dashboard at the application URL, enter the owner's phone number, authenticate Photon, then connect ChatGPT when using ChatGPT mode.
9. After ChatGPT connects, open **Advanced** and confirm or change the deployment model and reasoning effort.
10. Confirm `/readyz` returns HTTP 200.
11. Text the Photon-assigned number shown at completion from the configured owner phone.

Railway provides `PORT`, `RAILWAY_SERVICE_ID`, `RAILWAY_DEPLOYMENT_ID`, and `RAILWAY_VOLUME_MOUNT_PATH` at runtime. Do not define fake local values for those platform inputs.

## Dashboard and owner setup

Dashboard setup requests require a same-origin browser request and reject
cross-site fetch metadata.

The dashboard collects the owner's phone number before Photon setup. U.S. entry is the default, so the owner can type a normal 10-digit number without `+1`; **Not in the U.S.?** reveals a country selector, and international users may enter a national or complete international number. The server validates the selected country and normalizes the value to E.164 before storage. The phone number is configured in the dashboard rather than required in the environment. It is encrypted and fingerprinted in PostgreSQL, becomes the only iMessage sender authorized to use the agent, and is registered during Photon owner provisioning. The different Photon-assigned number shown at completion is the destination the owner texts. Replacing the owner number in the dashboard revokes the previous owner identity before the new identity can authorize messages.

## Finish Codex authentication

### ChatGPT device login

The default `CODEX_AUTH_MODE` is `chatgpt`.

1. Open the deployed application URL in a trusted browser.
2. Save the owner phone and finish Photon setup first, then select **Connect ChatGPT**.
3. Open the displayed device-auth URL, sign in, and enter the one-time code.
4. Keep the dashboard open while it verifies the login and prepares Codex. The dashboard advances automatically when each stage is ready.

After ChatGPT connects, **Advanced** displays the account plan and only the
models and reasoning efforts advertised by Codex for that account. The stored
deployment default is GPT-5.6 Luna with High reasoning. If that exact pair is
unavailable, the agent uses Codex's advertised default pair without changing
the stored preference, and Advanced explains the fallback. Saved changes apply
to new message chains; running work keeps its chain snapshot.

ChatGPT credentials persist under `/var/data/codex`. Treat `auth.json` like a password: never print it, copy it into a ticket, or commit it.

If ChatGPT authentication needs operator recovery, open a private `railway ssh` session and run `npm run codex:login`, then `npm run codex:status` before restarting the service.

### OpenAI API key

Set these application service variables and redeploy:

```dotenv
CODEX_AUTH_MODE=api_key
OPENAI_API_KEY=replace-with-a-Railway-secret
```

API-key mode does not require device login. The runtime supplies the key only to the Codex child process through an explicit environment allowlist.

## Verify the deployment

Open the Railway-generated application URL or check the endpoints directly:

```bash
curl --fail --silent "https://<service-host>/healthz"
curl --silent --show-error "https://<service-host>/readyz"
```

- `/healthz` returning 200 means the HTTP process is alive.
- `/readyz` returning 200 means owner identity, critical storage, PostgreSQL, migration, queue, Codex, and Spectrum checks are ready.
- `/readyz` returning 503 means setup is incomplete or a dependency is degraded. Its response includes the detailed component snapshot and remediation actions.

The root URL opens the setup dashboard; it is not an iMessage chat. The
dashboard reports provider setup status, device codes, verification URLs, the
assigned number, masked owner information, detailed readiness, and bounded
provider error codes. Raw owner phone values, provider access tokens, project
secrets, Codex credentials, database credentials, and unrestricted provider
errors remain server-side.

## Send the first iMessage

After `/readyz` is 200:

1. Send a direct iMessage to the Spectrum-connected line from the configured owner phone number.
2. Confirm the agent sends one terminal response.
3. Send from an unauthorized handle and confirm no Codex process starts.
4. Restart the Railway application service, wait for `/readyz` to return 200, and send a follow-up.

Record protected live evidence before describing any provider path as live-working. Offline tests and a healthy `/healthz` are not substitutes for an authorized live message.

## What gets deployed

The checked-in [`railway.json`](./railway.json) configures the application service with:

- Railpack and the supported Node runtime range;
- `npm ci --include=dev && npm run build`;
- `npm run db:migrate` before each deploy;
- `npm start` as the production command;
- `/healthz` as Railway's liveness check;
- zero deployment overlap so two releases cannot consume the same Spectrum stream; and
- a 90-second draining window for graceful shutdown.

Create the PostgreSQL service and `/var/data` volume in the Railway project. Use `/var/data/codex` for Codex credentials and sessions, `/var/data/workspaces` for agent workspaces, and `DATABASE_URL=${{Postgres.DATABASE_URL}}` for the database connection.

The volume-backed design makes this version single-instance. Do not enable horizontal scaling without redesigning credential and workspace ownership.

## Customize your agent

The most common edits are:

| Goal | File or setting |
|---|---|
| Personality and conversational style | `prompts/interaction.system.md`, `prompts/voice-policy.md` |
| Execution behavior | `prompts/execution.system.md` |
| Approval rules | `prompts/approval-policy.md` |
| Models and reasoning effort | **Advanced** in the deployment dashboard |
| Authorized sender | **Change phone number** in the deployment dashboard; owner environment values are migration inputs only |
| Semantic memory | `SUPERMEMORY_API_KEY` |
| Railway build and deploy behavior | `railway.json` |
| Service, database, volume, variables, and networking | Railway project settings |
| Concurrency and runtime limits | `.env` |
| Tools or repository workspaces | `src/runtime/production-bootstrap.ts` capability composition |

See [Customization](./docs/CUSTOMIZATION.md) before editing the runtime composition or approval policy.

## Local development

### Prerequisites

- Node.js 22.12 through 22.x, or Node.js 24 or newer;
- PostgreSQL 13 or newer;
- a Photon account for dashboard setup, or existing Spectrum credentials;
- ChatGPT device authentication or an OpenAI API key; and
- a Supermemory key only if memory is enabled.

### Install and start

```bash
git clone https://github.com/tecxbro/imessge-agent-railway.git
cd imessge-agent-railway
npm ci
npm run repo:setup-guards
cp .env.example .env
```

Edit `.env`, then generate an `APP_ENCRYPTION_KEY`:

```bash
openssl rand -base64 32
```

Use separate, absolute paths for `CODEX_HOME` and `AGENT_WORKSPACE_ROOT`; `.env` does not expand `$HOME` or `$PWD`. Apply migrations, authenticate Codex if using the CLI flow, and start the composed service:

```bash
npm run db:migrate
npm run codex:login
npm run codex:status
npm run dev
```

Before proposing a change, run:

```bash
npm run repo:verify-target
npm run typecheck
npm test
npm run test:security
npm run test:integration
npm run test:chaos
npm run build
npm run docs:check
npm run railway:validate
```

Database-backed integration coverage needs a separate disposable database in `POSTGRES_PIPELINE_TEST_DATABASE_URL`; the suite truncates application tables. Protected provider tests are opt-in and require private accounts.

## How it works

```text
Authorized iMessage owner
  ↕
Photon Spectrum Cloud (persistent app.messages gRPC stream)
  ↓
Authorize, normalize, persist, and schedule
  ↓
PostgreSQL + pg-boss durable pipeline
  ↓
Interaction Codex thread
  ├─ direct response
  └─ bounded execution threads
  ↓
Materialized outbound parts + restart-safe cursor
  ↓
Photon Spectrum Cloud

Successful turn ──> optional curated Supermemory projection
```

`src/server.ts` is the executable entrypoint. It loads the production adapters from `src/runtime/production-bootstrap.ts` and passes them to the generic lifecycle in `src/index.ts`. HTTP liveness starts first; PostgreSQL, migrations, queue workers, Codex checks, optional memory, reconciliation, and Spectrum follow in dependency order.

PostgreSQL is the operational source of truth. Supermemory stores only bounded, curated semantic facts and summaries. The receive loop never runs model work inline.

## Security and privacy

- Unknown senders are rejected before persistence, queueing, or model work.
- Dashboard setup mutations require same-origin and fetch-metadata validation.
- Authorization is checked again immediately before Codex or another child process starts.
- Codex children receive an explicit environment allowlist, never the full server environment.
- Models cannot approve actions or broaden code-owned permission profiles.
- Queue payloads contain identifiers, not raw personal content.
- Logs, health endpoints, and failure records must remain redacted.
- Codex credentials and workspaces use separate private directories on the persistent volume.

Never commit `.env`, `auth.json`, provider credentials, database URLs, owner handles, or workspace data. Read [Security and privacy](./docs/SECURITY_AND_PRIVACY.md) for the full trust model.

## Known limitations and release evidence

The executable production runtime is composed. Clean-account Railway deployment and protected live-provider evidence remain separate release checks.

The repository does not currently include recorded evidence for a fresh Railway deployment, dashboard Photon enrollment, dashboard ChatGPT enrollment, live Photon/Spectrum authorized DM, authenticated Codex restart/resume, or live Supermemory add/search/delete cycle. Run the [release smoke checklist](./test/e2e/railway-smoke.md) for the exact commit under review.

The pinned Spectrum API sends through native `space.send(...)` but does not accept the database's stable client GUID. PostgreSQL prevents normal resend, but a crash after provider acknowledgement and before cursor checkpoint can duplicate one bubble. Do not claim exactly-once provider delivery without protected live evidence and provider support.

A blank Railway volume has no code-owned execution workspace capability. The default deployment can answer conversational turns; repository execution requires an explicit reviewed workspace/capability binding.

## Documentation

- [Documentation index](./docs/README.md)
- [Deployment](./docs/DEPLOYMENT.md)
- [Architecture](./docs/ARCHITECTURE.md)
- [Operations](./docs/OPERATIONS.md)
- [Configuration](./docs/CONFIGURATION.md)
- [Customization](./docs/CUSTOMIZATION.md)
- [Troubleshooting](./docs/TROUBLESHOOTING.md)
- [Security and privacy](./docs/SECURITY_AND_PRIVACY.md)
- [Maintainer references](./docs/maintainers/PROVIDER_REFERENCES.md)
- [Contributing](./CONTRIBUTING.md)
- [MIT license](./LICENSE)
