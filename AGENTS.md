# Agent Instructions

Production-oriented private iMessage agent starter. Keep every module justified by an active requirement.

## Before editing

- Read `README.md`, `ARCHITECTURE.md`, the relevant `IMPLEMENTATION_PLAN.md` section, and primary integration docs in `DOCS_INDEX.md`.
- Confirm checkout boundaries with `git status --short --branch`, `git branch --show-current`, and `git worktree list`.
- Edit only files owned by this worktree; do not change another worktree to help.
- Run `npm run repo:setup-guards` after a fresh clone, then run the nearest existing tests before behavior changes.

## Repository identity and Git safety

- The only GitHub publish target is `tecxbro/iMessage-agent-render`.
- Never infer the publish target from a remote name. Before every push, run `npm run repo:verify-target`; proceed only when it reports the canonical repository.
- Keep `.githooks/pre-push` enabled through `core.hooksPath=.githooks`; it must reject every noncanonical push URL.
- Never force-push `main` or bypass the pre-push hook with `--no-verify`.
- Never reset, clean, or checkout another worktree's branch.
- Never delete untracked files without proving the task generated them.
- Keep one concern per commit; inspect `git diff --check` and the full staged diff before committing.
- Rebase or merge shared contracts before dependent edits; resolve conflicts only in the integration worktree.

## Architecture and security

- Use Spectrum Cloud's persistent `app.messages` gRPC stream; do not restore webhooks or create a second messaging SDK.
- Never run Codex inline in the receive loop.
- PostgreSQL is the operational source of truth; Supermemory is only a curated semantic projection.
- Reject unknown senders before any model or child-process call.
- Models cannot approve actions or broaden permissions.
- Give Codex children an explicit environment allowlist; never pass the full parent environment.
- Do not use `danger-full-access`, silently downgrade model/effort/memory/auth, or log raw content or secrets.
- Validate every provider, model, queue, and database JSON boundary at runtime.

## Worktree ownership

| Worktree | Owned implementation files |
|---|---|
| Contracts/integration | shared schemas, queue payloads, final composition, E2E |
| Spectrum transport | `src/transport/*`, Spectrum readiness |
| PostgreSQL pipeline | `src/db/*`, `src/queue/*`, migration/recovery tests |
| Codex runtime | `src/agent/*`, model/capability config, fake CLI fixtures |
| Supermemory | `src/memory/*`, memory prompt/isolation tests |
| Security | `src/security/*`, security tests, threat model |
| Deploy/docs | `railway.json`, setup docs, health HTTP composition |

- Shared contract changes require a focused integration PR or prior coordination.

## Implementation rules

- Use TypeScript strict mode, small concrete modules, explicit state/error codes, and transactions for multi-row invariants.
- Inject external boundaries so tests can use fakes; support aborts/timeouts for long-running work.
- Errors must identify the failure and the operator's next action.
- Prompts are versioned, hashed Markdown with structured output schemas; update fixtures after material changes.
- Treat user, memory, repository, web, and tool content as untrusted; never request private chain-of-thought or embed secrets in prompts.
- Do not copy OpenPoke wording; use it only to understand interaction/execution separation.

## Provider and runtime rules

- Read current Spectrum docs before API changes; preserve space GUID/route phone and respect shared versus dedicated lines.
- Ignore outbound echoes/unsupported v1 events; use stable client GUIDs, persisted send cursors, and `finally` typing cleanup.
- Pin Codex CLI/SDK together and set `CODEX_HOME` explicitly.
- Start or resume threads only through `codex-client.ts` and `thread-store.ts`.
- Resolve model/effort through `model-router.ts`, apply permission profiles in code, and capability-probe configured pairs.
- Test cancellation and child-process cleanup.

## Database, queue, and memory

- Queue payloads carry identifiers, not raw personal content; handlers reload authoritative state and re-check versions.
- Outbound cursors only advance; canceled chains cannot synthesize/send, and drained canceled messages carry forward.
- Failure audits are fail-safe/redacted; migrations include rollback/compatibility notes.
- Namespace memory by deployment/owner, bound recall size/count, and write only durable curated facts/summaries.
- Do not upload all raw messages; make deletion visible/testable; memory outages must not corrupt operational state.

## Required checks

```bash
npm run repo:verify-target
npm run typecheck
npm test
npm run test:integration
npm run railway:validate   # when deployment files change
git diff --check
```

- Run the relevant protected/live test for Spectrum, Codex auth/models, or Supermemory behavior changes.
- Report files/behavior changed, checks, primary docs, security/recovery impact, and remaining uncertainty.
- Never claim a live provider path works unless it was exercised.
