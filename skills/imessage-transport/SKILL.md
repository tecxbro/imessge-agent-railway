---
name: imessage-transport
summary: Implement or review Photon Spectrum Cloud gRPC receive/send behavior, space routing, and restart-safe iMessage delivery in this repository.
---

# iMessage Transport Skill

## Use this skill when

- Replacing or changing Spectrum initialization.
- Editing the persistent `app.messages` loop.
- Narrowing iMessage senders/spaces.
- Rehydrating spaces after restart.
- Changing typing, replies, outbound splitting, stable client GUIDs, or routing phones.
- Investigating shared-pool versus dedicated-line behavior.

## Read first

- `docs/ARCHITECTURE.md`
- `docs/maintainers/IMPLEMENTATION_PLAN.md`, Step 2
- `docs/maintainers/REPOSITORY_BLUEPRINT.md`
- `docs/maintainers/PROVIDER_REFERENCES.md`, Photon Spectrum section
- Current Spectrum `llms.txt` and official routing/recovery source docs

## Rules

- Use Spectrum Cloud gRPC; do not restore the webhook adapter.
- Do not run Codex or Supermemory in the receive loop.
- Authorize before model work.
- Persist external message ID, space GUID, and route phone.
- Ignore outbound echoes and unsupported event types in v1.
- Use native `space.send`, `space.responding`, and provider narrowing.
- Rehydrate with the platform’s `space.get()` API.
- Preserve stable client GUID and send-cursor invariants.
- Respect group and multi-line limitations.

## Files

- `src/transport/*`
- Spectrum component of `src/http/readiness.ts`
- Transport fixtures and live smoke tests

## Required tests

- Inbound text, outbound echo, unsupported event.
- Sender normalization and authorization handoff.
- Duplicate event ingestion.
- Space rehydration with/without route phone.
- Stream disconnect and readiness behavior.
- Partial-send retry with identical client GUID.

## Completion report

Name exact Spectrum docs/version used and whether a real development line was exercised. Do not claim live compatibility from mocks alone.
