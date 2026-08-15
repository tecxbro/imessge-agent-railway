# Markdown-First Documentation Index

**Last verified:** August 15, 2026

Use the Markdown/LLM-friendly sources first. When a provider does not expose a stable Markdown page for a specific topic, the normal official page or official GitHub source is listed.

## 0. This repository

- LLM-oriented implementation index: [`docs/llms.txt`](./docs/llms.txt)
- Deployment and authentication: [`DEPLOYMENT_AND_AUTH.md`](./DEPLOYMENT_AND_AUTH.md)
- Operations and rollback: [`docs/OPERATIONS.md`](./docs/OPERATIONS.md)
- Clean local/Railway evidence checklist: [`test/e2e/railway-smoke.md`](./test/e2e/railway-smoke.md)

The local index distinguishes implemented modules, intended contracts, and protected/live evidence. Do not infer provider success from an offline test.

## 1. Source repository

- Starter repository: <https://github.com/tecxbro/iMessage-boiler-plate->
- Starter README: <https://github.com/tecxbro/iMessage-boiler-plate-/blob/main/README.md>
- Starter architecture: <https://github.com/tecxbro/iMessage-boiler-plate-/blob/main/ARCHITECTURE.md>
- Starter coding rules: <https://github.com/tecxbro/iMessage-boiler-plate-/blob/main/AGENTS.md>

## 2. Photon Spectrum

### Preferred index

- <https://photon.codes/docs/llms.txt>

### Official source documentation

- Spectrum TypeScript repository: <https://github.com/photon-hq/spectrum-ts>
- iMessage connection and routing: <https://github.com/photon-hq/spectrum-ts/blob/main/docs/providers/imessage/connection-and-routing.mdx.vel>
- Spaces and users: <https://github.com/photon-hq/spectrum-ts/blob/main/docs/spaces-and-users.mdx.vel>
- Production architecture: <https://github.com/photon-hq/spectrum-ts/blob/main/docs/best-practices/architecture.mdx.vel>
- Inbound pipeline: <https://github.com/photon-hq/spectrum-ts/blob/main/docs/best-practices/inbound-pipeline.mdx.vel>
- Recovery and state: <https://github.com/photon-hq/spectrum-ts/blob/main/docs/best-practices/recovery-and-state.mdx.vel>

### Topics implementation agents must read

- `Spectrum({ projectId, projectSecret, providers: [imessage.config()] })`
- `for await (const [space, message] of app.messages)`
- `space.send`, `message.reply`, `space.responding`
- iMessage shared versus dedicated lines
- `imessage(app).space.get(spaceGuid, { phone })`
- token renewal, groups, quotas, and per-phone routing

## 3. OpenAI Codex

### Preferred official Markdown index

- <https://learn.chatgpt.com/docs/llms.txt>

### Authentication and runtime

- Authentication: <https://learn.chatgpt.com/docs/auth.md>
- Codex SDK: <https://learn.chatgpt.com/docs/codex-sdk.md>
- Sandboxing: <https://learn.chatgpt.com/docs/sandboxing.md>
- Agent approvals and security: <https://learn.chatgpt.com/docs/agent-approvals-security.md>
- Config reference: <https://learn.chatgpt.com/docs/config-file/config-reference.md>
- Git worktrees: <https://learn.chatgpt.com/docs/environments/git-worktrees.md>

### Agent instructions and skills

- AGENTS.md behavior: <https://learn.chatgpt.com/docs/agent-configuration/agents-md.md>
- Build skills: <https://learn.chatgpt.com/docs/build-skills.md>

### Official GitHub Markdown

- TypeScript SDK README: <https://github.com/openai/codex/blob/main/sdk/typescript/README.md>
- Authentication shim: <https://github.com/openai/codex/blob/main/docs/authentication.md>
- Install: <https://github.com/openai/codex/blob/main/docs/install.md>
- Sandbox: <https://github.com/openai/codex/blob/main/docs/sandbox.md>
- Skills: <https://github.com/openai/codex/blob/main/docs/skills.md>
- AGENTS.md: <https://github.com/openai/codex/blob/main/docs/agents_md.md>

