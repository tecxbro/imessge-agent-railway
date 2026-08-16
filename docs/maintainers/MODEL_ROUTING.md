# Model Routing

## 1. Goals

- Make latency, quality, and cost explicit.
- Preserve the requested Luna-centered experience while keeping Terra and Sol available.
- Let the deployer change models without editing orchestration code.
- Prevent unsupported effort settings from silently degrading.
- Keep model selection separate from permissions: a stronger model does not receive broader access.

## 2. Profiles

| Profile | Default model | Effort | Intended use |
|---|---|---|---|
| `fast` | `gpt-5.6-luna` | `medium` | Greetings, commands, short classification, low-risk direct answers |
| `main` | `gpt-5.6-luna` | `high` | Default interaction agent, normal planning, ordinary synthesis |
| `balanced` | `gpt-5.6-terra` | `high` | Larger context, broader analysis, quality/cost balance |
| `hard` | `gpt-5.6-luna` | `max` | Fast model with maximum reasoning for difficult but bounded tasks |
| `deep` | `gpt-5.6-sol` | `max` | Hardest architecture, debugging, multi-source synthesis, or explicit user selection |

All names and efforts are configurable through environment variables. A deployer may map `main` to Terra/high or `hard` to Sol/max without changing code.

## 3. Important compatibility rule

GPT-5.6 documentation describes `max` as a reasoning-effort setting. The sampled Codex TypeScript SDK type may expose only `minimal | low | medium | high | xhigh` in a given version. The implementation must therefore treat model/effort compatibility as a runtime capability, not an assumption.

Required behavior:

1. Pin tested Codex CLI and SDK versions.
2. At startup, probe each configured model/effort pair using the supported CLI/config mechanism.
3. Record the exact capability result in readiness.
4. With `ALLOW_REASONING_FALLBACK=false`, fail readiness if `max` is unsupported.
5. With an explicit fallback enabled, map `max → xhigh` and emit a high-visibility warning naming the affected profile.
6. Never silently switch models or effort.

## 4. Auto-routing

Auto-routing begins with deterministic code rules:

```text
Slash command or health/status                 → fast
Simple conversational answer, no tools         → main
Long context or multi-document synthesis       → balanced
Repository work with bounded complexity        → main or balanced
Ambiguous architecture/debugging               → hard
Cross-repository, high-stakes, repeated failure→ deep
User explicitly selects a profile              → selected profile
```

A lightweight interaction decision may refine `main`, `balanced`, or `hard`, but cannot select a model outside the configured allowlist.

## 5. Escalation

Escalation is based on observable events:

- Structured output fails twice.
- The execution result reports insufficient reasoning.
- Tests fail after one bounded repair attempt.
- The task graph exceeds configured complexity.
- The user explicitly asks for deeper reasoning.

A task may escalate at most once automatically. Further escalation requires the interaction agent to explain the problem or ask for a decision when cost or permissions materially change.

## 6. Per-space override

`/model` behavior:

```text
/model auto       use router and deployment defaults
/model fast       force fast profile for this space
/model main       force main profile
/model balanced   force balanced profile
/model hard       force hard profile
/model deep       force deep profile
/model            show current and available profiles
```

The override is stored in `spaces.model_profile_override`. It affects future turns, not a running chain.

## 7. Permission independence

These are separate decisions:

```ts
resolveModelProfile(intent, userOverride)
resolvePermissionProfile(taskType, policy, approvalState)
```

`deep` does not imply network, write, or dangerous access. A `fast` task can still require approval if it proposes a consequential action.

## 8. Usage accounting

For each model turn record, when available:

- Model and effort.
- Input/output tokens.
- Cached input tokens.
- Latency.
- Profile source: default, router, user override, escalation.
- Estimated API cost only in API-key mode.
- ChatGPT subscription mode is recorded as entitlement-based rather than assigning misleading per-token API charges.

## 9. Evaluation suite

Maintain a versioned routing fixture set:

| Fixture class | Expected profile |
|---|---|
| `/status` | fast |
| “remember I prefer aisle seats” | main |
| “summarize these six design docs” | balanced |
| “fix this failing test in one package” | main/balanced by context size |
| “debug a cross-service race after two failed attempts” | hard/deep |
| “perform a formal architecture review across three repos” | deep |

Evaluation fails on nondeterministic profile drift unless the fixture explicitly permits a bounded set.
