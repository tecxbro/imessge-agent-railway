# Implementation Plan

## 1. Execution strategy

Build this as eight bounded implementation steps. Each step has an exact file surface, contracts, tests, and merge gate. Parallel work begins only after the shared schemas and queue names are frozen.

The implementation does **not** modify the original starter in place during planning. Create a new repository from the starter or a clean fork so the minimal hello-world template remains available as a teaching artifact.

## 2. Worktree map

| Worktree | Branch | Ownership | May run in parallel after Step 1 |
|---|---|---|---|
| Contracts/integration | `feat/contracts-integration` | Schemas, interfaces, merge ownership, E2E | Always active; merges last |
| Transport | `feat/spectrum-grpc` | Spectrum setup, receive loop, space resolver, outbound adapter | Yes |
| State/queue | `feat/postgres-pipeline` | Drizzle schema, migrations, pg-boss, state transitions | Yes |
| Codex runtime | `feat/codex-runtime` | SDK wrapper, auth/capability checks, thread lifecycle, model router | Yes |
| Memory | `feat/supermemory` | Recall, curation, deletion, isolation tests | Yes |
| Security | `feat/security-approvals` | Sender auth, pairing, permission profiles, approvals, redaction | After identity contracts |
| Deploy/docs | `main` | Railway service config, local setup, health/readiness, docs | After config contracts |

No worktree owns the same implementation file. Shared contract changes go through the contracts branch first, then are merged or rebased into each branch.

## 3. Sub-agent policy

Use sub-agents only for separable work:

- **Documentation researcher:** verifies exact current primary docs and pinned package requirements; does not edit code.
- **Schema reviewer:** reviews database constraints and transition invariants; does not rewrite transport.
- **Security reviewer:** threat-models sender identity, Codex environment, approvals, and prompt injection.
- **Recovery test agent:** writes kill/restart/cancellation scenarios after the core pipeline exists.
- **Integration agent:** owns final merges, conflict resolution, end-to-end test execution, and documentation consistency.

Do not spawn agents merely to produce more prose. A single owner should implement tightly coupled files within one module.

---

## Step 1 — Repository foundation and frozen contracts

### Goal

Create the new repository shape, pin the runtime, define validated interfaces, and establish import boundaries before parallel implementation.

### Files to create or change

| File | Change |
|---|---|
| `package.json` | Rename package; require Node `>=22.12`; add exact tested dependencies and scripts |
| `tsconfig.json` | Strict TypeScript, ESM, source maps, no unchecked index access |
| `.env.example` | Add all documented variables with safe placeholders |
| `.gitignore` | Ignore `.env`, `dist`, local Codex state, workspaces, test secrets |
| `src/config/env.ts` | Zod-validated environment loader; no `process.env` reads elsewhere |
| `src/config/model-profiles.ts` | Low-level model/effort validation schemas |
| `src/agent/schemas.ts` | `InteractionDecision`, `ExecutionTask`, `ExecutionResult`, memory and action schemas |
| `src/queue/names.ts` | Queue names as literal constants |
| `src/queue/payloads.ts` | ID-only validated job payloads |
| `src/security/permissions.ts` | Permission-profile types and Codex option mapping contract |
| `src/observability/logger.ts` | Structured logger and mandatory redaction configuration |
| `AGENTS.md` | Coding-agent rules from this pack |
| `prompts/*.md` | Initial versioned prompt files |

### Implementation details

1. Use exact package versions after a clean compatibility install.
2. Add scripts:

```json
{
  "build": "tsc",
  "typecheck": "tsc --noEmit",
  "test": "vitest run",
  "test:integration": "vitest run test/integration",
  "db:generate": "drizzle-kit generate",
  "db:migrate": "tsx src/db/migrate.ts",
  "codex:login": "codex login --device-auth",
  "codex:status": "codex login status",
  "railway:validate": "vitest run test/unit/railway-config.test.ts"
}
```

