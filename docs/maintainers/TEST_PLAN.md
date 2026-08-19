# Test Plan

## 1. Testing philosophy

The dangerous bugs are not “the model gave an imperfect answer.” They are:

- A message is accepted and lost.
- A stale chain sends after the user corrected it.
- A retry duplicates a bubble.
- One user receives another user’s memory or response.
- An unknown sender reaches Codex.
- A model broadens its own permissions or approves its own action.
- A restart loses ChatGPT auth, Codex context, model preference, or send state.

The test plan therefore treats models and providers as replaceable dependencies and verifies application invariants under failure. The executable production runtime is composed; clean-account Railway deployment and protected live-provider tests remain separate evidence gates.

## 2. Test layers

| Layer | Purpose | External dependencies |
|---|---|---|
| Unit | Pure parsers, schemas, model selection, splitting, policies | None |
| Contract | Assert adapter behavior against captured provider/SDK fixtures | None during normal CI |
| Integration | Real PostgreSQL/pg-boss plus fake Spectrum/Codex/Supermemory | Local containers/fakes |
| End-to-end | Real Photon development project and authenticated Codex | Opt-in protected environment |
| Chaos | Kill/restart/outage at every pipeline stage | Integration and staging |
| Security | Identity, sandbox, injection, secrets, approval replay | Fake and opt-in real sandbox |
| Documentation | Execute setup commands from a clean environment | Fresh local/Railway account |

## 3. Unit tests

### Configuration

- Missing required variables produce one actionable validation error.
- Invalid owner handle, path, duration, boolean, or enum is rejected.
- Removed legacy model-profile environment values are ignored safely.
- Persistent paths must resolve beneath the Railway volume mount in production.

### Sender identity

- E.164 normalization.
- Email case normalization.
- Fingerprint equality without exposing raw handles.
- Revoked/disabled identities rejected.
- Group author and mention policy evaluated independently.

### Commands

- Every documented slash command.
- Ambiguous approval response with multiple pending requests.
- `/cancel` affects only the current space/owner.
- `/new` resets thread, not owner memory.
- Unknown command returns concise help and never reaches Codex.

### Account-aware model selection

- Luna High is preferred when the exact pair is advertised.
- Missing effort/model resolves to the Codex-advertised default pair without
  overwriting the preference.
- Empty or malformed catalogs fail closed; every cursor is followed and hidden
  models are not requested.
- Account plan/catalog changes refresh state and logout clears it.
- One refresh produces one catalog persistence and one probe of the required effective pair; capability events do not invoke a duplicate refresh path.
- The model cannot choose a harness model through structured output.
- Only the effective pair is probed; unsupported unused models do not fail
  readiness.
- `/model` is read-only and profile arguments do not mutate state.

### Prompt and schema

- Prompt bundle hash stable for identical files.
- Context budgets truncate oldest/least relevant content safely.
- Interaction and execution schemas reject extra properties.
- Invalid task graph, duplicate IDs, cycles, or excessive tasks rejected.
- Proposed action cannot masquerade as an approval.

### Bubble splitting

- Plain paragraphs.
- Long URLs.
- Fenced code blocks.
- Numbered steps.
- Emoji and Unicode boundaries.
- Maximum message size.
- No empty bubbles.

### Redaction

- Phone numbers, emails, bearer tokens, API keys, auth JSON, database URL.
- Nested error objects and environment snapshots.
- Correlation IDs remain intact.

## 4. Contract tests

### Spectrum fixtures

Capture representative current SDK values for:

- Inbound text DM.
- Outbound echo.
- Group text.
- Reaction/read/typing events.
- Sender service values.
- Single and multiple route-phone cases.
- `space.get()` and send behavior.

Tests should fail clearly when a pinned Spectrum upgrade changes the shape.

### Codex fixtures

Fake CLI emits JSONL for:

- Thread started/resumed.
- Structured final response.
- Streaming progress.
- Tool/file events.
- Auth missing/expired.
- Unsupported model/effort.
- Sandbox rejection.
- Cancellation and process termination.
- Malformed/oversized output.

### Supermemory fixtures

- Profile fetch.
- Hybrid search.
- Add/update/delete.
- Timeout and rate limit.
- Unexpected response schema.
- Application timeout retry creates a fresh abort signal for every SDK attempt.

## 5. Integration tests

Use a disposable PostgreSQL database and real pg-boss.

### Inbound durability

1. Insert message and crash before scheduling flush.
2. Reconciliation job discovers unscheduled accepted messages.
3. Duplicate provider event inserts once.
4. Four-message burst drains once in order.
5. Concurrent flush workers produce one chain.

### Supersession and carry-forward

