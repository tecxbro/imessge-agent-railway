# Worktree 7 integration manifest: god-object split

## Scope

This leaf change splits orchestration persistence, Codex App Server authentication, and deployment-page rendering behind their existing import paths. It preserves the existing constructors, facade exports, rendered dashboard bytes, and runtime behavior. It does not edit production composition or queue handlers.

## Exported classes and interfaces

### Orchestration

- Compatibility facade: `OrchestrationRepository` and `OrchestrationRepositoryOptions` from `src/db/repositories/orchestration.ts`.
- Focused repositories: `TurnPlanningRepository`, `TaskExecutionRepository`, `TurnSynthesisRepository`, and `OrchestrationRecoveryRepository`.
- Shared persistence support: `OrchestrationCodec`, `LoadedMessage`, and `OrchestrationRepositoryOptions`.
- Planning contracts: `ActiveAgentContext`, `TurnPlanContext`, `PersistedExecutionTaskInput`, `QueuedExecutionTask`, `TurnPlanCommitBase`, `PlanFinalCommitInput`, and `TurnPlanRepositoryContract`.
- Execution contracts: `TaskExecutionContext`, `ReadyExecutionTask`, `TaskTerminalOutcome`, `TaskAttemptFailureOutcome`, `CompleteTaskInput`, `FailTaskAttemptInput`, and `TaskExecutionRepositoryContract`.
- Synthesis contracts: `TurnSynthesisContext`, `SynthesisFinalCommitInput`, and `TurnSynthesisRepositoryContract`.
- Capability contracts: `OrchestrationIdentity`, `ExecutionCapability`, and `ExecutionCapabilitySource`.

### Codex App Server authentication

- Compatibility facade: `CodexAppServerAuth`, `CodexAppServerAuthOptions`, `ChatGptSetupController`, `CodexAppServerConnection`, and `CodexAppServerConnectionFactory` from `src/agent/codex-app-server-auth.ts`.
- Protocol and transport: `CodexAppServerProtocolError`, `AppServerNotification`, `StdioCodexAppServerConnection`, `CodexAppServerConnection`, and `CodexAppServerConnectionFactory`.
- Capability source: `CodexCapabilitySourceResult` and `CodexAccountState`; the module also exports model normalization and paginated account-capability loading helpers.
- Login state: `ChatGptAuthStateMachine`, `ChatGptAuthStateMachineOptions`, `ChatGptSetupController`, `ChatGptSetupErrorCode`, `ChatGptSetupStatus`, and `ConnectedListener`.
- Executable and credential support: `resolvePinnedCodexExecutable()` and `validateAndRestrictCodexAuthFile()`.
- Protocol schemas and their inferred account, device-login, login-completion, and wire-model types are exported from `src/agent/codex-app-server/protocol.ts` for focused testing and adapters.

### Deployment page

- Compatibility facade: `DeploymentPageOptions`, `renderDeploymentPage()`, and `renderDashboardScript()` from `src/http/deployment-page.ts`.
- View model: `DeploymentPageOptions`, `DeploymentPageViewModel`, and `createDeploymentPageViewModel()`.
- Rendering modules export `renderDeploymentPageContent()`, `renderDeploymentPage()`, `renderDashboardScript()`, `escapeHtml()`, and the unchanged deployment-page style string.

## Required production wiring

No production wiring change is required or included. Existing consumers continue importing the three compatibility paths:

- `src/db/repositories/orchestration.ts`
- `src/agent/codex-app-server-auth.ts`
- `src/http/deployment-page.ts`

The integration branch must merge each facade together with its subordinate modules. It must not add direct imports to `production-bootstrap.ts`, `server.ts`, queue handlers, or central runtime files as part of this leaf refactor.

## Database changes

None. There is no migration, schema fragment, table, column, constraint, or repository query behavior change. `src/db/schema.ts`, `drizzle.config.ts`, and `src/db/migrations/meta/**` are unchanged.

## Queue changes

None. The focused orchestration contracts reuse the existing identifier-only queue payload types. No queue extension, name, payload, publisher, boss, or handler file is changed. Database repositories no longer import queue-handler modules.

## Readiness changes

None. Readiness component names, state transitions, routes, responses, and production composition are unchanged.

## Exact tests added

- `test/architecture/repository-dependency-direction.test.ts` prevents orchestration repositories and contracts from depending on queue handlers or queue implementations and keeps orchestration contracts independent of database implementations.
- `test/unit/orchestration-facade.test.ts` characterizes the legacy method surface and verifies planning, execution, synthesis, and recovery delegation through focused repository fakes/spies, including legacy default limits.
- `test/unit/codex-app-server-modules.test.ts` characterizes the facade handshake and error codes, protocol validation, JSONL stdio transport, pinned executable resolution, paginated model loading, login state, and auth-file permissions using fake connections/processes and temporary files.
- `test/unit/deployment-page-snapshots.test.ts` locks the initial, provider-authorization, escaping, Codex-progress, ready ChatGPT, ready API-key, and dashboard-client-script output with byte-level SHA-256 snapshots.

The existing PostgreSQL orchestration integration suite remains the database-backed behavior check. It requires `POSTGRES_PIPELINE_TEST_DATABASE_URL`; without that disposable database its four cases are reported as skipped, not passed.
