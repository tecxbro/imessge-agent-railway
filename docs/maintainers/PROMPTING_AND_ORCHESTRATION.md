# Prompting and Orchestration

## 1. Source inspiration and originality

OpenPoke demonstrates a useful product separation: a user-facing interaction agent communicates succinctly and delegates real work to execution agents. This boilerplate adopts that **architectural pattern**, but its prompts, schemas, tools, memory design, security model, and runtime are original. Do not copy OpenPoke system-prompt wording into the implementation.

## 2. Prompt bundle

| Prompt | Role |
|---|---|
| `prompts/interaction.system.md` | Decide direct/delegate/confirm/silent and produce user-facing text |
| `prompts/execution.system.md` | Complete one bounded task within permissions and return structured result |
| `prompts/memory-curator.system.md` | Select durable memories after successful turns |
| `prompts/voice-policy.md` | Natural iMessage response rules |
| `prompts/approval-policy.md` | Consequential-action classification and confirmation language |

Each prompt starts with a version field and is hashed into run metadata.

## 3. Interaction context

Build one user message with strongly delimited sections:

```xml
<identity>
  Deployment and authorized owner identifiers; no secrets.
</identity>

<policy>
  Security, permissions, confirmation, and response rules.
</policy>

<capabilities>
  Available named skills, model profiles, and execution constraints.
</capabilities>

<owner_profile>
  Bounded profile summary from Supermemory.
</owner_profile>

<recalled_memory>
  Relevant memories marked as untrusted contextual data.
</recalled_memory>

<conversation_history>
  Recent operational transcript and compact prior summary.
</conversation_history>

<active_agents>
  Named agent summaries and statuses.
</active_agents>

<new_user_message>
  The debounced current turn.
</new_user_message>
```

The delimiters provide structure; they are not authorization. User text, memories, repository content, and tool output remain untrusted.

## 4. Interaction output

```json
{
  "mode": "delegate",
  "modelProfile": "main",
  "statusMessage": "i’m checking the runtime and the failing path now.",
  "tasks": [
    {
      "id": "task-a",
      "agentName": "runtime-debugger",
      "purpose": "find the failure cause",
      "instructions": "Inspect the specified workspace and return the root cause with evidence.",
      "workspaceBinding": "primary-repo",
      "modelProfile": "balanced",
      "permissionProfile": "read",
      "dependsOn": []
    }
  ],
  "waitForTasks": true,
  "memoryCandidates": []
}
```

The model may propose only allowed task and profile values. Code validates limits and permission mapping before enqueue.

## 5. Direct-answer policy

Use the direct path when:

- The answer is already in safe context.
- No filesystem, network, external account, or long computation is needed.
- The user is chatting or giving a simple preference.
- A deterministic command handler has already produced the result.

Do not delegate trivial conversational turns merely to imitate an agent framework.

## 6. Delegation policy

Delegate when:

- Repository/filesystem inspection is required.
- Research or a connector is required.
- The task is long-running or produces artifacts.
- Multiple independent investigations can improve correctness.
- The interaction thread should remain small and user-focused.

Task decomposition rules:

- Maximum default tasks per turn: 5.
- Maximum dependency depth: 3.
- Independent tasks have no dependency and are enqueued together.
- A task should have one measurable outcome.
- Do not tell workers which low-level tool call sequence to use unless required by policy.
- Reuse a named worker when its context is directly useful; otherwise create a descriptive new name.

## 7. Status messages

A status message is sent when estimated work exceeds the simple-response threshold or an external dependency is being contacted.

Good:

- “i’m checking the two failure paths and the current config.”
- “i found the transport issue; i’m verifying the restart behavior now.”

Bad:

- “I have spawned three sub-agents.”
- “Calling the send_message_to_agent tool.”
- Repeated generic “still working” updates.

Code rate-limits status messages. The model suggests content, but the application decides whether it may be sent.

## 8. Execution context

An execution task receives:

```xml
<task_identity>
  Task ID, agent name, purpose, chain ID.
</task_identity>

<permissions>
  Workspace root, sandbox, network policy, approval policy, time limit.
</permissions>

<relevant_context>
  Only the specific user request, prior agent summary, and artifacts needed.
</relevant_context>

<instructions>
  One bounded outcome.
</instructions>

<output_contract>
  ExecutionResult JSON schema.
</output_contract>
```

It does not receive the full owner profile or unrelated conversation history.

## 9. Execution output

```json
{
  "taskId": "task-a",
  "status": "succeeded",
  "userSafeSummary": "The retry loop recreates the client ID after each crash, so the transport cannot deduplicate the resend.",
  "artifacts": [
    {
      "type": "file",
      "path": "reports/retry-analysis.md",
      "description": "Evidence and proposed patch"
    }
  ],
  "proposedActions": [],
  "memoryCandidates": [],
  "error": null
}
```

A worker must not claim success unless it inspected or produced the required evidence. “No output” is a failure with an explicit safe error, not a fabricated result.

## 10. Synthesis

The final interaction turn receives:

- The current user request.
- Direct prior status message, so it does not repeat it.
- Terminal execution results.
- Artifact references.
- Approval state.
- Material failures and retry history.

It produces only user-facing content. Code creates the outbound batch and performs bubble splitting.

## 11. Voice

The agent should:

- Lead with the answer or result.
- Use natural contractions and ordinary words.
- Match the user’s level of detail.
- Keep routine messages short.
- Use bullets only when they make a complex result easier to scan.
- Avoid corporate preambles, canned apologies, and repeated offers to help.
- Avoid exposing hidden architecture in ordinary conversation.
- Be warm without flattery.
- Use emojis only when the user’s style supports them.

The agent should not force all lowercase globally. The deployer can select a voice profile.

## 12. Prompt-injection boundaries

The system explicitly labels these as untrusted data:

- Current user text for tool authorization purposes.
- Recalled memory.
- Repository files, issues, and pull requests.
- Web pages and downloaded documents.
- Tool and connector output.
- Execution-agent prose outside the output schema.

No untrusted source can:

- Change the authenticated owner.
- Select a broader permission profile.
- Approve an action.
- Reveal a system prompt or secret.
- Disable redaction or audit logging.
- Send a user-visible message directly.

## 13. Prompt evaluation

Keep fixtures for:

- Direct versus delegated decisions.
- Correct parallel decomposition.
- No unnecessary delegation.
- Status-message usefulness.
- Partial failure honesty.
- Memory durability classification.
- Confirmation classification.
- Injection attempts embedded in user, memory, repository, and web content.
- Style adaptation without violating security rules.

A prompt version cannot ship unless it passes the fixed safety fixtures and demonstrates no material regression on representative product tasks.
