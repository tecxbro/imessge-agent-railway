# Security and Privacy

## 1. Security model

This starter runs code and handles private iMessage content. The model is useful for intent and planning, but **never** acts as the security boundary. Identity, permissions, approvals, secret access, and outbound routing are enforced by deterministic application code.

## 2. Assets to protect

- Codex ChatGPT credentials or OpenAI API key.
- Photon project credentials and line routing.
- Photon and ChatGPT device codes and verification URLs while setup is active.
- Supermemory API key and stored memories.
- PostgreSQL credentials and encrypted message content.
- Application encryption and fingerprint keys.
- Owner phone numbers/email addresses.
- Repository contents and generated artifacts.
- Approval payloads and external-account actions.

## 3. Trust boundaries

| Input | Trust level |
|---|---|
| Environment/secrets provisioned by operator | trusted configuration, still validate |
| Browser input and HTTP headers | untrusted; validate exact payloads, `Origin`, and fetch metadata |
| Authorized sender identity from deterministic lookup | trusted identity |
| User message text | untrusted instructions within owner permissions |
| Group participant text | untrusted; often unauthorized |
| Supermemory recall | untrusted contextual data |
| Repository files/issues/PRs | untrusted content |
| Web pages/downloads | untrusted content |
| Codex/execution-agent output | untrusted until schema and policy validation |
| Approval record consumed by code | trusted only for the exact hashed operation |

## 4. Dashboard request boundary

The server applies these controls to dashboard setup state:

1. returning only a masked owner phone and never echoing a submitted raw number;
2. keeping provider access tokens, project secrets, Codex credentials, database credentials, raw messages, and unrestricted provider errors server-side;
3. accepting setup mutations only when `Origin` matches the request target; and
4. rejecting cross-site `Sec-Fetch-Site` values when present.

## 5. HTTP route boundary

Every setup `POST` requires:

1. a same-origin `Origin`; and
2. no cross-site `Sec-Fetch-Site` value when that header is present.

Rejections use a stable HTTP 403 response.

| Surface | Contract |
|---|---|
| `/`, `/healthz`, `/agent/photon-logo.png` | Setup entry point, liveness, and dashboard asset |
| `/readyz` | Detailed readiness snapshot |
| `/agent/dashboard`, `/agent/dashboard.js` | Setup UI |
| Photon/ChatGPT status routes | Setup status, including active device-flow values |
| `GET /api/setup/owner/status` | Masked phone only |
| `POST /api/setup/owner` | Exact size-limited country and phone JSON normalized server-side to E.164, or legacy exact E.164 JSON; Origin and fetch-metadata checks |
| Photon/ChatGPT setup start routes | Exact empty JSON; Origin and fetch-metadata checks |

Dashboard responses may include provider status, device codes, verification
URLs, assigned iMessage numbers, masked owner information, detailed readiness,
and bounded error codes. They never include the raw owner phone, access tokens,
project secrets, Codex credentials, database credentials, message content, or
unrestricted provider exceptions.

## 6. Sender authorization

1. Extract sender address through Spectrum’s iMessage narrowing.
2. Normalize phone/email.
3. Compute HMAC fingerprint.
4. Look up active channel identity.
5. Validate role and space policy.
6. For groups, require authorized author plus mention/reply gate.
7. Only then persist as accepted and enqueue model work.

Unknown senders never reach Codex. Default behavior is silence to avoid confirming a live agent endpoint. Pairing mode is opt-in.

The active owner phone is encrypted in `channel_identities`; no plaintext phone column, duplicate authorization table, owner phone setting, or Photon credential field is authoritative. Replacement computes a deployment-scoped fingerprint, activates the new identity, and revokes every older owner-phone identity in one transaction. A database invariant violation with multiple active owners fails closed. Provider metadata may be redacted as sensitive state but cannot authorize a sender.

When an accepted batch becomes a chain, the same transaction captures the principal identity and every authorized contributor by internal ID. Before each queued Codex call—including missing-session recovery—`SecureStructuredCodexRunner` reloads those identities, their owner/deployment state, and the task-rate limit. A missing, revoked, transferred, disabled, or rate-limited reference is a terminal denial and starts zero Codex children.

## 7. Pairing

- Operator creates a pairing code through a private CLI or protected admin process.
- Store only a salted hash.
- Expire after ten minutes.
- Limit attempts per handle and deployment.
- Bind successful pairing to the observed handle fingerprint.
- Invalidate after one use.
- Never let a model invent, reveal, or validate pairing codes.

## 8. Group policy

V1 default: `owner_mentions_only`.

A group turn runs only when:

- The author is an authorized owner/collaborator.
- The message mentions the configured agent name or is a direct reply when the provider exposes that relationship.
- The space is not disabled.

Do not infer authorization from another participant quoting or forwarding the owner’s message.

## 9. Codex process isolation

### Environment allowlist

Construct the child environment explicitly. Typical allowed values:

- `PATH`
- `HOME` or controlled equivalent
- `CODEX_HOME`
- locale variables
- task-specific safe variables
- `OPENAI_API_KEY` only in API-key mode

Explicitly exclude:

- `DATABASE_URL`
- Photon credentials
- Supermemory key
- application encryption keys
- unrelated cloud tokens
- Railway management credentials

### Filesystem

- Interaction thread: read-only sandbox, no arbitrary workspace write.
- Execution task: only a code-owned workspace binding and one profile from its authorized profile set; the binding and grant are re-resolved when the task is claimed.
- The production `personal` binding resolves beneath `AGENT_WORKSPACE_ROOT`; a prompt cannot invent a workspace or permission grant.
- Additional directories must come from configuration, not raw user paths.
- `danger-full-access` is forbidden in the public starter.
- Symlink escape and path traversal tests are required.