1. Start planning.
2. Insert correction.
3. Mark old chain canceled.
4. Abort fake Codex.
5. Carry drained messages.
6. New chain sees earlier request plus correction.
7. Old chain cannot create outbound batch.

### Task graph

- Independent tasks run concurrently.
- Dependent task waits.
- Failed dependency blocks or changes downstream behavior according to policy.
- One synthesis job is created after terminal states.
- Partial success remains available.
- The seeded `personal` workspace binding resolves under the configured workspace root.
- A claimed task re-resolves its binding and rejects any permission profile outside the binding's authorized set.

### Model settings and chain snapshots

- Preference and plan metadata survive restart without startup resetting them.
- Advanced accepts only an exact current catalog pair after one bounded probe.
- Stale, unavailable, malformed, and rejected-pair cases return stable errors.
- A running chain retains its model/effort snapshot after a preference change.
- The next chain receives the new pair, and planning, all tasks, and synthesis
  use that identical snapshot.

### Outbound recovery

- Crash before first send.
- Crash after transport acknowledgement but before cursor update.
- Crash after cursor update.
- Provider transient failure.
- Space rehydration failure.
- Same `clientGuid` on every retry.
- Final state contains no duplicate sent parts.

### Memory

- Recall budget and ordering.
- Write only after successful synthesis.
- Duplicate candidate hash deduplicated.
- Timeout does not block turn.
- Deletion receipt and cache invalidation.
- Direct, accepted task, and synthesis candidates commit encrypted in the same transaction as their authoritative result.
- Queue publication failure leaves the completed response and candidates durable; completion/restart reconciliation republishes the missing job.

### Approvals

- Create, approve, reject, expire, consume.
- Compare-and-set under concurrent replies.
- Action mutation invalidates approval.
- Canceled chain cannot consume approval.
- A collaborator/non-owner cannot approve.
- Concurrent or duplicate execute jobs invoke the registered action exactly once with the stored payload and no Codex reinterpretation.
- Reconciliation repairs missing `approval.request` and `approval.execute` jobs and consumes an approved record left without an action row by a crash.

### Activation and Photon lifecycle

- Owner, current-revision Photon, Codex auth, and capability loss each stop Spectrum intake.
- Recovery starts exactly one Spectrum run, including late-start and stale-timer races.
- Restart exhaustion clears active run ownership before bounded recovery.
- Owner replacement increments the binding revision in the identity transaction and invalidates the prior Photon installation.
- A connected Photon credential cannot enable Spectrum until exact validation succeeds for the current owner revision.
- Read-receipt send failure is best-effort and cannot change stream readiness or restart accounting.

## 6. End-to-end scenarios

### E2E-01: local first message

- Fresh database and workspace.
- Authenticated Codex.
- Real Photon project.
- Authorized DM sends `hello`.
- One response arrives and state is terminal.

### E2E-02: delegated repository task

- Bind a test repository.
- Ask for a bounded analysis.
- Observe one status bubble.
- Worker reads repository in sandbox.
- Final response cites produced artifact.
- No unrelated environment secrets are visible to the child process.

### E2E-03: interruption

- Start a long task.
- Send a correction before completion.
- Old task is aborted.
- New response incorporates correction.
- No stale final response arrives.

### E2E-04: approval

- Ask for a change that requires approval.
- Agent drafts exact operation.
- User rejects; no mutation occurs.
- Repeat, approve exact action; mutation occurs once.

### E2E-05: restart

- Complete one turn to establish memory and Codex thread.
- Restart service.
- Follow up in same space.
- Thread and memory context resume.

### E2E-06: group policy

- Unauthorized participant mentions agent: no execution.
- Authorized owner without mention: no execution in mention-gated mode.
- Authorized owner with mention: one turn.

### E2E-07: memory deletion

- Establish durable preference.
- Recall it in later turn.
- Delete through `/forget`.
- Verify subsequent turn does not retrieve it.

## 7. Chaos matrix

| Failure point | Expected behavior |
|---|---|
| After inbound DB insert, before queue schedule | reconciliation schedules flush |
| During debounce | messages remain queued |
| After drain, before plan enqueue | transaction/repair produces plan or returns messages to queue |
| Mid-interaction Codex turn | retry or cancel with same chain/version |
| Mid-execution task | task retries boundedly or becomes failed/canceled |
| Before synthesis | terminal task scan enqueues singleton synthesis |
| After outbound materialization | send job resumes all pending parts |
| Mid-send | stable GUID and cursor prevent duplicates |
| During memory write | operational response remains complete; memory job retries |
| After memory candidate commit, before queue publication | reconciliation publishes the missing `memory.curate` job |
| Spectrum stream disconnect | readiness degraded; supervised reconnect |
| Capability/Photon/owner loss while Spectrum is active | intake stops; durable workers stay up |
| Spectrum restart exhaustion | active run ID is cleared before recovery is scheduled |
| PostgreSQL unavailable | readiness false; no untracked execution |
| ChatGPT auth expires | execution pauses; operator remediation surfaced |
| Persistent volume missing | readiness false; no fresh untracked threads |

