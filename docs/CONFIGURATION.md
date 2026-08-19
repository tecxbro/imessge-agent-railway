# Configuration Reference

[`../.env.example`](../.env.example) is the copyable configuration template. This file is the authoritative explanation of supported environment variables, including private service secrets. The service validates the complete environment at startup and reports safe configuration problems together.

All changes require a service restart. Railway-managed values should be changed through application service variables or project settings, never by editing files on the persistent volume.

## Required provider configuration

| Variable | Required | Default | Where to obtain it | Restart required | Sensitive |
|---|---:|---|---|---:|---:|
| `SPECTRUM_PROJECT_ID` | No at initial boot; required for intake | — | Photon dashboard or public setup flow | Yes | Yes |
| `SPECTRUM_PROJECT_SECRET` | No at initial boot; required for intake | — | Photon dashboard or public setup flow | Yes | Yes |
| `DATABASE_URL` | Yes | — | Local PostgreSQL or Railway dynamic database reference | Yes | Yes |

`DATABASE_URL` must use the `postgres://` or `postgresql://` protocol. On Railway set it to `${{Postgres.DATABASE_URL}}`; do not paste the generated connection string into source or documentation. Spectrum credentials may be omitted during initial boot so the public dashboard can complete Photon setup, but they must be supplied as a pair whenever they are present.

## Authorization

| Variable | Required | Default | Where to obtain it | Restart required | Sensitive |
|---|---:|---|---|---:|---:|
| `OWNER_PHONE_NUMBER` | Legacy migration only | — | Existing deployment environment | Yes | Private |
| `OWNER_PHONE_NUMBER_E164_EXAMPLE_PLUS19495550123` | Legacy migration only | — | Former long owner alias | Yes | Private |
| `AGENT_OWNER_HANDLES` | Legacy migration only | — | Existing single E.164 handle | Yes | Private |
| `PAIRING_MODE` | No | `off` | Operator policy | Yes | No |
| `GROUP_MODE` | No | `owner_mentions_only` | Operator policy | Yes | No |

Fresh deployments leave every owner variable unset and save the owner through the public dashboard. The dashboard defaults to U.S. national entry and supports country-aware international entry, then normalizes a valid number to E.164 before persistence. Startup first prefers an active encrypted database identity. Only when none exists does it import `OWNER_PHONE_NUMBER`, then the former long owner alias, then a single unambiguous E.164 `AGENT_OWNER_HANDLES` value. These legacy environment inputs remain strict E.164 migration values; conflicting phone variables are rejected, and multiple handles or a non-phone handle produce a stable migration-required state instead of a silent choice.

Imported values are one-time inputs: successful import persists the encrypted identity and later restarts do not overwrite it from the environment. Stored Photon owner metadata is provider setup state, never sender-authorization authority. After the masked dashboard status and an authorized message verify migration, remove old environment values manually if desired.

Keep `PAIRING_MODE=off` unless pairing has been explicitly reviewed for the deployment. `GROUP_MODE=disabled` rejects group use; `owner_mentions_only` requires the owner/group policy enforced by the application.

## Dashboard onboarding

The dashboard has no password environment variable, login route, session cookie, or CSRF credential. Fresh Railway deployments configure the owner through the dashboard rather than a service variable. The former dashboard credential variables are unsupported and startup rejects them if they are still present, including when set to an empty string. Existing services must delete those two legacy variables from Railway before deploying this version; see [Troubleshooting](./TROUBLESHOOTING.md).

Owner, Photon, and ChatGPT setup are managed from the dashboard. Mutations
require a matching `Origin` and reject cross-site fetch metadata.

## Codex authentication

| Variable | Required | Default | Where to obtain it | Restart required | Sensitive |
|---|---:|---|---|---:|---:|
| `CODEX_AUTH_MODE` | Yes | `chatgpt` | Operator choice: `chatgpt` or `api_key` | Yes | No |
| `OPENAI_API_KEY` | Only in API-key mode | — | OpenAI Platform | Yes | Yes |

ChatGPT mode stores device-login credentials below `CODEX_HOME`. API-key mode supplies `OPENAI_API_KEY` only to the Codex child process through an explicit environment allowlist. The runtime never silently switches modes.

## Persistent storage

| Variable | Required | Default | Where to obtain it | Restart required | Sensitive |
|---|---:|---|---|---:|---:|
| `DEPLOYMENT_ID` | Local and migrated installs | Derived from `RAILWAY_SERVICE_ID` for new Railway installs | Generate a stable UUID locally | Yes | No |
| `APP_ENCRYPTION_KEY` | Yes | — | `openssl rand -base64 32` | Yes | Yes |
| `CODEX_HOME` | Yes | `/var/data/codex` on Railway | Absolute private directory | Yes | Contains secrets |
| `AGENT_WORKSPACE_ROOT` | Yes | `/var/data/workspaces` on Railway | Separate absolute directory | Yes | Private data |

`APP_ENCRYPTION_KEY` must be 32 bytes encoded as base64 or 64 hexadecimal characters. Rotating it requires a migration plan for already encrypted data.

