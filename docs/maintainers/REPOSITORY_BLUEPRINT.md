# Repository Blueprint

## 1. Proposed tree

```text
imessage-codex-agent-boilerplate/
├── .env.example
├── .gitignore
├── AGENTS.md
├── CONTRIBUTING.md
├── LICENSE
├── README.md
├── SECURITY.md
├── package.json
├── package-lock.json
├── railway.json
├── tsconfig.json
├── drizzle.config.ts
├── docs/
│   ├── README.md
│   ├── DEPLOYMENT.md
│   ├── CONFIGURATION.md
│   ├── CUSTOMIZATION.md
│   ├── ARCHITECTURE.md
│   ├── OPERATIONS.md
│   ├── TROUBLESHOOTING.md
│   ├── SECURITY_AND_PRIVACY.md
│   ├── llms.txt
│   └── maintainers/
│       ├── PRD.md
│       ├── IMPLEMENTATION_PLAN.md
│       ├── TEST_PLAN.md
│       ├── DECISIONS.md
│       ├── DATA_MODEL.md
│       ├── MODEL_ROUTING.md
│       ├── PROMPTING_AND_ORCHESTRATION.md
│       ├── REPOSITORY_BLUEPRINT.md
│       ├── CONVEX_VARIANT.md
│       ├── BUSINESS_PROSPECTS.md
│       ├── PROVIDER_REFERENCES.md
│       └── SKILLS.md
├── prompts/
│   ├── interaction.system.md
│   ├── execution.system.md
│   ├── memory-curator.system.md
│   ├── voice-policy.md
│   └── approval-policy.md
├── skills/
│   ├── imessage-transport/SKILL.md
│   ├── codex-runtime/SKILL.md
│   ├── supermemory/SKILL.md
│   └── release-integration/SKILL.md
├── src/
│   ├── index.ts
│   ├── config/
│   │   ├── env.ts
│   │   ├── model-profiles.ts
│   │   └── capabilities.ts
│   ├── http/
│   │   ├── server.ts
│   │   └── readiness.ts
│   ├── transport/
│   │   ├── spectrum.ts
│   │   ├── message-loop.ts
│   │   ├── space-resolver.ts
│   │   ├── sender-identity.ts
│   │   └── outbound.ts
│   ├── db/
│   │   ├── client.ts
│   │   ├── schema.ts
│   │   ├── repositories/
│   │   └── migrations/
│   ├── queue/
│   │   ├── boss.ts
│   │   ├── names.ts
│   │   ├── payloads.ts
│   │   └── handlers/
│   │       ├── inbound-flush.ts
│   │       ├── turn-plan.ts
│   │       ├── task-execute.ts
│   │       ├── turn-synthesize.ts
│   │       ├── outbound-send.ts
│   │       └── memory-curate.ts
│   ├── agent/
│   │   ├── codex-client.ts
│   │   ├── interaction-runtime.ts
│   │   ├── execution-runtime.ts
│   │   ├── thread-store.ts
│   │   ├── model-router.ts
│   │   ├── prompt-builder.ts
│   │   └── schemas.ts
│   ├── memory/
│   │   ├── supermemory-client.ts
│   │   ├── recall.ts
│   │   ├── curator.ts
│   │   └── deletion.ts
│   ├── security/
│   │   ├── authorize-sender.ts
│   │   ├── pairing.ts
│   │   ├── approvals.ts
│   │   ├── permissions.ts
│   │   ├── redaction.ts
│   │   └── secret-boundaries.ts
│   ├── commands/
│   │   ├── parse.ts
│   │   └── handlers.ts
│   ├── messaging/
│   │   ├── bubble-splitter.ts
│   │   └── status-policy.ts
│   └── observability/
│       ├── logger.ts
│       ├── metrics.ts
│       └── failures.ts
└── test/
    ├── unit/
    ├── integration/
    ├── e2e/
    ├── chaos/
    └── fixtures/
```

## 2. File ownership

| Concern | Files | Contract |
|---|---|---|
| Process boot | `src/index.ts` | Starts dependencies in order; owns shutdown |
| Environment | `src/config/env.ts` | Validates all required and optional variables at startup |
| Model profiles | `src/config/model-profiles.ts`, `src/agent/model-router.ts` | Converts profile to tested Codex model/effort/options |
| Spectrum | `src/transport/*` | Uses native Spectrum concepts; never runs Codex inline |
| Health | `src/http/*` | Liveness/readiness only; no public admin UI in v1 |
| Database | `src/db/*` | Schema, migrations, transaction boundaries, repositories |
| Queue | `src/queue/*` | Job names, payload schemas, handlers, retry policy |
| Codex | `src/agent/*` | Thread lifecycle, structured outputs, environment, aborts |
| Memory | `src/memory/*` | Supermemory recall, curation, deletion, receipts |
| Security | `src/security/*` | Sender auth, pairing, approvals, redaction, permissions |
| Commands | `src/commands/*` | Deterministic command parsing before model calls |
| User voice | `src/messaging/*`, `prompts/*` | Bubble splitting, status policy, original prompts |
| Operations | `src/observability/*` | Correlation IDs, metrics, failure audit |

## 3. Environment variables

