# Configuration Reference

[`../.env.example`](../.env.example) is the copyable configuration template. This file is the authoritative explanation of public environment variables. The service validates the complete environment at startup and reports all detected problems together.

All changes require a service restart. Railway-managed values should be changed through application service variables or project settings, never by editing files on the persistent volume.

## Required provider configuration

| Variable | Required | Default | Where to obtain it | Restart required | Sensitive |
|---|---:|---|---|---:|---:|
| `SPECTRUM_PROJECT_ID` | No at initial boot; required for intake | — | Photon dashboard or operator setup flow | Yes | Yes |
| `SPECTRUM_PROJECT_SECRET` | No at initial boot; required for intake | — | Photon dashboard or operator setup flow | Yes | Yes |
| `DATABASE_URL` | Yes | — | Local PostgreSQL or Railway dynamic database reference | Yes | Yes |

`DATABASE_URL` must use the `postgres://` or `postgresql://` protocol. On Railway set it to `${{Postgres.DATABASE_URL}}`; do not paste the generated connection string into source or documentation. Spectrum credentials may be omitted during initial boot so the operator dashboard can complete Photon setup, but they must be supplied as a pair whenever they are present.

## Authorization

| Variable | Required | Default | Where to obtain it | Restart required | Sensitive |
|---|---:|---|---|---:|---:|
| `OWNER_PHONE_NUMBER` | Yes on new deployments | — | Owner's E.164 phone number | Yes | Private |
| `AGENT_OWNER_HANDLES` | Legacy fallback only | — | Existing comma-separated numbers or iMessage emails | Yes | Private |
| `PAIRING_MODE` | No | `off` | Operator policy | Yes | No |
| `GROUP_MODE` | No | `owner_mentions_only` | Operator policy | Yes | No |

Enter the actual owner number in E.164 format, such as `+19495550123`. `AGENT_OWNER_HANDLES` remains a backwards-compatible fallback for existing comma-separated phone numbers or iMessage emails; emails are normalized to lowercase. When `OWNER_PHONE_NUMBER` is set, it becomes the single authorized owner handle. Photon line setup does not replace this application allowlist.

Keep `PAIRING_MODE=off` unless pairing has been explicitly reviewed for the deployment. `GROUP_MODE=disabled` rejects group use; `owner_mentions_only` requires the owner/group policy enforced by the application.

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

## Model routing

| Variable | Required | Default | Restart required | Sensitive |
|---|---:|---|---:|---:|
| `MODEL_FAST` | No | `gpt-5.6-luna` | Yes | No |
| `MODEL_FAST_EFFORT` | No | `medium` | Yes | No |
| `MODEL_MAIN` | No | `gpt-5.6-luna` | Yes | No |
| `MODEL_MAIN_EFFORT` | No | `high` | Yes | No |
| `MODEL_BALANCED` | No | `gpt-5.6-terra` | Yes | No |
| `MODEL_BALANCED_EFFORT` | No | `high` | Yes | No |
| `MODEL_HARD` | No | `gpt-5.6-luna` | Yes | No |
| `MODEL_HARD_EFFORT` | No | `max` | Yes | No |
| `MODEL_DEEP` | No | `gpt-5.6-sol` | Yes | No |
| `MODEL_DEEP_EFFORT` | No | `max` | Yes | No |
| `ALLOW_REASONING_FALLBACK` | No | `false` | Yes | No |

Configured model/effort pairs are capability-probed before Spectrum intake starts. Keep `ALLOW_REASONING_FALLBACK=false` unless an explicit product policy permits a different effort level. The runtime must not silently downgrade models or reasoning effort.

## Concurrency and limits

| Variable | Required | Default | Allowed range | Restart required |
|---|---:|---:|---:|---:|
| `INBOUND_DEBOUNCE_MS` | No | `4000` | 3000–5000 | Yes |
| `MAX_EXECUTION_CONCURRENCY` | No | `3` | 1–20 | Yes |
| `MAX_OWNER_EXECUTION_CONCURRENCY` | No | `2` | 1–20 and no greater than global | Yes |
| `MESSAGE_RATE_LIMIT_PER_MINUTE` | No | `60` | 1–10000 | Yes |
| `TASK_RATE_LIMIT_PER_HOUR` | No | `120` | 1–10000 | Yes |
| `MAX_TASK_RUNTIME_MS` | No | `900000` | 1000–3600000 | Yes |

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
- owner concurrency exceeds global concurrency;
- protected paths overlap, resolve to a filesystem root, or contain traversal;
- Railway runtime variables are present without a volume mount or protected paths beneath it;
- only one Spectrum credential is supplied;
- the database URL uses a non-PostgreSQL protocol;
- the encryption key has the wrong encoding or byte length; or
- owner handles, model identifiers, effort values, durations, booleans, or enum values are invalid.

Fix the reported values and restart. Never work around validation by weakening schemas or logging secrets.