3. Load and hash prompt files at startup. Store the prompt bundle version with every chain/task.
4. Make runtime schemas the only accepted model-output and queue boundaries.
5. Add an architecture lint test that rejects forbidden imports such as `transport → agent` and `security → codex`.

### Tests

- Environment loader rejects missing and malformed variables with one combined actionable report.
- Model/effort schemas accept documented values and reject unknown efforts.
- Representative model JSON fixtures validate or fail deterministically.
- Logger redaction removes phone/email patterns, auth tokens, and raw message fields.
- Typecheck passes on Node 22.12.

### Acceptance gate

No parallel feature branch begins until the interfaces and queue names are reviewed and tagged as `contracts-v1`.

### Suggested sub-agent

A schema reviewer can inspect contracts and transition needs. No implementation sub-agent is required.

---

## Step 2 — Spectrum Cloud gRPC transport

### Goal

Replace the starter’s webhook flow with a persistent Spectrum Cloud receive loop and a restart-safe native outbound adapter.

### Worktree

`feat/spectrum-grpc`

### Files to create or change

| File | Change |
|---|---|
| `src/transport/spectrum.ts` | Create Spectrum app with cloud iMessage provider and credentials |
| `src/transport/message-loop.ts` | Consume `app.messages`; authorize/persist/enqueue through injected services |
| `src/transport/sender-identity.ts` | Narrow iMessage sender and normalize address/service |
| `src/transport/space-resolver.ts` | Persist and rehydrate space GUID plus route phone |
| `src/transport/outbound.ts` | Native `space.send`, typing, stable client GUID support |
| `src/http/server.ts` | Liveness/readiness only; remove Spectrum Express adapter |
| `src/http/readiness.ts` | Spectrum connection state and redacted diagnostics |
| `src/index.ts` | Start receive loop concurrently with queue and HTTP server |
| `package.json` | Remove `@spectrum-ts/express` unless another feature explicitly needs it |
| `railway.json` | Remove webhook secret from environment list |

### Implementation details

1. Create Spectrum with explicit `projectId`, `projectSecret`, and `imessage.config()`.
2. Read `for await (const [space, message] of app.messages)` in a supervised loop.
3. Do not call Codex or Supermemory in the loop.
4. Ignore outbound messages and non-text events for v1.
5. Narrow iMessage values and extract sender address, space type, and route phone.
6. Call a provided `authorizeAndIngest()` service; unauthorized events never reach the model.
7. Track stream status: `starting`, `connected`, `degraded`, `stopped`.
8. Rehydrate outbound conversations with `imessage(app).space.get(spaceGuid, { phone })` when route phone is required.
9. Use `space.responding()` or a strict `try/finally` for typing indicators.
10. Treat shared-pool and dedicated-line group behavior as different capabilities.

### Tests

- Inbound text is normalized and passed once to ingest.
- Outbound echo, reaction, read receipt, and unsupported content are ignored.
- A duplicate external message ID is harmless.
- Space rehydration passes route phone when configured.
- Multiple dedicated-line fixture without route phone fails with a specific diagnostic.
- Receive-loop failure changes readiness and follows bounded restart policy.
- No source file imports `@spectrum-ts/express`.

### Acceptance gate

A fake Spectrum async iterator can deliver events through persistence/enqueue without any model dependency. A real development Photon project can send and receive one authorized DM.

### Suggested sub-agent

A documentation researcher verifies current Spectrum provider, message, content, and routing APIs. One transport owner implements the files.

---

## Step 3 — PostgreSQL schema and durable queue pipeline

### Goal

Make accepted messages, cancellation, retries, approvals, and outbound delivery durable before adding real model execution.

### Worktree

`feat/postgres-pipeline`

### Files to create or change

