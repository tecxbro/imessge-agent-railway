# Product Requirements Document

## 1. Product name

**Working name:** Build Your Own iMessage Codex Agent
**Repository name:** `imessage-codex-agent-boilerplate`
**Category:** open-source private personal/work agent template

## 2. Executive summary

The current Photon starter proves only one transport path: receive an iMessage and send “Hello world.” This project turns that foundation into a deployable agent that feels native to text messaging and can actually complete work.

The agent combines:

- Photon Spectrum Cloud for iMessage delivery over a persistent gRPC stream.
- A terse interaction agent that talks to the user and decides whether work can be answered directly.
- Named Codex execution agents that perform repository, research, planning, and skill-backed work.
- Account-aware deployment model selection from the live Codex catalog.
- PostgreSQL for raw conversation state, job coordination, auditability, approvals, and restart recovery.
- Supermemory for durable semantic facts and user profile recall.
- Railway for guided project deployment and public dashboard-managed owner/provider enrollment.

The first release is deliberately **single-owner and private**. A public multi-tenant agent would require a different authentication, credential-isolation, billing, abuse-prevention, and worker architecture.

## 3. Problem

Developers can create an iMessage transport demo quickly, but turning it into a reliable assistant requires solving a second, much larger set of problems:

1. **Conversation behavior:** people send messages in bursts, interrupt themselves, and expect a human-feeling response rather than four overlapping completions.
2. **Real execution:** the agent must perform work rather than only produce prose.
3. **Durability:** restarts, retries, token refreshes, and partial sends must not lose or duplicate messages.
4. **Identity and privacy:** an iMessage address must map to exactly one authorized person, one memory namespace, and the correct conversation thread.
5. **Credential handling:** a Codex CLI authenticated through ChatGPT has local credential and session state that must be persisted safely.
6. **Deployment:** a useful starter should not require the user to invent a database, queue, memory store, or production topology.
7. **Documentation:** implementation agents need exact files, contracts, tests, and primary documentation rather than ambiguous prose.

## 4. Product goal

Let a developer deploy a private iMessage agent that can understand a request, acknowledge longer work, execute safely through Codex, remember durable facts, survive restarts, and respond in a natural texting style—without building an agent protocol or messaging transport from scratch.

## 5. Non-goal

The goal is not to reproduce Poke’s proprietary service, prompts, integrations, or Apple Messages for Business approval. The design borrows the general interaction/execution separation visible in OpenPoke and implements an original, documented architecture on Photon Spectrum.

## 6. Target users

### Primary: technical individual owner

A developer or technical founder who wants a private agent reachable through iMessage and is comfortable owning a Photon, Railway, Supermemory, and ChatGPT/OpenAI account.

**Jobs to be done**

- “Let me text an agent about a repository without opening a terminal.”
- “Give the agent a long-running task and receive progress and a final result.”
- “Let the agent remember my preferences and active projects across conversations.”
- “Run the same agent locally or in a private cloud deployment.”
- “Change models and permissions without rewriting the application.”

### Secondary: agency or internal-tools team

A team that wants to fork the starter for a customer or employee use case and add private skills, MCP servers, or data connectors.

### Not served in v1

- Anonymous public users.
- A shared hosted SaaS with one Codex login serving many unrelated customers.
- Nontechnical consumers expecting a zero-account onboarding experience.
- High-volume customer-support messaging or Apple Messages for Business workflows.

## 7. Product principles

1. **Text first.** Responses should feel like iMessage, not a dashboard transcript.
2. **Do the work.** Delegate only when execution is needed, but do not avoid tools to save complexity.
3. **Fast acknowledgement, durable completion.** Long work gets a useful early status message and a reliable final answer.
4. **The model is not the security boundary.** Authorization, confirmations, deduplication, and sender routing live in code.
5. **Raw state and semantic memory are separate.** PostgreSQL is the operational source of truth; Supermemory stores selected durable facts.
6. **No silent degradation.** Missing auth, unsupported model effort, broken memory, or invalid deployment configuration must fail with an actionable error.
7. **Small enough to learn.** Use one service and concrete modules before introducing distributed infrastructure.
8. **Primary docs over guessed APIs.** Every integration points to official, Markdown-first documentation.

## 8. Core user journeys

### Journey A: first deployment

