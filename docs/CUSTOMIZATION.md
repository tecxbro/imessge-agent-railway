# Customize the Agent

Use the narrowest change that matches the desired behavior. Prompt and configuration changes are usually safer than adding a new provider or runtime path.

## Customization map

| What you want to change | File or setting |
|---|---|
| Agent personality and conversational style | `prompts/interaction.system.md`, `prompts/voice-policy.md` |
| How execution tasks behave | `prompts/execution.system.md` |
| Approval rules | `prompts/approval-policy.md` |
| Models and reasoning effort | **Advanced** in the deployment dashboard |
| Who can message the agent | **Change phone number** in the public deployment dashboard |
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

Connect ChatGPT, then use **Advanced** in the deployment dashboard. The picker
shows only models and efforts from the live Codex account catalog. The default
preference is GPT-5.6 Luna / High; a Codex-advertised fallback is shown
separately and never overwrites that preference. Changes apply to new chains,
not work already running.

## Authorized senders

Use **Change phone number** in the public deployment dashboard for the primary single-owner flow. The server normalizes the phone to E.164, encrypts it in PostgreSQL, activates the new identity, and revokes prior owner-phone identities.

`OWNER_PHONE_NUMBER` remains only as an existing-deployment migration input:

```dotenv
OWNER_PHONE_NUMBER=+15551234567
```

`AGENT_OWNER_HANDLES` is also a legacy migration input. The runtime imports it automatically only when it contains exactly one E.164 phone; multiple handles or an email identity require saving the intended phone in the dashboard:

```dotenv
AGENT_OWNER_HANDLES=+15551234567
```

Spectrum line setup and application authorization are different boundaries. Changing the Photon project does not authorize a sender. After changing the owner, test both the new owner and the revoked prior owner.

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
