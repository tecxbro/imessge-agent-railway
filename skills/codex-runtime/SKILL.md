---
name: codex-runtime
summary: Implement or review Codex SDK/CLI authentication, threads, model profiles, sandboxing, process isolation, structured outputs, and cancellation.
---

# Codex Runtime Skill

## Use this skill when

- Editing the Codex SDK wrapper or CLI invocation.
- Adding ChatGPT device auth or API-key mode.
- Starting/resuming/resetting threads.
- Changing GPT-5.6 model profiles or effort settings.
- Changing sandbox, network, working directory, or process environment.
- Debugging cancellation, auth expiry, or missing session state.

## Read first

- `docs/maintainers/MODEL_ROUTING.md`
- `docs/DEPLOYMENT.md`
- `docs/SECURITY_AND_PRIVACY.md`
- `docs/maintainers/IMPLEMENTATION_PLAN.md`, Step 4
- `docs/maintainers/PROVIDER_REFERENCES.md`, OpenAI Codex section
- Current official Codex auth, SDK, sandbox, approval, config, AGENTS, and skills Markdown

## Rules

- Pin `@openai/codex-sdk` and `@openai/codex` together.
- Set `CODEX_HOME` explicitly.
- Treat `auth.json` as a password.
- Pass an explicit child environment allowlist.
- Never pass database, Photon, Supermemory, or encryption secrets.
- Use schema-bound outputs.
- Apply model and permission profiles independently.
- Probe configured model/effort support; no silent fallback.
- `danger-full-access` is prohibited.
- Abort/kill tasks on supersession or timeout.
- Persist thread IDs and bounded recovery summaries.

## Files

- `src/agent/*`
- `src/config/model-profiles.ts`
- `src/config/capabilities.ts`
- `src/security/secret-boundaries.ts`
- Fake CLI and protected live tests

## Required tests

- Missing/expired auth.
- API-key and ChatGPT modes.
- Child environment snapshot.
- Start/resume/reset/recover thread.
- Unsupported `max` effort.
- Sandbox and network mapping.
- Cancellation and process cleanup.
- Malformed and oversized structured output.

## Completion report

Include pinned versions, capability-probe result, auth mode tested, and whether the live test used an actual account.
