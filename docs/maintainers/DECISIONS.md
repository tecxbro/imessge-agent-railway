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

**Decision:** the operator completes Codex device auth once through the public deployment dashboard or a private local/Railway SSH recovery shell; API-key mode is the automation alternative.

**Why:** the dashboard starts the supported device-code protocol and polls server-authored state; it does not invent an OAuth callback. Codex SDK wraps the CLI and uses local credential/session state under `CODEX_HOME`. The starter should represent this accurately.

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

**Status:** Superseded by ADR-020.

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

## ADR-014 — No attachment/voice support in v1

**Decision:** text DMs first, with safe existing-group support.

**Why:** transport, identity, recovery, Codex, and memory correctness are the release blockers. Rich media is a bounded follow-up once text is reliable.

## ADR-016 — Store the single owner identity through dashboard onboarding

**Decision:** new Railway deployments never ask for the owner phone as a service variable. The dashboard accepts one E.164 personal phone through a same-origin-protected route. PostgreSQL `channel_identities` is the authorization authority: the phone is encrypted, fingerprinted per deployment, and returned only as a mask. Replacing it activates the new identity and revokes prior owner-phone identities transactionally. Photon resolves this database owner once per setup attempt; its separately assigned line remains the destination shown at completion. ADR-018 keeps the phone in dashboard onboarding instead of fresh-deployment environment configuration.

Existing deployments first prefer an active database owner, then import `OWNER_PHONE_NUMBER`, the former long owner alias, or one unambiguous E.164 `AGENT_OWNER_HANDLES` value. Stored Photon metadata is never imported as authorization. Ambiguous handles require explicit dashboard recovery, and old environment values remain until an operator removes them after verification.

**Why:** sender authorization must survive restart without making provider credentials or a deployment form the authority. Separating the personal owner phone from the assigned agent line also makes the onboarding contract accurate.

**Rejected:** query/header/cookie/path phone inputs, plaintext/settings/provider authorization, silently selecting one legacy handle, overwriting an active database identity from the environment, or starting Spectrum before owner setup.

## ADR-018 — Keep onboarding values out of the deployment environment

**Decision:** fresh Railway services configure no owner or dashboard credential environment value.
Startup rejects the obsolete `AGENT_PASSWORD` and `DASHBOARD_SETUP_SECRET`
keys so they cannot silently become active again. The owner phone remains
dashboard-managed and persisted through `channel_identities`. Setup mutations require a matching `Origin` and reject
cross-site fetch metadata.

**Why:** this keeps Railway deployment free of manually supplied onboarding
values while preserving PostgreSQL as the owner-authorization authority and
the dashboard as the owner, Photon, and ChatGPT setup flow.

**Rejected for this release:** adding dashboard credential values to the
deployment environment, moving the owner phone back into Railway service variables, or
using stored provider metadata as sender authorization.

## ADR-019 — Default dashboard phone entry to the United States

**Decision:** keep the owner identity canonical as strict E.164, but make the dashboard input boundary U.S.-first. The default form adds the `+1` country code to a valid U.S. national number. A link-style **Not in the U.S.?** disclosure exposes a native country selector; selected-country national input and complete international input are accepted only when they identify a valid number for that country. The server performs normalization and country validation before the existing identity controller persists or provisions the owner.

The owner setup route accepts exact `{ countryCode, phoneNumber }` dashboard JSON and retains the former exact `{ phoneNumber }` E.164 shape for compatibility. Existing environment migration inputs remain strict E.164. No browser locale, IP geolocation, database migration, readiness change, or deployment prompt is introduced.

**Why:** the product assumes most deployers are in the United States, so requiring them to understand or type `+1` adds avoidable onboarding friction. Keeping validation server-side preserves the authorization, masking, replacement, and Photon contracts while still giving international owners an explicit path.

**Rejected:** requiring E.164 in the default field, inferring country from IP or browser locale, maintaining a hand-written calling-code table, trusting browser-only normalization, or weakening canonical storage validation.

## ADR-020 — Account-aware deployment model selection

**Decision:** store GPT-5.6 Luna / High as the default deployment preference.
After ChatGPT sign-in, use Codex `model/list` as the authoritative visible
model/effort catalog and `account/read` or `account/updated` only for displayed
plan metadata. The dashboard Advanced picker changes one deployment-wide
preference. Each new chain snapshots the effective pair and planning,
execution, and synthesis all use it.

When the exact preference is unavailable, use Codex's advertised default model
and default effort without overwriting the preference. Probe only the effective
pair for readiness and probe a requested pair before saving it.

**Why:** account entitlements vary and Codex explicitly exposes the current
picker contract. Separating preferred and effective state keeps a deployment
usable when Luna High is absent while allowing it to return automatically when
the account later advertises it.

**Rejected:** hard-coded plan entitlement tables, request-complexity routing,
five static profiles, per-space overrides, model-generated profile choice,
automatic escalation, repeated pair retries, environment-based model policy,
and deleting legacy profile columns in the same compatibility migration.
