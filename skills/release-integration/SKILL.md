---
name: release-integration
summary: Merge parallel worktrees safely, execute recovery/security evidence, validate Railway deployment, and prepare a release without corrupting main.
---

# Release Integration Skill

## Use this skill when

- Combining transport, state, Codex, memory, security, and deployment branches.
- Resolving shared-contract conflicts.
- Running end-to-end or chaos tests.
- Preparing the Railway service configuration and public documentation.
- Publishing a release candidate.

## Read first

- `docs/maintainers/IMPLEMENTATION_PLAN.md`
- `docs/maintainers/TEST_PLAN.md`
- `docs/maintainers/DECISIONS.md`
- `AGENTS.md`
- `docs/DEPLOYMENT.md`

## Git safety

1. Inspect all worktrees and branches.
2. Never reset or clean another worktree.
3. Merge in the documented order.
4. Resolve shared contracts only in the integration worktree.
5. Run the full suite after every cross-cutting merge.
6. Do not force-push main.
7. Keep release changes separate from unrelated dependency updates.

## Integration checklist

- Contract versions agree.
- Transport imports no Codex runtime.
- Security gates run before process spawn.
- Database migrations and queue version are compatible.
- Codex CLI/SDK/model capability probe passes.
- Supermemory isolation/deletion passes.
- Outbound restart tests show no duplicates.
- Railway configuration passes unit checks and the official JSON schema.
- Clean-room deployment and device auth work.
- Docs and `.env.example` match code.
- Secret scan passes.

## Evidence required

- Exact commits merged.
- Test/chaos/security output.
- Migration and rollback notes.
- Redacted clean deployment evidence.
- Known limitations.
- Primary docs and last verification date.

Do not release when a live provider path is untested and described as working. Mark it explicitly or block the release according to the launch gates.