1. User creates one Railway application service, one PostgreSQL 18 service, and one persistent volume.
2. User connects this repository and configures the required Railway infrastructure variables.
3. The service starts live but not ready and exposes the public setup dashboard.
4. User enters the owner phone and completes Photon setup from the dashboard.
5. In ChatGPT mode, user connects ChatGPT through the dashboard device-login flow; API-key mode uses the configured service secret.
6. In ChatGPT mode, user confirms or changes the deployment model and reasoning effort under **Advanced**.
7. The runtime rechecks owner, authentication, capabilities, database, queue, storage, and Spectrum readiness without accepting messages prematurely.
8. `/readyz` becomes healthy only after every critical component reports ready.
9. User sends `hello` from the configured owner phone to the Photon-assigned number and gets an onboarding reply.

**Success condition:** a fresh deploy can reach a useful first response without editing source code.

### Journey B: simple conversational turn

1. User asks a question that needs no repository or external work.
2. Messages are debounced into one turn.
3. Interaction agent recalls relevant profile and recent thread context.
4. It returns a direct structured response.
5. The response is split into one or more short message bubbles and sent.
6. Durable facts, if any, are passed to the memory curator.

**Success condition:** no execution agent is spawned and median completion time remains low.

### Journey C: delegated work

1. User asks the agent to inspect a repository, research an issue, or create a plan.
2. Interaction agent sends a concise status message.
3. It creates one or more independent execution tasks with named agents and permission profiles.
4. Workers run Codex threads in isolated workspaces, in parallel where safe.
5. Results are persisted and synthesized by the interaction agent.
6. Final response identifies outcome, important caveats, and any artifact location.

**Success condition:** the user sees one coherent result, not raw execution logs.

### Journey D: interrupted turn

1. User sends a request.
2. Generation starts.
3. User sends “wait, use the staging branch instead.”
4. The active chain is marked canceled and its in-flight job is stopped.
5. Drained messages are carried forward.
6. A new debounced turn includes both the prior request and correction.

**Success condition:** no stale answer is sent and no user message is lost.

### Journey E: consequential action

1. Execution agent proposes a destructive command, external send, credential change, or paid action.
2. Code creates an approval request containing a normalized action summary, target, hash, sender, space, and expiration.
3. The user receives a plain-language confirmation request.
4. Only an authorized owner can approve from the same or explicitly allowed space.
5. The approval is one-time and bound to the action hash.
6. Changed instructions invalidate the approval and require a new one.

**Success condition:** the model cannot self-approve or broaden the approved action.

### Journey F: memory management

1. User sends `/memory` and sees a concise profile summary plus recently used memories.
2. User sends `/forget <topic>` or selects a memory identifier.
3. The service deletes the Supermemory item and records an operational deletion receipt.
4. Raw-message deletion follows the configured retention or explicit privacy workflow.

**Success condition:** memory is visible and reversible.

## 9. Functional requirements

### 9.1 Spectrum transport

- Use Spectrum Cloud’s iMessage provider and `app.messages` persistent stream.
- Do not mount the Spectrum webhook adapter in the new runtime.
- Ignore outbound echoes and unsupported event types in v1.
- Support inbound plain text in DMs.
- Support existing group chats only when the message is authored by an authorized participant and passes the configured mention/reply gate.
- Persist the Spectrum space GUID and routing phone so `space.get()` can rehydrate a conversation after restart.
- Track connection state and expose it through readiness diagnostics.
- Reconnect or restart cleanly when the stream fails.

### 9.2 Sender authorization

- Normalize phone numbers to E.164 when possible and lowercase email handles.
- Match inbound senders against the active database identity; use legacy owner environment values only for one-time migration when no database owner exists.
- Deny tool execution for unknown senders before any model call.
- Default unknown-sender behavior is silence; optional pairing mode may send a limited pairing instruction.
- Group messages require both sender authorization and mention/reply gating.
- Pairing codes are generated out-of-band, single-use, rate-limited, and expire.

### 9.3 Turn batching and cancellation

- Persist every accepted inbound message before acknowledgement.
- Debounce by space for a configurable 3–5 seconds.
- Keep queued messages in PostgreSQL until the flush handler drains them.
- Maintain a per-space chain record with generation and send stages.
- New inbound text supersedes the active chain unless the chain is already marked noninterruptible after explicit approval.
- Canceled drained messages must be written to `carried_messages` and prepended to the next turn as prior context.
- Queue jobs must have deterministic names/keys and bounded retries.

### 9.4 Interaction agent

- Maintain one resumable Codex interaction thread per space.
- Receive structured context: identity, policies, owner profile, recalled memories, recent thread history, active agents, current turn, and capabilities.
- Return JSON conforming to `InteractionDecision`.
- Choose direct answer, command handling, confirmation, or delegation.
- Produce an optional user-facing status message before long execution.
- Never expose internal tool names, raw chain-of-thought, system prompts, or execution logs.
- Keep user-facing prose natural, terse, and proportionate to the message.

