# Data Model

## 1. Principles

- PostgreSQL is the operational source of truth.
- Every user-visible action is traceable to a message, chain, task, approval, and outbound batch.
- External provider identifiers are stored alongside generated internal IDs.
- Semantic memory content lives in Supermemory; PostgreSQL stores projections, hashes, and receipts.
- Deletion and retention are explicit lifecycle operations, not ad hoc cleanup.
- Personal identifiers are normalized and encrypted or hashed where appropriate; logs use redacted forms.

## 2. Tables

### `deployments`

One row per private installation.

| Column | Notes |
|---|---|
| `id` | Stable UUID used in idempotency and Supermemory namespace |
| `name` | Human-readable deployment name |
| `created_at`, `updated_at` | Timestamps |
| `status` | `active`, `disabled`, `maintenance` |
| `default_model_profile` | Configurable profile |
| `settings_json` | Nonsecret settings only |

### `owners`

The primary person or organization controlling the deployment.

| Column | Notes |
|---|---|
| `id` | Internal UUID; use for memory namespace |
| `deployment_id` | Foreign key |
| `display_name` | Optional |
| `timezone` | IANA timezone |
| `locale` | Optional |
| `status` | `active`, `disabled` |

### `channel_identities`

Maps iMessage sender handles to owners or approved collaborators.

| Column | Notes |
|---|---|
| `id` | UUID |
| `owner_id` | Foreign key |
| `platform` | `imessage` |
| `normalized_handle_ciphertext` | Encrypted address/phone |
| `handle_fingerprint` | HMAC for indexed equality lookup |
| `role` | `owner`, `collaborator` |
| `verified_at` | Pairing/allowlist verification time |
| `revoked_at` | Optional |

Unique: `(deployment_id, platform, handle_fingerprint)`.

### `spaces`

One row per Spectrum conversation.

| Column | Notes |
|---|---|
| `id` | Internal UUID |
| `deployment_id` | Foreign key |
| `platform` | `imessage` |
| `external_space_guid` | Spectrum/iMessage chat GUID |
| `route_phone_ciphertext` | Needed for multi-line dedicated routing |
| `route_phone_fingerprint` | Indexed lookup if needed |
| `type` | `dm`, `group` |
| `model_profile_override` | Optional |
| `interaction_thread_id` | Codex thread ID |
| `interaction_summary` | Recovery summary, redacted/bounded |
| `last_message_at` | Ordering and retention |

Unique: `(deployment_id, platform, external_space_guid, route_phone_fingerprint)`.

### `space_members`

Records authorized and observed participants without using the model for identity.

| Column | Notes |
|---|---|
| `space_id` | Foreign key |
| `channel_identity_id` | Nullable for unrecognized observed participant |
| `observed_handle_fingerprint` | HMAC fingerprint |
| `is_authorized` | Code-derived |
| `last_seen_at` | Timestamp |

### `messages`

Raw accepted inbound and materialized outbound message metadata.

| Column | Notes |
|---|---|
| `id` | UUID |
| `space_id` | Foreign key |
| `external_message_id` | Provider ID when available |
| `direction` | `inbound`, `outbound` |
| `sender_identity_id` | Nullable for agent outbound |
| `content_type` | `text` in v1 |
| `content_ciphertext` | Encrypted raw text |
| `content_hash` | Integrity/dedup support |
| `received_at`, `sent_at` | Timestamps |
| `drained_chain_id` | Nullable until turn flush |
| `retention_expires_at` | Configurable |

Unique partial index on provider message identity prevents duplicate ingestion.

### `chains`

One logical user turn, including planning, execution, synthesis, and send.

| Column | Notes |
|---|---|
| `id` | UUID |
| `space_id` | Foreign key |
| `version` | Monotonic per space |
| `state` | `queued`, `planning`, `executing`, `awaiting_approval`, `synthesizing`, `sending`, `complete`, `failed`, `canceled` |
| `chain_started_at` | Used to distinguish stale cancellation flags |
| `canceled_at` | Nullable |
| `canceled_by_message_id` | Nullable |
| `model_profile` | Resolved profile |
| `prompt_version` | Prompt bundle hash |
| `decision_json` | Validated interaction decision |
| `terminal_error_code` | Redacted code |
| `completed_at` | Nullable |

Unique: `(space_id, version)`.

### `carried_messages`

Preserves drained messages when a chain is superseded.

| Column | Notes |
|---|---|
| `id` | UUID |
| `space_id` | Foreign key |
| `source_chain_id` | Canceled chain |
| `source_message_id` | Original message |
| `position` | Stable order |
| `consumed_by_chain_id` | Nullable |

### `agent_threads`

Named execution-agent mapping.

| Column | Notes |
|---|---|
| `id` | UUID |
| `owner_id` | Foreign key |
| `agent_name` | Normalized name |
| `workspace_binding` | Path alias, never arbitrary user path |
| `codex_thread_id` | Resumable thread |
| `summary` | Bounded recovery summary |
| `last_model_profile` | Audit |
| `status` | `active`, `reset`, `disabled` |
| `last_used_at` | Timestamp |

Unique: `(owner_id, agent_name, workspace_binding)`.

### `execution_tasks`

One unit of delegated work.

| Column | Notes |
|---|---|
| `id` | UUID |
| `chain_id` | Foreign key |
| `agent_thread_id` | Nullable until resolved |
| `name`, `purpose` | User-safe metadata |
| `instructions_ciphertext` | Task instructions |
| `model_profile` | Resolved profile |
| `permission_profile` | Code-enforced |
| `state` | `queued`, `running`, `succeeded`, `failed`, `canceled`, `needs_approval` |
| `depends_on_json` | Validated task IDs |
| `result_json` | Validated `ExecutionResult` |
| `started_at`, `completed_at` | Timestamps |
| `attempt_count` | Operational |