### Required in all modes

```dotenv
SPECTRUM_PROJECT_ID=
SPECTRUM_PROJECT_SECRET=
DATABASE_URL=
AGENT_OWNER_HANDLES=+15551234567,user@example.com
DEPLOYMENT_ID=
```

### Required for Supermemory-enabled mode

```dotenv
SUPERMEMORY_API_KEY=
SUPERMEMORY_CONTAINER_PREFIX=imessage-agent
```

### Codex authentication

```dotenv
CODEX_HOME=/var/data/codex
AGENT_WORKSPACE_ROOT=/var/data/workspaces
CODEX_AUTH_MODE=chatgpt
# OPENAI_API_KEY=        # used only when CODEX_AUTH_MODE=api_key
```

### Model defaults

```dotenv
MODEL_FAST=gpt-5.6-luna
MODEL_FAST_EFFORT=medium
MODEL_MAIN=gpt-5.6-luna
MODEL_MAIN_EFFORT=high
MODEL_BALANCED=gpt-5.6-terra
MODEL_BALANCED_EFFORT=high
MODEL_HARD=gpt-5.6-luna
MODEL_HARD_EFFORT=max
MODEL_DEEP=gpt-5.6-sol
MODEL_DEEP_EFFORT=max
ALLOW_REASONING_FALLBACK=false
```

### Behavior and limits

```dotenv
INBOUND_DEBOUNCE_MS=4000
MAX_EXECUTION_CONCURRENCY=3
MAX_TASK_RUNTIME_MS=900000
RAW_MESSAGE_RETENTION_DAYS=30
FAILURE_RETENTION_DAYS=14
PAIRING_MODE=off
GROUP_MODE=owner_mentions_only
LOG_MESSAGE_CONTENT=false
```

## 4. Package choices

```json
{
  "engines": { "node": ">=22.12" },
  "dependencies": {
    "@openai/codex": "<pin exact tested version>",
    "@openai/codex-sdk": "<pin exact tested version>",
    "drizzle-orm": "<pin>",
    "express": "<pin>",
    "pg": "<pin>",
    "pg-boss": "<pin>",
    "pino": "<pin>",
    "spectrum-ts": "<pin>",
    "supermemory": "<pin>",
    "zod": "<pin>"
  }
}
```

Pin exact versions for the public starter after an end-to-end compatibility run. Do not publish with broad caret ranges for Codex, Spectrum, pg-boss, or Supermemory because model options, protocol behavior, and runtime requirements can change.

## 5. Core interfaces

```ts
export interface AuthorizedInbound {
  deploymentId: string;
  ownerId: string;
  spaceId: string;
  externalMessageId: string;
  senderIdentityId: string;
  text: string;
  receivedAt: Date;
  routePhone?: string;
  isGroup: boolean;
}

export interface InteractionDecision {
  mode: "direct" | "delegate" | "confirm" | "silent";
  modelProfile: "fast" | "main" | "balanced" | "hard" | "deep";
  userMessage?: string;
  statusMessage?: string;
  tasks: ExecutionTask[];
  waitForTasks: boolean;
  memoryCandidates: MemoryCandidate[];
}

export interface ExecutionTask {
  id: string;
  agentName: string;
  purpose: string;
  instructions: string;
  workspaceBinding?: string;
  modelProfile: string;
  permissionProfile: "read" | "workspace-write" | "network-read" | "approval-required";
  dependsOn: string[];
}

export interface ExecutionResult {
  taskId: string;
  status: "succeeded" | "failed" | "canceled" | "needs_approval";
  userSafeSummary: string;
  artifacts: ArtifactRef[];
  proposedActions: ProposedAction[];
  memoryCandidates: MemoryCandidate[];
  error?: { code: string; retryable: boolean; safeMessage: string };
}
```

All interfaces are backed by runtime schemas in `src/agent/schemas.ts` and `src/queue/payloads.ts`.

## 6. Import rules

- `transport` may import `db`, `queue`, `security`, and shared schemas; it may not import the Codex SDK.
- `agent` may import configuration, database repositories, prompt files, and security permission types; it may not send Spectrum messages.
- `queue/handlers` compose modules and own state transitions.
- `memory` may not authorize users or alter operational chain state.
- `security` may not call the model.
- `http` may read readiness state but may not mutate agent state in v1.
- Prompt files are loaded as versioned text and hashed into each run for auditability.

## 7. Migration from the original starter

| Original | New boilerplate |
|---|---|
| `src/photon.ts` with inline hello reply | `src/transport/spectrum.ts` + durable receive loop |
| `src/server.ts` mounts Spectrum webhook | `src/http/server.ts` exposes only health/readiness |
| `@spectrum-ts/express` | Removed unless a future separate webhook integration needs it |
| Three Spectrum variables including webhook secret | Project ID and project secret; no webhook secret for gRPC path |
| Node 20 | Node 22.12+ because the selected queue/runtime stack requires it |
| No database | PostgreSQL + Drizzle + pg-boss |
| No agent | Codex interaction and execution runtimes |
| No memory | Supermemory projection with PostgreSQL receipts |
| One Railway project | One application service, one PostgreSQL 18 service, one attached volume |