Run chaos tests repeatedly with randomized kill points.

## 8. Security tests

- Unknown sender produces zero Codex process starts.
- Disabled owner produces zero process starts.
- Principal/contributor revocation after queueing produces zero process starts.
- Task-rate denial produces zero process starts.
- Group quote/forward does not transfer authorization.
- Pairing brute force and replay.
- Prompt injection in user text, memory, README, issue, web page, and worker output.
- Child environment excludes all protected variables.
- Read-only sandbox cannot write.
- Workspace-write cannot escape through `..`, symlink, or alternate mount.
- Network-disabled task cannot connect externally.
- Model text cannot approve action.
- Approval action hash mutation/replay/expiry.
- Log and database failure-event secret scan.
- Cross-owner memory and outbound routing isolation.
- Every `src/db/repositories/**` module is statically independent of queue handlers.
- Runtime modules do not import HTTP-specific model-setting errors.
- Production interaction/task/synthesis Codex calls reach `ThreadStore` with a chain ID and are decorated by `SecureStructuredCodexRunner`.

## 9. Performance and load

- Burst of 20 fragments from one owner becomes one bounded turn.
- Ten active spaces respect per-owner and global concurrency.
- pg-boss queue latency under target at expected volume.
- Database indexes support recent-history and active-chain queries.
- Readiness remains responsive while Codex tasks run.
- Outbound pacing respects provider quotas and does not flood a thread.

Do not load-test a real iMessage line beyond provider policy. Use transport fakes for high volume.

## 10. Documentation tests

A clean-room reviewer executes:

- Local prerequisites and installation.
- `.env.example` configuration.
- Database migration.
- Codex login/status.
- Photon setup.
- Railway application deployment.
- Railway device auth.
- First message.
- Recovery and credential re-enrollment.

Every command is copied exactly from the docs. Failures become documentation bugs.

## 11. CI matrix

```text
Node: pinned minimum and current supported LTS
PostgreSQL: minimum supported and Railway target major
Tests:
  - lint/typecheck
  - unit
  - contract fixtures
  - integration with Postgres
  - security
  - architecture/import rules
  - secret scanning
  - Railway configuration unit and official-schema validation
  - docs link check
Optional protected:
  - live Codex smoke
  - live Spectrum smoke
  - live Supermemory smoke
```

## 12. Release evidence

The integration PR includes:

- Test command outputs.
- Chaos matrix results.
- Exact pinned dependency versions.
- Codex model/effort capability report.
- Fresh Railway deployment screen or redacted log evidence.
- Secret scan report.
- Migration and rollback evidence.
- Known limitations and deferred tests.

## 13. Priority-fix acceptance matrix

These checks are mandatory for the integrated priority-fix release. They are offline evidence unless the row explicitly names a live provider.

| Acceptance invariant | Required evidence |
|---|---|
| Revoked queued sender starts zero Codex children | secure queued-runner unit test |
| Task-rate-limited work starts zero Codex children | secure queued-runner unit test |
| Capability loss stops Spectrum | activation coordinator unit/chaos test |
| Capability recovery starts exactly one Spectrum run | service lifecycle and activation race tests |
| Spectrum exhaustion clears active ownership | service lifecycle chaos test |
| Current owner revision is required for Photon | Photon service unit, repository integration, and recovery chaos tests |
| Read-receipt failure cannot affect stream health | message-loop/read-receipt isolation test |
| Personal workspace delegation works | execution capability and execution runtime tests |
| Non-owner approval is rejected | approval request unit and PostgreSQL integration tests |
| Approved action executes exactly once | approval action PostgreSQL integration test |
| Memory curation survives queue publication failure | durable stage recovery chaos test |
| Model refresh causes one persistence and one required probe | model settings service and startup tests |
| Supermemory timeout retry uses a fresh signal | Supermemory client integration test |
| No database repository imports queue handlers | architecture import-direction test over the full repository directory |
| No user-work runtime bypasses `SecureStructuredCodexRunner` | architecture composition test plus interaction/execution chain-ID assertions |

Release verification runs `npm run typecheck`, `npm test`, `npm run test:integration` against a disposable PostgreSQL database, `npm run test:chaos`, `npm run docs:check`, and `git diff --check`. Migration evidence includes both a clean database and an upgraded database that already contains migrations `0000` through `0004`.