### Verify before implementation

- Current CLI and SDK versions.
- `codex login --device-auth` and `codex login status` behavior.
- `CODEX_HOME`, `auth.json`, and credential-store configuration.
- Exact configured GPT-5.6 model identifiers and reasoning efforts.
- Whether the pinned TypeScript SDK accepts `max` directly or requires a raw config/CLI path.

## 4. Supermemory

- Documentation index: <https://supermemory.ai/docs/llms.txt>
- Documentation home: <https://supermemory.ai/docs>
- TypeScript SDK/package source: use the SDK link exposed by the current `llms.txt` index.

Topics:

- TypeScript client initialization.
- Containers/tags and tenant isolation.
- User profile and memory search.
- Add/update/delete memory.
- Hybrid search.
- Convex and Codex integration notes where relevant.

## 5. Railway

- Documentation index: <https://docs.railway.com/llms.txt>
- Config as Code reference: <https://docs.railway.com/config-as-code/reference>
- Variables reference: <https://docs.railway.com/variables/reference>
- PostgreSQL: <https://docs.railway.com/databases/postgresql>
- Volumes: <https://docs.railway.com/volumes/reference>
- Health checks: <https://docs.railway.com/deployments/healthchecks>
- GitHub autodeploys and Wait for CI: <https://docs.railway.com/deployments/github-autodeploys>
- SSH: <https://docs.railway.com/cli/ssh>

Validate `railway.json` against Railway's live official JSON schema in CI.

## 6. PostgreSQL, Drizzle, and pg-boss

- Drizzle documentation index: <https://orm.drizzle.team/llms.txt>
- Drizzle documentation: <https://orm.drizzle.team/docs/overview>
- pg-boss README: <https://github.com/timgit/pg-boss/blob/master/README.md>
- pg-boss docs index: <https://github.com/timgit/pg-boss/blob/master/docs/readme.md>
- PostgreSQL documentation: <https://www.postgresql.org/docs/>

Read current Node/PostgreSQL requirements for the pinned pg-boss release.

## 7. Convex alternative

- Convex documentation index: <https://docs.convex.dev/llms.txt>
- Convex docs: <https://docs.convex.dev/>
- Deployment: <https://docs.convex.dev/production/hosting>

Use only when choosing the architecture in `CONVEX_VARIANT.md`; do not mix Convex and PostgreSQL as competing operational sources of truth.

## 8. OpenPoke reference

- Repository: <https://github.com/shlokkhemani/openpoke>
- Interaction prompt: <https://github.com/shlokkhemani/openpoke/blob/main/server/agents/interaction_agent/system_prompt.md>
- Execution prompt: <https://github.com/shlokkhemani/openpoke/blob/main/server/agents/execution_agent/system_prompt.md>
- Interaction runtime: <https://github.com/shlokkhemani/openpoke/blob/main/server/agents/interaction_agent/runtime.py>
- Batch manager: <https://github.com/shlokkhemani/openpoke/blob/main/server/agents/execution_agent/batch_manager.py>

Use as architectural research. Write original prompts and implementation.

## 9. Poke market references

These are normal article links because they are not vendor documentation:

- <https://techcrunch.com/2026/06/04/apple-approves-poke-as-the-first-ai-agent-on-its-messages-for-business-platform/>
- <https://finance.yahoo.com/technology/ai/articles/why-cognition-bought-poke-ai-180732638.html>
- <https://www.ithome.com.tw/news/177650>

## 10. General TypeScript/runtime references

- Zod: <https://zod.dev/>
- Pino: <https://getpino.io/>
- Vitest: <https://vitest.dev/guide/>
- Node.js: <https://nodejs.org/docs/latest/api/>

## 11. Documentation update rule

Before each public release:

1. Re-fetch every `llms.txt` index.
2. Recheck pinned package requirements and breaking changes.
3. Re-run model/effort capability probes.
4. Validate Railway configuration fields against the official schema.
5. Update the “last verified” date and release notes.
6. Do not leave a dead link silently; replace it with the current official source and explain the change.
