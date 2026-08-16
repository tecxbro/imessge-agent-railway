# Architecture Decisions

## ADR-001 — Use Spectrum Cloud gRPC, not the starter webhook

**Decision:** consume `app.messages` through the cloud iMessage provider.

**Why:** it is the requested protocol, supports a continuously running agent, removes webhook registration/signing-secret setup, and matches the restart-safe `space.get()` routing design.

**Rejected:** retaining `@spectrum-ts/express` for convenience. It would preserve the old transport rather than build the requested one.

## ADR-002 — PostgreSQL is the default operational store

**Decision:** use Railway PostgreSQL, Drizzle, and pg-boss.

**Why:** Railway can host and privately wire the database in the same project; one system can own transcript, identities, queues, approvals, idempotency, and audit data.

**Rejected:** Convex as default. It is technically viable but requires a separate project/deployment flow, weakening the guided single-project installation. See `CONVEX_VARIANT.md`.

## ADR-003 — Supermemory stores curated semantic memory only

**Decision:** raw messages and operational state stay in PostgreSQL; selected durable facts and summaries go to Supermemory.

**Why:** semantic retrieval is valuable but should not control authorization, routing, retries, or recovery. Uploading every message also increases privacy exposure and cost.

**Rejected:** Supermemory as the only database and “write every message” memory.

## ADR-004 — Single-owner private deployment in v1

**Decision:** one private installation is controlled by one owner, with optional allowlisted collaborators later.

**Why:** ChatGPT/Codex credentials, private workspaces, and iMessage identity require strong isolation. Public multi-tenancy is a separate product architecture.

**Rejected:** one shared ChatGPT login serving arbitrary public users.

## ADR-005 — ChatGPT login is deployment enrollment, not web OAuth

**Decision:** the operator completes Codex device auth once through the private setup flow or Railway SSH recovery path; API-key mode is the automation alternative.

**Why:** Codex SDK wraps the CLI and uses local credential/session state. The starter should represent this accurately.

**Rejected:** building a fake “Sign in with ChatGPT” callback flow around unsupported assumptions.

## ADR-006 — One service, durable jobs

**Decision:** run Spectrum consumer, pg-boss workers, and HTTP health server in one Node process.

**Why:** preserves the starter’s teachability and one-service deployment while durable jobs make later worker separation possible.

**Rejected:** multiple application services, Redis, and distributed workers in v1.

## ADR-007 — Persistent volume for Codex state and workspaces

**Decision:** mount one Railway volume and set `CODEX_HOME` plus workspace root under it.

**Why:** ChatGPT credentials and Codex sessions must survive restart; workspaces may contain task artifacts.

**Constraint:** the service remains single-instance. Horizontal scale requires a new credential/workspace architecture.

## ADR-008 — Interaction and execution agents are separate

**Decision:** a user-facing interaction thread decides and synthesizes; named execution threads perform bounded work.

**Why:** keeps conversation concise, enables parallel work, isolates permissions, and preserves reusable worker context.

**Rejected:** one unrestricted monolithic agent with full transcript, tools, and user messaging.

## ADR-009 — Code owns acknowledgement and safety behavior

**Decision:** status-message timing, command parsing, sender authorization, approvals, cancellation, and idempotency are enforced in code.

**Why:** prompt-only requirements are probabilistic and fail silently.

**Rejected:** instructing the model to “always acknowledge,” “always remember,” or “always confirm” without deterministic fallback.

## ADR-010 — Configurable GPT-5.6 profiles with explicit capability probes

**Decision:** expose Luna, Terra, and Sol profiles; verify configured model/effort pairs at startup.

**Why:** the user requested configurable routing, and SDK/CLI support for new effort values can lag documentation.

**Rejected:** hard-coding one model or silently mapping unsupported `max` to another effort.

## ADR-011 — Native Spectrum concepts remain visible

**Decision:** modules use `Space`, `Message`, provider narrowing, `space.send`, and `space.get` directly.

**Why:** the repository teaches Spectrum and avoids a second unofficial messaging SDK.

**Rejected:** generic `sendText()`/`getConversation()` wrappers that obscure provider behavior.

## ADR-012 — Original prompts, OpenPoke as research only

**Decision:** write new schema-bound interaction/execution prompts.

**Why:** the product needs different runtime, memory, permissions, models, and messaging rules, and should not present copied text as original work.

## ADR-013 — No public admin UI in v1

**Decision:** HTTP exposes health/readiness only; operator actions happen through private shell/CLI and iMessage commands.

**Why:** an admin UI would add another auth surface unrelated to the primary product.

## ADR-014 — No attachment/voice support in v1

**Decision:** text DMs first, with safe existing-group support.

**Why:** transport, identity, recovery, Codex, and memory correctness are the release blockers. Rich media is a bounded follow-up once text is reliable.