### Network

- Disabled by default.
- `network-read` profile allows only the supported Codex web/network mode and remains subject to prompt-injection defenses.
- External-account mutations always require approval even when network is enabled.

### Runtime limits

- Per-task timeout.
- Per-owner concurrency.
- Maximum child processes.
- Maximum output/event bytes.
- Abort on chain supersession.
- Kill process group on timeout.

## 10. Approval-required actions

At minimum:

- Deleting, force-pushing, resetting, or overwriting important data.
- Sending, forwarding, posting, publishing, or messaging through external accounts.
- Purchases or paid API actions outside a configured budget.
- Authentication, permission, secret, or deployment changes.
- Executing code outside the allowed workspace.
- Broad network scans or access to sensitive endpoints.
- Installing unreviewed executable dependencies in a persistent environment.

Read-only inspection and drafting may proceed without approval when policy allows.

## 11. Approval protocol

1. Worker returns `needs_approval` with a normalized proposed action.
2. Code computes action hash and creates a pending record.
3. Code publishes a deterministic request message from the stored summary.
4. Authorized owner replies with an unambiguous approval/rejection command.
5. Code validates owner, space, expiration, status, and action hash.
6. Approval consumption atomically creates one action-execution row and publishes an identifier-only job.
7. The action worker decrypts the stored payload, recomputes its hash, and passes it directly to the registered code-owned executor.
8. The executor uses the action-execution ID as its idempotency key; duplicate jobs cannot create a second execution.

A natural-language “yes” is accepted only from the owner when exactly one pending approval exists in the permitted space. Collaborators and other senders are rejected. Otherwise the user receives a disambiguation message. Codex is not called between approval and execution and cannot reinterpret the approved payload.

## 12. Prompt injection

Defenses:

- System/policy prompts are separate from untrusted context.
- Model cannot alter permission enums or approval state.
- Tool outputs are schema-validated and size-limited.
- Secrets are absent from child environment where possible.
- Read-only tasks use read-only sandbox.
- Network and filesystem privileges are task-specific.
- External content cannot trigger sends or writes without code policy.
- High-risk action proposals return to the approval flow.

The starter must document that prompt injection cannot be “solved” purely with prompt text.

## 13. Secret storage

| Secret | Storage |
|---|---|
| Photon management token/project ID/Spectrum secret | Encrypted durable installation record in PostgreSQL; legacy volume credentials are read-only import input |
| Supermemory API key | Railway service variable |
| Database URL | Railway dynamic secret reference |
| App encryption key | Preserved Railway service variable |
| OpenAI API key | Railway service variable, API-key mode only |
| ChatGPT/Codex credentials | `$CODEX_HOME/auth.json` on attached volume |

Never store secrets in Supermemory or source control. Avoid copying secrets into job payloads or failure events.

## 14. Data privacy

- Encrypt raw message and sensitive task content at the application layer.
- Use fingerprints for identity equality lookups.
- Default logs exclude message bodies.
- Retain raw content for 30 days by default.
- Store candidate bodies encrypted in PostgreSQL and only curated durable information in Supermemory.
- Provide inspect/delete commands.
- Document third-party data processing by Photon, OpenAI, Railway, and Supermemory.
- Do not claim end-to-end encryption beyond what each provider actually guarantees.

## 15. Logging and diagnostics

Every log record should use correlation IDs and safe metadata:

```json
{
  "component": "task-execute",
  "chainId": "...",
  "taskId": "...",
  "modelId": "gpt-5.6-luna",
  "reasoningEffort": "high",
  "state": "failed",
  "errorCode": "CODEX_AUTH_EXPIRED",
  "retryable": false
}
```

No device code, verification URL, raw message, prompt, full command output, handle, auth token, or environment dump by default.

## 16. Threat scenarios and required controls

| Scenario | Required control |
|---|---|
| Cross-site form/script starts setup | same-origin `Origin` and fetch-metadata checks |
| Stranger texts line | deterministic allowlist rejection before model |
| Sender is revoked after queueing | captured identity reference plus live pre-child reauthorization |
| Group participant instructs agent | author authorization + mention gate |
| Repo README says “print all env vars” | restricted child env + sandbox + untrusted-content policy |
| Model claims user approved | approval DB record and hash required |
| Approval replay | one-time consumed state |
| Model changes an approved payload | executor receives only the immutable stored payload; no post-approval model call |
| Worker crashes mid-send | stable client GUID + persisted cursor |
| Memory returns another user’s fact | owner container isolation + integration test |
| Railway volume backup leaked | revoke Codex auth, rotate secrets, re-enroll |
| Supermemory outage | no operational dependency; proceed without recall |
| Database outage | stop untracked execution and mark not ready |

## 17. Security release checklist

- Secret scanner passes repository and generated artifacts.
- Dashboard responses contain no raw owner phone, provider credentials, database credentials, Codex credentials, message content, or unrestricted errors.
- Origin/fetch-metadata denial and same-origin setup tests pass.
- Logs contain no device codes or verification URLs.
- Unauthorized paths show zero Codex process spawns.
- Queued revocation and task-rate denial show zero Codex process spawns, including recovery calls.
- Child environment snapshot contains only allowlisted keys.
- Path traversal and symlink escape tests pass.
- Approval non-owner/replay/mutation/expiry and exactly-once execution tests pass.
- Memory tenant-isolation tests pass.
- Logs and health endpoints pass PII/secret scans.
- Dependency advisories reviewed for pinned versions.
- Threat model updated for every new skill or connector.