| File | Change |
|---|---|
| `drizzle.config.ts` | Migration configuration |
| `src/db/client.ts` | PostgreSQL pool and transaction helpers |
| `src/db/schema.ts` | Tables and indexes in `DATA_MODEL.md` |
| `src/db/migrations/*` | Generated, reviewed migrations |
| `src/db/repositories/*` | Explicit repositories; no raw SQL scattered in handlers |
| `src/queue/boss.ts` | pg-boss start/stop, queue creation, worker registration |
| `src/queue/handlers/inbound-flush.ts` | Debounce drain, chain creation, carry-forward |
| `src/queue/handlers/outbound-send.ts` | Materialized send cursor and retries using transport interface |
| `src/observability/failures.ts` | Durable redacted failure events |
| `test/integration/db-*` | Constraints and state-transition tests |
| `test/chaos/outbound-restart.test.ts` | Partial-send recovery |

### Implementation details

1. Implement schema constraints before repository methods.
2. Use transactions for drain/create-chain and cursor advancement.
3. Schedule `inbound.flush` as a per-space singleton/debounce job.
4. Keep message IDs in the database rather than job payload bodies.
5. Implement `supersedeActiveChain(spaceId, newerMessageId)`.
6. Carry drained messages on cancellation before marking the old chain terminal.
7. Materialize outbound parts before the send job.
8. Derive stable client GUIDs from deployment, batch, and position.
9. Add daily retention maintenance.
10. Keep pg-boss workers in-process, but expose handler functions for testing.

### Tests

- Two concurrent ingests produce one message row and one current flush schedule.
- Four messages in a burst drain in order into one chain.
- A new message during planning supersedes and carries prior messages.
- A stale cancellation timestamp does not cancel a new chain.
- Synthesis and outbound jobs are singleton per chain/batch.
- Kill after sending part two resumes at the correct cursor.
- Kill between transport acknowledgement and cursor write retries the same client GUID.
- Retention never deletes rows referenced by a nonterminal chain.

### Acceptance gate

Run the entire pipeline with deterministic fake planner/executor responses, restart the process at every state boundary, and observe one coherent outbound batch with no lost inbound messages.

### Suggested sub-agent

A database/schema reviewer and a separate recovery-test agent are useful. They should not edit the same files.

---

## Step 4 — Codex runtime, ChatGPT enrollment, and account-aware model selection

### Goal

Add a constrained, testable Codex adapter that supports resumable threads,
local or Railway execution, account-aware model selection, capability probing,
and cancellation. ADR-020 supersedes the original static-profile router scope.

### Worktree

`feat/codex-runtime`

### Files to create or change

| File | Change |
|---|---|
| `src/agent/codex-client.ts` | Single wrapper around `@openai/codex-sdk` |
| `src/agent/thread-store.ts` | Start/resume/reset interaction and named-agent threads |
| `src/agent/model-selection.ts` | Preferred/effective pair resolution from the live account catalog |
| `src/config/capabilities.ts` | Startup probe for auth, models, effort, sandbox, disk |
| `src/agent/prompt-builder.ts` | Structured context assembly and prompt hashes |
| `src/agent/interaction-runtime.ts` | Schema-bound interaction turn |
| `src/agent/execution-runtime.ts` | Schema-bound bounded task turn |
| `src/security/secret-boundaries.ts` | Child-process environment allowlist |
| `test/integration/codex-fake-cli/*` | Fake executable and event fixtures |
| `test/e2e/codex-live.test.ts` | Opt-in real-account smoke test |

### Implementation details

1. Pin CLI and SDK versions together.
2. Set `CODEX_HOME` and validate directory ownership/permissions.
3. Build child environment from an allowlist; do not inherit Photon, database, Supermemory, or encryption secrets.
4. Use one interaction thread per space and named executor threads per owner/name/workspace.
5. Resume existing threads; recover with a bounded summary when session files are missing.
6. Use output schemas for every runtime call.
7. Use `runStreamed()` only where progress/cancellation needs it; filter events.
8. Map permission profiles to sandbox, working directory, network, and approval options.
9. Refresh account capabilities, resolve the effective pair, and probe only
   that pair at startup.
10. Snapshot the effective pair on each new chain; do not route or escalate by
    request complexity.
