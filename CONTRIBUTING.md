# Contributing

Thanks for improving the iMessage Codex Agent template. Keep each change tied to an active user, operational, security, or recovery requirement.

## Before you start

1. Read [`AGENTS.md`](./AGENTS.md), [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md), and the relevant maintainer plan or provider references.
2. Confirm the current branch, worktree, and resolved push URL.
3. Install the pinned dependencies with `npm ci`.
4. Run the nearest existing tests before changing behavior.

Do not commit `.env`, provider credentials, owner handles, database URLs, Codex auth/session files, workspace data, raw messages, or other secrets.

## Scope and architecture

- Keep one concern per change and avoid speculative modules.
- Use Spectrum Cloud's persistent `app.messages` stream; do not add a webhook or second messaging SDK.
- Keep PostgreSQL as the operational source of truth and Supermemory as an optional curated projection.
- Reject unknown senders before persistence, queueing, model work, or child-process creation.
- Keep provider construction in `src/runtime/production-bootstrap.ts` and inject interfaces into domain modules.
- Queue payloads carry identifiers; handlers reload and version-check authoritative state.
- Never enable `danger-full-access`, pass the full parent environment to Codex, or let model output approve an action.

Shared contracts, database migrations, prompt schemas, provider boundaries, and security policies require focused review and compatibility/recovery notes.

## Documentation changes

User deployment, configuration, customization, troubleshooting, architecture, security, and operations guides live under `docs/`. Product requirements, implementation history, test plans, decisions, and provider research live under `docs/maintainers/`.

Run `npm run docs:check` after moving a file, changing an npm command, adding a public environment variable, editing `railway.json`, or changing a production entrypoint.

## Required checks

Run the checks relevant to the change, followed by the repository gates:

```bash
npm run typecheck
npm test
npm run test:security
npm run test:integration
npm run test:chaos
npm run docs:check
npm run build
npm run railway:validate
git diff --check
```

When deployment files change, also validate `railway.json` against Railway's official JSON schema. Database-backed integration tests require a separate disposable database and must not silently count skipped tests as PostgreSQL evidence.

Protected Photon, Codex, Railway, and Supermemory tests require authorized accounts and recipients. Report offline, skipped, blocked, and live evidence separately; never claim a provider path works live unless that path was exercised.

## Commits and pull requests

- Keep commits focused and use an imperative summary.
- Inspect `git diff --check` and the full staged diff before committing.
- Never force-push `main` or rewrite another worktree's branch.
- Explain behavior changed, primary documentation used, checks run, skipped/live evidence, security/privacy impact, migration/recovery impact, and remaining uncertainty.

Security vulnerabilities should follow the private reporting process in [`SECURITY.md`](./SECURITY.md), not a public issue.