`CODEX_HOME` and `AGENT_WORKSPACE_ROOT` must be absolute, non-root, separate, and non-overlapping. `.env` does not expand `$HOME`, `$PWD`, `~`, or command substitutions.

Railway service IDs are provider-specific strings, not application UUIDs. When `DEPLOYMENT_ID` is absent on a new Railway installation, the loader hashes `RAILWAY_SERVICE_ID` into a deterministic UUID. This keeps the internal deployment namespace stable without storing the raw provider identifier in memory namespaces. Migrated installations must preserve their explicit `DEPLOYMENT_ID`.

Railway injects `RAILWAY_SERVICE_ID`, `RAILWAY_DEPLOYMENT_ID`, `RAILWAY_VOLUME_MOUNT_PATH`, and `PORT`. The loader requires `CODEX_HOME` and `AGENT_WORKSPACE_ROOT` to be strict descendants of `RAILWAY_VOLUME_MOUNT_PATH` whenever Railway runtime variables are present.

## Optional memory

| Variable | Required | Default | Where to obtain it | Restart required | Sensitive |
|---|---:|---|---|---:|---:|
| `SUPERMEMORY_API_KEY` | No | Disabled | Supermemory dashboard | Yes | Yes |
| `SUPERMEMORY_CONTAINER_PREFIX` | No | `imessage-agent` | Operator-chosen namespace prefix | Yes | No |

Leave `SUPERMEMORY_API_KEY` blank to disable semantic memory. PostgreSQL remains the operational source of truth. Supermemory may contain only bounded curated facts and summaries, never authorization, delivery, queue, or raw-message state.

The container prefix must be 1–64 letters, digits, or hyphens and begin with a letter or digit.

## Account-aware model selection

Model selection has no environment variables. The stored deployment default is
`gpt-5.6-luna` with `high` reasoning and the owner changes it under
**Dashboard → Advanced** after ChatGPT connects.

In ChatGPT mode, `account/read` and `account/updated` supply the displayed plan
name. Codex `model/list` is the authority for visible models and supported
reasoning efforts; the plan name is never interpreted through a hard-coded
entitlement table. If Luna High is unavailable, the runtime uses Codex's
advertised default model and effort while preserving Luna High as the owner
preference. Settings are stored in PostgreSQL and apply to new message chains.
An existing chain keeps the pair it captured at creation.

API-key mode has no account catalog or plan display. It uses the stored default
only after the exact pair passes the bounded Codex capability probe.

## Concurrency and limits

| Variable | Required | Default | Allowed range | Restart required |
|---|---:|---:|---:|---:|
| `INBOUND_DEBOUNCE_MS` | No | `0` | 0–5000 | Yes |
| `MAX_EXECUTION_CONCURRENCY` | No | `3` | 1–20 | Yes |
| `MAX_OWNER_EXECUTION_CONCURRENCY` | No | `2` | 1–20 and no greater than global | Yes |
| `MESSAGE_RATE_LIMIT_PER_MINUTE` | No | `60` | 1–10000 | Yes |
| `TASK_RATE_LIMIT_PER_HOUR` | No | `120` | 1–10000 | Yes |
| `MAX_TASK_RUNTIME_MS` | No | `900000` | 1000–3600000 | Yes |

`0` starts processing immediately and is the production default. A non-zero value batches messages sent within the configured window but adds the same amount of guaranteed latency before processing begins.

These bounds protect provider load and child-process capacity. Increasing them changes resource and abuse risk; validate queue recovery, cancellation, and Railway service capacity before deployment.

## Retention and logging

| Variable | Required | Default | Allowed range | Restart required | Sensitive |
|---|---:|---:|---:|---:|---:|
| `RAW_MESSAGE_RETENTION_DAYS` | No | `30` | 1–3650 | Yes | Private data policy |
| `FAILURE_RETENTION_DAYS` | No | `14` | 1–365 | Yes | Private metadata policy |
| `LOG_MESSAGE_CONTENT` | No | `false` | `true` or `false` | Yes | Security-critical |

Keep `LOG_MESSAGE_CONTENT=false` in production. Enabling raw content logging materially changes the privacy boundary and requires an explicit reviewed requirement.

## Server configuration

| Variable | Required | Default | Where to obtain it | Restart required | Sensitive |
|---|---:|---:|---|---:|---:|
| `PORT` | No | `10000` | Railway injects or local operator chooses | Yes | No |

`PORT` must be between 1 and 65535. `NODE_ENV`, `PATH`, and locale variables are process inputs. Railway-provided variables are documented as commented examples in `.env.example` but must not be fabricated for local development.

## Cross-field safety checks

Startup fails with an actionable combined error when:

- API-key mode lacks `OPENAI_API_KEY`;
- either removed dashboard credential key is present, even when empty;
- owner concurrency exceeds global concurrency;
- protected paths overlap, resolve to a filesystem root, or contain traversal;
- Railway runtime variables are present without a volume mount or protected paths beneath it;
- only one Spectrum credential is supplied;
- the database URL uses a non-PostgreSQL protocol;
- the encryption key has the wrong encoding or byte length; or
- owner handles, durations, booleans, or enum values are invalid.

Fix the reported values and restart. Never work around validation by weakening schemas or logging secrets.