11. Abort superseded tasks and record a retryable/canceled terminal result.
12. Bound task runtime, output bytes, and concurrent child processes.

### Tests

- ChatGPT mode reports missing auth without crashing liveness.
- API-key mode requires `OPENAI_API_KEY` and never reads `auth.json`.
- Child environment excludes database and messaging secrets.
- Thread start/resume/reset paths persist correct IDs.
- Missing session recovers using the stored summary.
- Account catalog fallback preserves the owner preference and selects the
  Codex-advertised default pair.
- Unsupported unused models do not fail readiness; an unavailable effective
  pair does, with remediation text.
- Abort terminates the fake CLI and transitions the task to canceled.
- Structured-output validation rejects malformed or oversized responses.

### Acceptance gate

A local authenticated Codex account can answer a direct turn, execute a bounded repository task, resume after restart, and honor sandbox/network settings. The same binary works with API-key mode.

### Suggested sub-agent

A primary Codex runtime owner plus a security reviewer for process/environment boundaries. Do not split thread lifecycle and SDK wrapper across different implementers.

---

## Step 5 — Poke-inspired interaction/execution orchestration

### Goal

Implement the human-facing dispatcher, named execution agents, parallel task graph, status policy, final synthesis, and original prompts.

### Worktree

Start on `feat/contracts-integration` after Steps 3 and 4 interfaces are stable, or use a short-lived `feat/orchestration` branch owned by the integration lead.

### Files to create or change

| File | Change |
|---|---|
| `prompts/interaction.system.md` | Original interaction policy and structured decision contract |
| `prompts/execution.system.md` | Original bounded worker policy |
| `prompts/voice-policy.md` | iMessage-specific voice rules |
| `prompts/approval-policy.md` | What requires code-backed confirmation |
| `src/queue/handlers/turn-plan.ts` | Recall context, run interaction, direct/delegate branch |
| `src/queue/handlers/task-execute.ts` | Run named execution task |
| `src/queue/handlers/turn-synthesize.ts` | Aggregate results and produce final response |
| `src/messaging/status-policy.ts` | Deterministic status-message rules and rate limits |
| `src/messaging/bubble-splitter.ts` | Preserve code/links while splitting human-sized messages |
| `src/commands/parse.ts` | Parse slash commands before model |
| `src/commands/handlers.ts` | `/help`, `/status`, `/model`, `/cancel`, `/new`, `/agents` |

### Implementation details

1. Direct-answer path should remain one interaction call.
2. Delegation happens only when real execution or independent investigation is needed.
3. Independent tasks run concurrently; dependencies form a validated DAG.
4. Reuse a named agent when its prior context is useful.
5. Send a status bubble before work expected to exceed the simple-turn threshold.
6. Never surface raw execution events or mention hidden workers/tool names.
7. Synthesis sees user-safe task results and artifact references, not unrestricted raw logs.
8. A failed task does not erase successful results; final response reports material partial failure plainly.
9. Enforce maximum task count, graph depth, and loop iterations in code.
10. Commands bypass model interpretation.

### Tests

- Simple greeting or direct factual fixture creates no execution task.
- Complex request decomposes into a valid bounded DAG.
- Independent tasks are enqueued together.
- Follow-up to an existing named agent reuses its thread.
- Status policy sends one concise update and suppresses duplicates.
- Bubble splitter preserves fenced code and URLs.
- Partial failure synthesis is truthful and does not fabricate success.
- Prompt-injection text cannot change permission profile or sender authorization.

### Acceptance gate

A real iMessage turn can take both direct and delegated paths, provide one early status update, run multiple independent tasks, and return a coherent final response.

### Suggested sub-agent

A prompt evaluator can generate adversarial fixtures, while one orchestration owner implements plan/execute/synthesize handlers.

---

## Step 6 — Supermemory recall, curation, and deletion

### Goal

Add useful long-term memory without making semantic storage the operational database or allowing cross-user leakage.

