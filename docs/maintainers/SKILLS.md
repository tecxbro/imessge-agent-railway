# Skills Architecture

## 1. Purpose

Codex skills package repeatable instructions, references, and scripts into discoverable `SKILL.md` files. In this boilerplate they serve two roles:

1. **Repository implementation skills** for coding agents building and maintaining the starter.
2. **Runtime user skills** that a deployed agent may expose for bounded tasks.

The bundled files in this documentation pack are implementation skills. Runtime skills should be added only when the associated permission, connector, test, and confirmation policy exist.

## 2. Skill principles

- One clear purpose per skill.
- Description states exactly when the skill applies.
- Primary docs and repository paths are named.
- Security and non-goals are explicit.
- Prefer progressive disclosure: concise `SKILL.md`, referenced files for detail.
- Do not install executable scripts or external dependencies without review.
- A skill cannot grant permission; runtime policy remains authoritative.

## 3. Bundled implementation skills

| Skill | Use |
|---|---|
| `skills/imessage-transport/SKILL.md` | Spectrum Cloud gRPC transport, space routing, outbound behavior |
| `skills/codex-runtime/SKILL.md` | Codex SDK/CLI auth, threads, model profiles, sandbox, cancellation |
| `skills/supermemory/SKILL.md` | Memory namespaces, recall, curation, deletion, isolation |
| `skills/release-integration/SKILL.md` | Worktree merge, E2E, chaos tests, docs and release evidence |

## 4. Runtime skill contract

A future runtime skill manifest should declare:

```yaml
name: github-release-manager
description: Inspect a configured repository, prepare release notes, and propose a release. Publishing requires approval.
permissions:
  filesystem: workspace-write
  network: github-only
  approval_required:
    - publish_release
    - push_tag
required_configuration:
  - workspace_binding
  - github_connector
```

The YAML above is illustrative metadata; the canonical skill remains Markdown and the application maps declared needs to known permission profiles.

## 5. Initial runtime skills after v1

### Repository analyst

- Read configured repository.
- Explain architecture, diffs, tests, and issues.
- No writes by default.

### Researcher

- Web/network read only.
- Source attribution required.
- No account mutations.

### Release manager

- Analyze status and draft release plan.
- Repository writes/publish actions require exact approval.

### Memory manager

- Inspect and explain current profile/memories.
- Propose additions or deletions.
- Deletion through deterministic application handler.

### Reminder planner

- Parse schedule and draft a reminder.
- Creating recurring work requires explicit confirmation and a durable scheduler contract.

## 6. Skill installation

Do not let an iMessage command install arbitrary remote skills in v1. Safe installation flow:

1. Operator selects a reviewed source in the repository.
2. CI scans the skill and referenced scripts.
3. Required permissions/connectors are declared.
4. Operator enables it through configuration.
5. Capability probe confirms dependencies.
6. `/help` lists the skill.

A future managed registry can sign skill packages and enforce version/permission review.

## 7. Skill evaluation

Every runtime skill includes:

- Positive fixtures.
- Out-of-scope fixtures.
- Permission and confirmation fixtures.
- Prompt-injection fixtures.
- Failure and provider-outage behavior.
- Exact user-safe result schema.
- Documentation links and last-verified date.