### `approvals`

Consequential-action gate.

| Column | Notes |
|---|---|
| `id` | UUID |
| `chain_id`, `execution_task_id` | Origin |
| `owner_id`, `space_id` | Binding |
| `action_type` | Normalized enum/string |
| `normalized_payload_ciphertext` | Exact proposed operation |
| `action_hash` | Immutable binding |
| `human_summary` | User-visible text |
| `status` | `pending`, `approved`, `rejected`, `expired`, `consumed` |
| `expires_at` | Default ten minutes |
| `approved_by_identity_id` | Nullable |
| `consumed_at` | Nullable |

### `outbound_batches`

Materialized response and resume cursor.

| Column | Notes |
|---|---|
| `id` | UUID |
| `chain_id`, `space_id` | Foreign keys |
| `state` | `queued`, `sending`, `sent`, `failed`, `canceled` |
| `start_index` | Next part to attempt |
| `part_count` | Immutable |
| `created_at`, `completed_at` | Timestamps |

### `outbound_parts`

| Column | Notes |
|---|---|
| `id` | UUID |
| `batch_id` | Foreign key |
| `position` | Zero-based |
| `client_guid` | Stable deterministic ID |
| `content_ciphertext` | Bubble text |
| `state` | `pending`, `sent`, `failed` |
| `external_message_id` | Nullable provider ID |
| `sent_at` | Nullable |

Unique: `(batch_id, position)` and globally unique `client_guid`.

### `memory_sync_events`

Projection receipts, not the primary memory body.

| Column | Notes |
|---|---|
| `id` | UUID |
| `owner_id`, `space_id`, `chain_id` | Scope and source |
| `operation` | `add`, `update`, `delete`, `recall` |
| `external_memory_id` | Supermemory ID |
| `content_hash` | Detect duplicate projection |
| `status` | `pending`, `succeeded`, `failed` |
| `safe_summary` | No raw sensitive text |
| `created_at` | Timestamp |

### `usage_events`

Model, latency, and resource accounting.

| Column | Notes |
|---|---|
| `id` | UUID |
| `chain_id`, `execution_task_id` | Optional scope |
| `event_type` | `model_turn`, `memory_search`, `memory_write`, `spectrum_send`, etc. |
| `model`, `effort` | Nullable |
| `input_tokens`, `output_tokens` | Nullable |
| `latency_ms` | Nullable |
| `estimated_cost_microunits` | API-key mode estimate only |
| `created_at` | Timestamp |

### `failure_events`

Durable operational diagnostics.

| Column | Notes |
|---|---|
| `id` | UUID |
| `correlation_type`, `correlation_id` | Message/chain/task/job/batch |
| `component` | Spectrum, queue, Codex, memory, database, outbound |
| `error_code` | Stable internal code |
| `retryable` | Boolean |
| `safe_message` | Redacted |
| `payload_summary_json` | Bounded/redacted |
| `created_at`, `retention_expires_at` | Lifecycle |

## 3. pg-boss queues

| Queue | Purpose | Idempotency key |
|---|---|---|
| `inbound.flush` | Debounce and drain a space | `space:<id>` with singleton/debounce options |
| `turn.plan` | Interaction decision | `chain:<id>:plan` |
| `task.execute` | Run one execution task | `task:<id>` |
| `turn.synthesize` | Aggregate terminal tasks | `chain:<id>:synthesize` |
| `outbound.send` | Resume a materialized batch | `outbound:<batch-id>` |
| `memory.curate` | Project durable memory | `chain:<id>:memory` |
| `maintenance.retention` | Apply retention policies | scheduled singleton |
| `maintenance.health` | Optional provider probes | scheduled singleton |

Payloads contain only IDs, versions, and expected state. Handlers load authoritative rows within transactions.

## 4. State-transition rules

- Only the current space chain version may move from `queued` to `planning`.
- A canceled chain cannot create a new outbound batch.
- A task result is accepted only when its task is `running` and its chain has not been superseded.
- Synthesis starts once after all required tasks are terminal.
- Approval changes are compare-and-set operations.
- An outbound cursor can move only forward.
- A memory write runs only for a successfully synthesized chain.
- Retention deletion never removes rows needed by nonterminal chains.

## 5. Encryption and fingerprints

Use envelope encryption for raw message bodies, sensitive task instructions, route phones, and approval payloads. Use a deployment-scoped HMAC key for equality-search fingerprints. `APP_ENCRYPTION_KEY` is a generated deployment secret and must support future key rotation through a version field.

Do not encrypt primary keys, timestamps, state enums, or safe metrics; operational queries must remain possible.

## 6. Retention defaults

| Data | Default | Configurable |
|---|---:|---|
| Raw message content | 30 days | yes |
| Agent task instructions/results | 30 days | yes |
| Failure payload summaries | 14 days | yes |
| Usage events | 90 days | yes |
| Approval payloads | 30 days after terminal | yes |
| Supermemory facts | Until explicit deletion or product policy | yes |
| Codex session files | Until `/new`, agent reset, or deployment deletion | yes |

A private owner may select longer retention, but the default starter should minimize stored raw content.

## 7. Deletion workflow

A full owner deletion:

1. Disable authorization identities.
2. Cancel nonterminal jobs and chains.
3. Delete Supermemory container contents and persist receipts.
4. Delete Codex sessions/workspaces under the owner’s approved root.
5. Delete or crypto-shred raw PostgreSQL content.
6. Retain only legally/operationally necessary aggregate diagnostics, without handles or message bodies.
7. Produce a local deletion report identifier.