### Worktree

`feat/supermemory`

### Files to create or change

| File | Change |
|---|---|
| `src/memory/supermemory-client.ts` | SDK client and bounded retry/timeout policy |
| `src/memory/recall.ts` | Owner profile plus top relevant memory retrieval |
| `src/memory/curator.ts` | Deterministic filters and schema-bound candidate writer |
| `src/memory/deletion.ts` | `/forget`, item/container deletion, receipts |
| `prompts/memory-curator.system.md` | Original durable-memory extraction policy |
| `src/queue/handlers/memory-curate.ts` | Post-success projection job |
| `src/commands/handlers.ts` | `/memory` and `/forget` |
| `test/integration/memory-isolation.test.ts` | Owner/space scoping and deletion |

### Implementation details

1. Generate internal owner ID; do not use raw phone number as the primary container namespace.
2. Use container tags such as `imessage-agent:<deployment-id>:owner:<owner-id>`.
3. Separate owner profile scope from thread/space context.
4. Recall only a bounded count and character budget.
5. Mark recalled text as untrusted context; it cannot override system/security policy.
6. Curate only durable facts and summaries, not greetings or temporary requests.
7. Hash candidate content to prevent duplicate writes.
8. Store external IDs and operation receipts in PostgreSQL.
9. Time out recall quickly and proceed without memory.
10. Deletion is explicit, auditable, and reflected in subsequent recall tests.

### Tests

- Two owners with similar prompts never retrieve each other’s memories.
- Same owner across DM/group can share profile while thread history remains separate.
- Temporary details are not written.
- Durable preference is written once and recalled later.
- Supermemory timeout does not block turn planning.
- `/forget` removes the target and records a successful receipt.
- Deleted memory does not reappear because of a stale local cache.

### Acceptance gate

The owner can establish a preference in one conversation, see it correctly recalled later, inspect memory, delete it, and verify it is gone.

### Suggested sub-agent

One memory integration owner plus an independent privacy/isolation test reviewer.

---

## Step 7 — Authorization, approvals, and operational hardening

### Goal

Move every safety-critical decision out of prompts and into code, then add security diagnostics and abuse limits.

### Worktree

`feat/security-approvals`

### Files to create or change

| File | Change |
|---|---|
| `src/security/authorize-sender.ts` | Allowlist, roles, group policy |
| `src/security/pairing.ts` | Optional single-use pairing flow |
| `src/security/approvals.ts` | Immutable approval requests and one-time consumption |
| `src/security/permissions.ts` | Final Codex sandbox/network mapping |
| `src/security/redaction.ts` | Logs, failure events, readiness responses |
| `src/security/secret-boundaries.ts` | Final child env and file permission checks |
| `src/commands/handlers.ts` | Approval, rejection, cancellation handling |
| `SECURITY.md` | Threat model and operator guidance |
| `test/security/*` | Unauthorized sender, injection, exfiltration, replay tests |

### Implementation details

1. Reject unknown senders before queueing model work.
2. For groups, require authorized author and configured mention/reply condition.
3. Pairing codes originate from the operator CLI/log-safe channel, never from a model.
4. Define action classes requiring approval: destructive filesystem, external sends, permission/auth changes, purchases, deployment changes, secret access, and broad network actions.
5. Approval stores exact normalized payload and action hash.
6. Bind approval to owner, allowed space, task, expiration, and one use.
7. Redact raw message text by default in logs and failures.
8. Add per-owner message/task rate limits and global child-process limits.
9. Treat repository files, web pages, tool results, and memories as untrusted input.
10. Add startup secret boundary audit.

### Tests

- Unknown sender cannot trigger a Codex child process.
- Unauthorized group participant cannot trigger a task by quoting the owner.
- Pairing code replay and brute force are blocked.
- Model-generated “approved” text does not satisfy approval.
- Modified action payload invalidates prior approval.
- Approval expires and is single-use.
- Malicious repo instruction cannot print protected server environment.
- Logs and failure rows contain no raw credentials or owner handles.

