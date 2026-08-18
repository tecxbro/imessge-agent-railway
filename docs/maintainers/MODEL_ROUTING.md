# Account-aware model selection

## 1. Product contract

Every deployment stores this owner preference by default:

```text
Model: GPT-5.6 Luna
Reasoning: High
```

The setting is deployment-wide and is changed only through **Dashboard →
Advanced**. There is no request-complexity router, per-space override,
automatic escalation, or retry loop across models and efforts. `/model` is a
read-only view of the deployment selection.

Model choice remains independent from permissions. Changing the model cannot
broaden workspace, network, write, approval, or secret access.

## 2. Account authority

In ChatGPT mode, [Codex App Server](https://developers.openai.com/codex/app-server)
is the entitlement authority:

- `account/read` and `account/updated` provide the displayed `planType`;
- `model/list` provides visible models, supported reasoning efforts, and the
  provider-recommended defaults; and
- every `model/list` cursor is followed with `includeHidden: false`.

The plan name is metadata, not an entitlement table. The application never
infers model access from Free, Go, Plus, Pro, Business, or Enterprise labels.
It does not expose the account email or persist the full model catalog.

## 3. Preferred and effective selection

PostgreSQL keeps the owner preference separate from the effective pair:

1. Use the preferred model and effort when that exact pair is advertised.
2. Otherwise use the model marked `isDefault` and its
   `defaultReasoningEffort`.
3. If no model is marked default, use the first visible model and its default
   effort.
4. If no visible model exists, mark model selection unavailable and keep
   intake not ready.

A fallback never overwrites the stored preference. Advanced shows both the
preferred and active values and explains that Luna High is unavailable for the
current account. A later catalog refresh can therefore restore the preferred
pair automatically.

## 4. Chain consistency

When inbound messages create a chain, the deployment's current effective
`modelId`, `reasoningEffort`, and selection source are copied into the chain.
Planning, every delegated execution task, and final synthesis load that same
snapshot. A dashboard change affects the next chain; work already running does
not change models.

Legacy deployment, space, chain, task, and agent-thread profile columns remain
for migration compatibility. The runtime does not read them. Where a legacy
non-null column still requires a value, code writes `main` only as inert
compatibility data.

## 5. Validation and readiness

Before saving an Advanced selection, the server:

1. refreshes the visible Codex catalog;
2. verifies the exact model and effort are still advertised;
3. runs one bounded probe of that exact pair; and
4. persists the preference only after the probe succeeds.

Readiness refreshes account capabilities, resolves the effective pair, and
probes only that pair. Unsupported unused models do not affect readiness.
Account/catalog changes re-run the resolution and readiness probe. The runtime
never substitutes another pair during a user turn.

API-key mode has no ChatGPT catalog, so it activates only the stored preference
after that exact pair passes the same bounded probe. The ChatGPT-only Advanced
picker is not rendered.

## 6. HTTP boundary

`GET /api/settings/model` returns plan metadata, preferred/effective state, and
only picker-safe visible model fields. `PUT /api/settings/model` accepts an
exact `{ modelId, reasoningEffort }` object, requires the dashboard's
same-origin boundary, refreshes and probes server-side, and returns stable
malformed, stale, rejected-pair, or unavailable error codes. Both responses
are private and `no-store`.

## 7. Verification

Tests cover account updates and pagination, fallback resolution, malformed
provider responses, logout, exact API validation, same-origin writes, dynamic
effort options, Luna High restoration, chain snapshots, restart persistence,
and identical planning/execution/synthesis selection. Protected live Codex
evidence remains a separate release gate.