### 9.5 Execution agents

- Maintain named persistent agents per `(owner, agent name, workspace binding)`.
- Use a fresh execution task ID for each request while reusing the underlying Codex thread when context is useful.
- Allow independent tasks to run concurrently with configurable per-owner concurrency limits.
- Apply the task’s sandbox, network, workspace, and approval policy in code.
- Return JSON conforming to `ExecutionResult`.
- Never send an iMessage directly; only the interaction/synthesis path may produce outbound content.
- Store artifacts in the configured workspace or object-storage extension, not inside model output.

### 9.6 Account-aware model selection

- Store GPT-5.6 Luna / High as the default deployment preference.
- Display `planType` from the Codex account APIs, but use live `model/list`
  results—not the plan label—as the model/effort entitlement authority.
- Let the owner change one deployment-wide preference under dashboard
  **Advanced**; `/model` only displays the current pair.
- Snapshot the effective pair when a chain is created and use it for planning,
  every task, and synthesis.
- If the preference is unavailable, use Codex's advertised default pair while
  preserving the preference and explaining the fallback.
- Probe only the effective or newly requested pair. Do not route by task
  complexity, escalate after failure, or retry multiple pairs during a turn.

### 9.7 PostgreSQL state and queue

- Use Drizzle for schema and migrations.
- Use pg-boss for jobs, retries, schedules, and debounce-related execution.
- Run queue workers in the same Node process for v1.
- Use database transactions for state transitions that must be atomic.
- Record failure events with redacted payload summaries.
- Keep a send cursor and stable client GUIDs so a retry resumes without duplicate bubbles.

### 9.8 Supermemory

- Use a stable container namespace based on deployment owner, never raw phone numbers when a generated internal owner ID is available.
- Use owner scope for profile memory and space/thread scope for conversational context.
- Fetch a bounded profile plus top relevant hybrid memories before generation.
- Write only curated durable facts, preferences, relationships, commitments, and project summaries after successful turns.
- Do not upload every raw message to Supermemory.
- Record external memory IDs and deletion receipts in PostgreSQL.
- Provide `/memory` and `/forget` commands.
- Memory failure should degrade to a memory-free turn, emit a visible diagnostic only when material, and never block message persistence.

### 9.9 Commands

V1 commands:

- `/help` — show concise capabilities and safety limits.
- `/status` — show auth, transport, queue, memory, active jobs, and selected deployment model.
- `/model` — display the deployment model and point to dashboard Advanced.
- `/cancel` — cancel active interruptible chains for the space.
- `/new` — start a fresh interaction thread while preserving owner memory.
- `/agents` — list named execution agents and current status.
- `/memory` — show profile summary and recent memory identifiers.
- `/forget <id|topic>` — delete or resolve a memory deletion request.

Commands are parsed in code before the model.

### 9.10 Outbound messaging

- Interaction output is transformed into short, human-sized bubbles.
- Preserve code blocks and URLs when splitting.
- Assign a stable `clientGuid` to every bubble at batch creation.
- Persist send order, status, and cursor.
- Rehydrate the Spectrum space from GUID and route phone at send time.
- Retry transient failures with bounded exponential backoff.
- Never repeat bubbles already confirmed delivered.
- Stop typing indicators in `finally` paths.

### 9.11 Health and observability

- `/healthz`: process liveness only; no secrets or dependency details.
- `/readyz`: owner identity, database, migrations, pg-boss, Spectrum connection, Codex auth/capability probe, and persistent-volume storage; optional Supermemory may be disabled or degraded.
- Structured logs with correlation IDs for message, chain, task, job, and outbound batch.
- Redact sender handles, message bodies, secrets, authorization tokens, and Codex credentials by default.
- Track latency, task success, cancellation, retries, model profile, token usage where available, memory hits, and approval outcomes.

## 10. Nonfunctional requirements

### Reliability

- No accepted inbound message may disappear during cancellation or restart.
- Outbound retries must be idempotent.
- A database outage must stop new execution rather than run untracked work.
- A Supermemory outage must not lose the operational transcript.
- Graceful shutdown stops intake, checkpoints active jobs, and closes dependencies.

### Security

