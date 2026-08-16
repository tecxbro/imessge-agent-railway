# Customize the Agent

Use the narrowest change that matches the desired behavior. Prompt and configuration changes are usually safer than adding a new provider or runtime path.

## Customization map

| What you want to change | File or setting |
|---|---|
| Agent personality and conversational style | `prompts/interaction.system.md`, `prompts/voice-policy.md` |
| How execution tasks behave | `prompts/execution.system.md` |
| Approval rules | `prompts/approval-policy.md` |
| Models and reasoning effort | `.env` model variables |
| Who can message the agent | `OWNER_PHONE_NUMBER` or legacy `AGENT_OWNER_HANDLES` |
| Semantic memory | `SUPERMEMORY_API_KEY` |
| Railway service, database, volume, and networking | Railway project settings |
| Concurrency and runtime limits | `.env` |
| Add tools or capabilities | `src/runtime/production-bootstrap.ts` and the capability provider |

## Personality and voice

Edit:

- `prompts/interaction.system.md` for interaction decisions, response behavior, and planning boundaries; and
- `prompts/voice-policy.md` for conversational tone and user-visible wording.

Prompts are versioned, hashed Markdown with structured output schemas. Preserve the required schema and trust-boundary instructions. After a material prompt change, update affected fixtures and run prompt/schema tests.

## Execution behavior

Edit `prompts/execution.system.md` for bounded task-execution instructions. Execution agents cannot message the user, approve their own action, broaden permissions, or receive unrelated secrets.

The default Railway deployment has no code-owned workspace capability on a blank volume, so conversational turns can answer directly but repository execution is unavailable. Adding execution requires an explicit workspace binding and capability provider in `src/runtime/production-bootstrap.ts`. Define its authorization, sandbox, network, recovery, and test contract before enabling it.

## Approval policy

Edit `prompts/approval-policy.md` only alongside the code-owned approval policy. Model output is never proof of approval. Consequential actions must remain bound to an immutable normalized payload, owner, space, task, expiration, and one-time consumption.

Do not make a prompt change that allows the model to approve, reinterpret, or broaden an action.

## Models and reasoning effort

Change the `MODEL_*` and `MODEL_*_EFFORT` variables documented in [Configuration](./CONFIGURATION.md). The model router selects profiles in code and probes configured pairs before Spectrum starts.

Keep `ALLOW_REASONING_FALLBACK=false` unless a reviewed product requirement permits fallback. Never silently downgrade the configured model, effort, authentication mode, memory policy, or permissions.

## Authorized senders

Set `OWNER_PHONE_NUMBER` for the primary single-owner flow:

```dotenv
OWNER_PHONE_NUMBER=+15551234567
```

Existing deployments may keep `AGENT_OWNER_HANDLES` with comma-separated E.164 phone numbers or email addresses:

```dotenv
AGENT_OWNER_HANDLES=+15551234567,owner@example.com
```

Spectrum line setup and the application allowlist are different boundaries. Changing the Photon project does not authorize a sender. Restart after modifying the allowlist and test both one allowed and one denied identity.

## Semantic memory

Set `SUPERMEMORY_API_KEY` to enable the optional memory provider, or leave it blank to disable memory. `SUPERMEMORY_CONTAINER_PREFIX` changes only the namespace prefix.

Memory must remain deployment/owner scoped, bounded in count and size, and limited to curated durable facts or summaries. Do not upload raw message history or move authorization, queue, approval, or delivery state out of PostgreSQL.

## Railway resources

Edit `railway.json` only for application build/deploy settings. Manage the application service, PostgreSQL service, volume, variables, and networking in the Railway project. Validate file fields with `npm run railway:validate` and Railway's official JSON schema.

The attached volume makes the application service single-instance. Horizontal scaling requires a separate architecture decision for credentials, workspaces, intake ownership, and failover.

## Concurrency, limits, and retention

Use `.env` variables for debounce, concurrency, rate limits, task runtime, retention, and logging. Stay within the schema ranges in [Configuration](./CONFIGURATION.md).

Increasing concurrency or runtime limits changes cost and cancellation pressure. Increasing retention changes privacy exposure. Keep `LOG_MESSAGE_CONTENT=false` unless raw-content logging is an explicit reviewed requirement.

## Add a tool or capability

1. Define the user-visible requirement and the exact allowed action.
2. Add a narrow injected interface in the domain module.
3. Construct the real provider adapter in `src/runtime/production-bootstrap.ts`.
4. Add a code-owned permission profile and immutable approval envelope when the action is consequential.
5. Pass only required environment variables to child processes.
6. Define timeout, cancellation, idempotency, recovery, and redacted failure codes.
7. Add fake/unit coverage and a protected live test for the provider path.

Do not add a second messaging SDK, run Codex inline in the Spectrum receive loop, use `danger-full-access`, or treat Supermemory as operational state.

## Verify a customization

Run the nearest tests for the changed surface, then the required suite:

```bash
npm run typecheck
npm test
npm run test:security
npm run test:integration
npm run test:chaos
npm run docs:check
npm run railway:validate
```

Run protected live tests only with authorized credentials and recipients. Report offline, skipped, blocked, and live evidence separately.
