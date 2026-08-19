# Worktree 5A integration manifest: execution capability bindings

## Exported classes and interfaces

### `src/security/permission-grants.ts`

- `PermissionProfileNotGrantedError`
- `permissionGrantsForRole(role, configuredProfiles)`
- `enforcePermissionGrantSet(requested, allowedPermissionProfiles)`

The new authorization path uses exact set membership. It does not infer a
single maximum profile and does not treat one profile as implying another.
Existing exports in `src/security/permissions.ts` remain unchanged for backward
compatibility.

### `src/agent/execution-capability-service.ts`

- `executionCapabilityBindingRecordSchema`
- `ExecutionCapabilityBindingRecord`
- `ExecutionCapabilityRepository`
- `ExecutionCapabilityActor`
- `AvailableExecutionCapability`
- `AuthorizedExecutionCapability`
- `ExecutionCapabilityErrorCode`
- `ExecutionCapabilityError`
- `ExecutionCapabilityServiceOptions`
- `ExecutionCapabilityService`

`ExecutionCapabilityService.listAvailableCapabilities(actor)` returns only
enabled, realpath-validated bindings with the actor's exact role-specific
profile set. `authorizeExecutionCapability(actor, request)` requires an exact
persisted workspace binding and exact membership in that set before returning
the resolved working directory.

### Database exports

- `executionCapabilityBindings` and `ExecutionCapabilityBindingRow` from
  `src/db/schema-fragments/execution-capabilities.ts`
- `PostgresExecutionCapabilityRepository` from
  `src/db/repositories/execution-capabilities.ts`

The repository exposes only actor-scoped reads. This leaf intentionally has no
binding mutation API.

## Required production wiring

This branch is not wired into production. The integration branch must:

1. Add migration `0008_execution_capability_bindings.sql` to the Drizzle
   journal after all collected `0005`–`0007` migrations. Do not regenerate or
   overwrite another worker's migration metadata.
2. Compose `PostgresExecutionCapabilityRepository` and
   `ExecutionCapabilityService` in `src/runtime/production-bootstrap.ts` using
   the validated `AGENT_WORKSPACE_ROOT` and `CODEX_HOME` values.
3. Build `ExecutionCapabilityActor` only from the code-authorized sender
   context. Never accept `deploymentId`, `ownerId`, or `senderRole` from model
   output.
4. Give the interaction lane only the result of
   `listAvailableCapabilities`. Before every execution child process, call
   `authorizeExecutionCapability` again with the task's proposed binding and
   profile, then pass its `resolvedWorkspacePath` and `permissionProfile` to
   the execution runtime.
5. Re-authorize after queue delay/retry rather than persisting the resolved
   path as queue authority. Snapshot `revision` on the execution task if the
   integrator needs explicit stale-plan detection.
6. Keep approvals independent: an approval cannot add a permission profile or
   workspace binding, and model text cannot mutate capability rows.

### Seed description for the integrator

Create this reviewed deployment-scoped binding during integration or operator
provisioning; do not add a production seed to this leaf migration:

```yaml
workspaceBinding: personal
relativeWorkspacePath: .
profiles:
  - read
  - workspace-write
  - network-read
  - approval-required
```

The inserted database row must set `allowed_permission_profiles` to the profile
array above, `enabled` to `true`, and `revision` to `1`.

## Database changes

- Migration: `src/db/migrations/0008_execution_capability_bindings.sql`
- Compatibility/rollback notes:
  `src/db/migrations/0008_execution_capability_bindings.notes.md`
- Isolated Drizzle definition:
  `src/db/schema-fragments/execution-capabilities.ts`
- New table: `execution_capability_bindings`
- Composite key: `(deployment_id, workspace_binding)`
- Foreign key: `deployment_id -> deployments.id ON DELETE CASCADE`, declared
  only in SQL as required by the parallel-worktree contract
- Stored values: deployment ID, workspace binding, relative workspace path,
  allowed permission-profile JSON set, enabled flag, revision, created time,
  and updated time
- Safety defaults/constraints: disabled by default, positive revision,
  validated binding name, non-empty path, non-empty known profile array

`src/db/schema.ts`, `drizzle.config.ts`, and `src/db/migrations/meta/**` are
unchanged in this branch.

## Queue changes

None. No queue name, payload, publisher, boss, handler, or extension contract is
changed. Existing ID-only execution jobs must reload authoritative actor and
capability state during the production wiring described above.

## Readiness changes

None are wired in this leaf. During integration, extend capability/workspace
readiness to call `listAvailableCapabilities` after the deployment owner and
database are ready:

- report a bounded remediation when a configured enabled binding is missing,
  is not a directory, escapes by symlink, traverses outside the workspace root,
  or overlaps `CODEX_HOME` after realpath resolution;
- report zero enabled bindings as execution unavailable without pretending a
  live Codex execution path exists; and
- keep raw absolute paths out of readiness details.

Whether “no execution binding” blocks overall readiness is an integration
product decision: the current architecture permits conversational turns on a
blank deployment but forbids repository execution until a binding exists.

## Exact tests added

`test/unit/execution-capability-service.test.ts`:

- `authorizes an exact configured profile in a real contained workspace`
- `rejects a relative path containing traversal segments`
- `rejects a workspace symlink that escapes the real workspace root`
- `rejects a disabled binding and omits it from capability listing`
- `restricts collaborators to configured read access`
- `rejects an owner permission outside the configured set`
- `authorizes multiple non-hierarchical profiles without implying read`
- `rejects a workspace binding that is not in the persisted set`
- `rejects a missing workspace binding`
- `rejects a workspace binding that is not a directory`
- `rejects realpath overlap between CODEX_HOME and the workspace root`
- `does not grant collaborator read when the binding omits read`

`test/integration/execution-capability-repository.test.ts` (runs when
`POSTGRES_PIPELINE_TEST_DATABASE_URL` points to a disposable database):

- `returns revisioned enabled and disabled bindings for an active deployment owner`
- `returns no bindings for an owner outside the active actor scope`

The unit suite uses a fake `ExecutionCapabilityRepository`; filesystem cases use
real temporary directories and symlinks. The repository integration suite uses
the disposable PostgreSQL port and applies the isolated migration explicitly
when the integration journal has not yet collected migration `0008`.

## Security and recovery impact

- The model can propose only a binding name and profile; both must match
  persisted code-owned state exactly.
- Collaborators receive the intersection of the binding set with `{read}`.
- Owners receive the exact configured set, including non-comparable profiles
  such as `workspace-write` and `network-read`.
- Filesystem authorization fails closed on missing paths, files, traversal,
  symlink escape, and credential/workspace overlap.
- Disabling or revising a row takes effect on the next authoritative reload;
  queued tasks must not treat earlier model plans as authority.