### Acceptance gate

Security test suite passes with process-spawn assertions proving that unauthorized paths stop before Codex execution.

### Suggested sub-agent

An independent security reviewer is strongly recommended. The primary implementation owner remains responsible for fixes.

---

## Release phase — Railway deployment, end-to-end recovery, documentation, and release

### Goal

Make the project genuinely deployable from a clean account and prove it survives realistic failures.

### Current status

The executable production runtime is composed on `main`. Clean-account Railway deployment and protected live-provider evidence remain separate release checks.

### Files to create or change

| File | Change |
|---|---|
| `railway.json` | Application service build, migration, start, health, restart, overlap, and draining settings |
| `src/http/readiness.ts` | Full component readiness |
| `src/index.ts` | Final boot order and graceful shutdown |
| `README.md` | Zero-to-first-message Railway deployment guide |
| `docs/ARCHITECTURE.md` | Final diagrams and extension points |
| `AGENTS.md` | Final coding rules |
| `docs/*` | PRD, model, memory, security, testing, business, docs index |
| `test/e2e/railway-smoke.md` or script | Clean-deploy checklist |
| `test/chaos/*` | Kill/restart/provider outage scenarios |

### Implementation details

1. Create one Railway application service, one PostgreSQL 18 service, and one volume.
2. Set `CODEX_HOME` and workspace root under the volume mount.
3. Use `DATABASE_URL=${{Postgres.DATABASE_URL}}`; never ask the user to copy connection strings manually.
4. Set the encryption key and optional Supermemory/auth configuration as Railway service variables; keep fresh owner, Photon, and ChatGPT setup in the public dashboard and never add a dashboard credential environment value.
5. Start in live-but-not-ready state, then save the owner and connect Photon and ChatGPT from the public dashboard.
6. Keep `railway ssh`, `npm run codex:login`, and `npm run codex:status` documented as an operator fallback.
7. Validate volume permissions and credential storage mode at startup.
8. Run migrations as a pre-deploy command or release step.
9. Execute Railway configuration unit tests and official JSON schema validation in CI.
10. Run clean local and Railway smoke tests.
11. Include a rollback procedure and auth re-enrollment procedure.
12. Generate an `llms.txt` or equivalent Markdown index for implementation agents.

### Tests

- Fresh local install from `.env.example` reaches first authorized message.
- Fresh Railway deploy provisions all resources and reports only expected missing auth.
- Device auth survives restart.
- Kill process during plan, task, synthesis, and each outbound part; state recovers.
- Simulate Spectrum disconnect, database timeout, Supermemory timeout, and expired Codex auth.
- Rollback to prior release without corrupting migrations or queue state.
- Documentation commands are copied and executed exactly.

### Acceptance gate

A reviewer who did not implement the project can deploy it, enroll Codex, send a message, complete a delegated task, restart the service, and complete another task without developer intervention.

### Suggested sub-agent

A release/documentation agent can execute the guide exactly as written. The final integration agent owns merge conflicts, test evidence, and release tagging.

---

## 4. Merge sequence

```text
1. feat/contracts-integration  → contracts-v1 tag
2. feat/postgres-pipeline      → integration
3. feat/spectrum-grpc          → integration
4. feat/codex-runtime          → integration
5. feat/supermemory            → integration
6. orchestration implementation→ integration
7. feat/security-approvals     → integration
8. Railway hosting migration  → main
9. integration hardening       → main through one reviewed PR
```

State can merge before transport because transport targets an ingest interface. Codex and memory can merge in either order. Security must review all composed paths before release.

## 5. Pull-request rules

Each PR must include:

- Scope and owned files.
- Contract changes, if any.
- Primary docs used.
- Tests added and exact command output.
- Migration/recovery impact.
- Security and privacy impact.
- Rollback notes.
- No unrelated formatting or dependency updates.

The integration PR must include a table proving every launch gate and chaos test.
