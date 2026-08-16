---
name: supermemory
summary: Implement or review owner-scoped Supermemory recall, curation, deletion, receipts, and cross-user isolation.
---

# Supermemory Skill

## Use this skill when

- Adding or changing memory retrieval.
- Writing durable memory candidates.
- Modifying container/tag namespaces.
- Implementing `/memory` or `/forget`.
- Debugging duplicate, stale, or cross-user memory.

## Read first

- `docs/maintainers/DATA_MODEL.md`, memory tables
- `docs/maintainers/IMPLEMENTATION_PLAN.md`, Step 6
- `docs/SECURITY_AND_PRIVACY.md`
- `prompts/memory-curator.system.md`
- `docs/maintainers/PROVIDER_REFERENCES.md`, Supermemory section
- Current Supermemory `llms.txt`

## Rules

- PostgreSQL remains the operational source of truth.
- Namespace with internal deployment and owner IDs.
- Separate owner profile from thread/space context.
- Bound recall count and character budget.
- Treat recalled memory as untrusted context.
- Write only durable curated facts/summaries after successful turns.
- Do not upload raw transcripts by default.
- Hash candidates to deduplicate.
- Store external IDs and operation receipts.
- Memory timeout degrades safely without blocking the turn.
- Deletion must be visible, auditable, and tested.

## Files

- `src/memory/*`
- `src/queue/handlers/memory-curate.ts`
- Memory command handlers
- Isolation and deletion tests

## Required tests

- Owner isolation.
- DM/group profile sharing with separate thread context.
- Temporary versus durable candidates.
- Duplicate writes.
- Timeout/rate-limit fallback.
- Delete and no stale recall.

## Completion report

State the exact namespace format, retention/deletion behavior, and live SDK operations tested.