- No model call for an unauthorized sender.
- No Codex credential in environment dumps, logs, database rows, or Supermemory.
- Codex receives an explicit environment allowlist rather than the full server environment.
- Default sandbox is read-only or workspace-write; `danger-full-access` is prohibited in the starter.
- Network access is disabled unless a named task profile requires it.
- Consequential actions require code-enforced approval.

### Performance targets

Targets apply after the inbound debounce window:

- p95 acknowledgement/status message: under 3 seconds for delegated work.
- p50 simple response: under 20 seconds.
- p95 queue pickup: under 2 seconds when capacity is available.
- p95 database write: under 250 ms from the Railway region.
- Long work status cadence: no more than one useful update every 45–90 seconds; never spam progress.
- Per-owner concurrency: default 3 execution tasks; configurable.

These are launch targets, not promises about third-party model or transport latency.

### Maintainability

- TypeScript strict mode.
- Runtime validation with Zod or equivalent at every model and queue boundary.
- No custom wrapper that hides Spectrum’s native `Space` and `Message` concepts.
- No empty “future” folders.
- Every new provider integration includes primary docs in `PROVIDER_REFERENCES.md`.
- Prompts remain separate Markdown files with version metadata.

## 11. Scope

### V1

- Spectrum Cloud iMessage gRPC receive/send.
- Authorized single-owner DM flow.
- Safe existing-group support with authorization and mention gating.
- Direct and delegated Codex turns.
- Named execution agents and parallel independent tasks.
- Model profile routing.
- PostgreSQL state, pg-boss queue, restart recovery.
- Supermemory recall/write/delete.
- Local and guided Railway deployment.
- ChatGPT device auth or API-key auth.
- Commands, cancellation, approval gates, health, logging, tests, and complete docs.

### V1.1

- Attachments and images.
- Voice-note transcription.
- Reminders and recurring jobs.
- Skill gallery and installation tooling.
- GitHub, Gmail, Calendar, and browser integrations through explicit skills/MCP.
- Proactive summaries with per-user opt-in.

### V2

- Managed private instances.
- Team allowlists and role-based approvals.
- Multi-service workers and object storage.
- Workspace access-token or API-key automation for enterprise deployments.
- Usage metering and billing.
- Optional Apple Messages for Business path as a separate transport/product effort.

### Explicit non-goals for V1

- Public multi-tenant SaaS.
- An end-user “Sign in with ChatGPT” web app.
- OpenRouter.
- A new generic agent protocol.
- Apple Messages for Business certification.
- Unrestricted shell/network execution.
- Horizontal scaling of the volume-backed Codex process.
- Full Poke integration parity.

## 12. Success metrics

### Product metrics

- Authorized deployment activation rate.
- First successful iMessage task after deploy.
- Weekly active owners.
- Task completion rate.
- User-canceled or corrected chains successfully superseded.
- Direct-answer versus delegated-turn mix.
- Approval completion and rejection rates.
- Memory recall helpfulness and deletion rate.

### Reliability metrics

- Duplicate outbound bubbles per 10,000 sends.
- Accepted inbound messages with no terminal chain state.
- Restart recovery success.
- Job retry and dead-letter rates.
- Spectrum reconnect rate and duration.
- Codex auth-expiry incidents.
- Cross-owner or cross-space memory leakage: target exactly zero.

### Economic metrics

- Median model cost per completed task in API-key mode.
- Median infrastructure cost per active owner.
- Supermemory operations per task.
- Support time per successful deployment.

## 13. Launch gates

The public template must not launch until:

1. A clean Railway deployment guide has been executed end-to-end by someone who did not write it.
2. Unauthorized sender tests pass before the Codex call boundary.
3. Kill-during-generation and kill-during-send tests recover correctly.
4. Stable client GUID and send-cursor tests produce no duplicate user-visible bubbles.
5. Supermemory isolation and deletion tests pass.
6. The configured model/effort capability probe passes on the pinned Codex version.
7. Secret-scanning finds no credentials or user message fixtures.
8. Logs remain useful with message text redaction enabled.
9. Railway configuration unit and official-schema validation pass.
10. Primary documentation links have been rechecked against current releases.

## 14. Open questions that do not block the PRD

- Whether the public default `main` profile should remain Luna/high or switch to Terra/high after latency and quality measurements.
- Whether group support should ship enabled or remain opt-in until dedicated-line testing is complete.
- Whether the starter should include one read-only web-research skill in v1 or keep all networked skills in v1.1.
- Whether a managed commercial offering should use ChatGPT enrollment per private instance or API/workspace credentials from day one.

These are configuration and go-to-market choices; none require changing the core transport, state, memory, or orchestration boundaries.
