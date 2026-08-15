import { resolve } from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { executionResultSchema, interactionDecisionSchema } from "../../src/agent/schemas.js";
import { codexThreadScopeKey } from "../../src/agent/thread-store.js";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";
import { runDatabaseMigrations } from "../../src/db/migrate.js";
import { ChainRepository } from "../../src/db/repositories/chains.js";
import { PostgresCodexThreadRepository } from "../../src/db/repositories/codex-threads.js";
import { InboundRepository } from "../../src/db/repositories/inbound.js";
import { OrchestrationRepository } from "../../src/db/repositories/orchestration.js";
import {
  agentThreads,
  chains,
  channelIdentities,
  deployments,
  executionTasks,
  outboundBatches,
  owners,
  spaces,
} from "../../src/db/schema.js";

const databaseUrl = process.env["POSTGRES_PIPELINE_TEST_DATABASE_URL"];
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;
const deploymentId = "30000000-0000-4000-8000-000000000001";
const ownerId = "30000000-0000-4000-8000-000000000002";
const identityId = "30000000-0000-4000-8000-000000000003";
const spaceId = "30000000-0000-4000-8000-000000000004";
const decryptFixture = (ciphertext: string) =>
  ciphertext.startsWith("secure:")
    ? Buffer.from(ciphertext.slice("secure:".length), "base64").toString(
        "utf8",
      )
    : ciphertext.replace(/^cipher:/u, "");
const encryptFixture = (plaintext: string) =>
  `secure:${Buffer.from(plaintext, "utf8").toString("base64")}`;

describeDatabase("Step 5 PostgreSQL orchestration", () => {
  let client: DatabaseClient;
  let inbound: InboundRepository;
  let chainRepository: ChainRepository;
  let orchestration: OrchestrationRepository;

  beforeAll(async () => {
    if (databaseUrl === undefined) {
      return;
    }
    client = createDatabaseClient({ connectionString: databaseUrl });
    await runDatabaseMigrations(client, resolve("src/db/migrations"));
    inbound = new InboundRepository(client.database);
    chainRepository = new ChainRepository(client.database);
    orchestration = new OrchestrationRepository(client.database, {
      workspaceRoot: "/tmp/step5-workspaces",
      interactionWorkingDirectory: "/tmp/step5-interaction",
      decrypt: decryptFixture,
      encrypt: encryptFixture,
      capabilities: () => [
        {
          workspaceBinding: "primary-repo",
          permissionProfiles: ["read"],
          modelProfiles: ["main"],
        },
      ],
    });
  });

  beforeEach(async () => {
    await client.pool.query(`
      truncate table
        approvals,
        memory_sync_events,
        usage_events,
        failure_events,
        outbound_parts,
        outbound_batches,
        execution_tasks,
        agent_threads,
        carried_messages,
        messages,
        chains,
        space_members,
        spaces,
        channel_identities,
        owners,
        deployments
      restart identity cascade
    `);
    await client.database.insert(deployments).values({
      id: deploymentId,
      name: "step5-integration",
      defaultModelProfile: "main",
    });
    await client.database.insert(owners).values({
      id: ownerId,
      deploymentId,
      timezone: "UTC",
    });
    await client.database.insert(channelIdentities).values({
      id: identityId,
      deploymentId,
      ownerId,
      normalizedHandleCiphertext: "cipher:owner",
      handleFingerprint: "step5-owner",
      role: "owner",
      verifiedAt: new Date("2026-08-14T00:00:00Z"),
    });
    await client.database.insert(spaces).values({
      id: spaceId,
      deploymentId,
      externalSpaceGuid: "step5-space",
      type: "dm",
      lastMessageAt: new Date("2026-08-14T00:00:00Z"),
    });
  });

  afterAll(async () => {
    await client?.close();
  });

  async function createChain(text = "inspect both paths") {
    await inbound.ingestAcceptedMessage({
      spaceId,
      externalMessageId: `step5-${text}`,
      senderIdentityId: identityId,
      contentCiphertext: `cipher:${text}`,
      contentHash: `hash:${text}`,
      receivedAt: new Date("2026-08-14T00:00:01Z"),
      retentionExpiresAt: new Date("2026-09-14T00:00:00Z"),
    });
    const chain = await chainRepository.flushInboundMessages(
      spaceId,
      new Date("2026-08-14T00:00:02Z"),
    );
    if (chain === null) {
      throw new Error("fixture chain was not created");
    }
    return {
      chainId: chain.chainId,
      expectedChainVersion: chain.version,
      expectedState: "queued" as const,
    };
  }

  it("persists parallel roots, reuses a named context, and retains partial failure", async () => {
    const payload = await createChain();
    const task = (
      id: string,
      agentName: string,
      dependsOn: string[] = [],
    ) => ({
      id,
      agentName,
      purpose: `Complete ${id}`,
      instructions: `Return the ${id} evidence.`,
      workspaceBinding: "primary-repo",
      modelProfile: "main" as const,
      permissionProfile: "read" as const,
      dependsOn,
    });
    const tasks = [
      task("inspect", "runtime-reviewer"),
      task("research", "docs-reviewer"),
      task("combine", "runtime-reviewer", ["inspect", "research"]),
    ];
    const decision = interactionDecisionSchema.parse({
      mode: "delegate",
      modelProfile: "main",
      userMessage: null,
      statusMessage: "I’m checking both paths now.",
      tasks,
      waitForTasks: true,
      memoryCandidates: [],
    });

    const committed = await orchestration.commitDelegation({
      payload,
      decision,
      selectedModelProfile: "main",
      promptVersion: "1:fixture",
      tasks: tasks.map((item) => ({
        task: item,
        instructionsCiphertext: `cipher:${item.instructions}`,
      })),
      rootLogicalTaskIds: ["inspect", "research"],
    });

    expect(committed.rootTasks).toHaveLength(2);
    expect(await orchestration.findRunnableTaskPayloads()).toHaveLength(2);
    expect(await client.database.select().from(executionTasks)).toHaveLength(3);
    expect(await client.database.select().from(agentThreads)).toHaveLength(2);
    const [delegatedChain] = await client.database
      .select({ decision: chains.decisionJson })
      .from(chains)
      .where(eq(chains.id, payload.chainId));
    expect(JSON.stringify(delegatedChain?.decision)).not.toContain(
      "Return the inspect evidence",
    );

    const [inspectPayload, researchPayload] = committed.rootTasks.map(
      ({ taskId }) => ({
        taskId,
        chainId: payload.chainId,
        expectedChainVersion: payload.expectedChainVersion,
        expectedState: "queued" as const,
      }),
    );
    if (inspectPayload === undefined || researchPayload === undefined) {
      throw new Error("parallel task payloads were not materialized");
    }
    const inspect = await orchestration.claimTask(inspectPayload);
    const research = await orchestration.claimTask(researchPayload);
    if (inspect === null || research === null) {
      throw new Error("parallel tasks were not claimable");
    }
    const succeeded = (taskId: string) =>
      executionResultSchema.parse({
        taskId,
        status: "succeeded",
        userSafeSummary: `${taskId} succeeded with evidence.`,
        artifacts: [],
        proposedActions: [],
        memoryCandidates: [],
        error: null,
      });
    const failed = (taskId: string) =>
      executionResultSchema.parse({
        taskId,
        status: "failed",
        userSafeSummary: `${taskId} could not complete.`,
        artifacts: [],
        proposedActions: [],
        memoryCandidates: [],
        error: {
          code: "FIXTURE_FAILURE",
          retryable: false,
          safeMessage: "The fixture dependency is unavailable.",
        },
      });
    await orchestration.completeTask({
      payload: inspectPayload,
      result: succeeded(inspect.task.id),
      promptSha256: "a".repeat(64),
      recovered: false,
    });
    const terminal = await orchestration.completeTask({
      payload: researchPayload,
      result: failed(research.task.id),
      promptSha256: "b".repeat(64),
      recovered: false,
    });

    expect(terminal.shouldSynthesize).toBe(true);
    const synthesis = await orchestration.loadSynthesisContext({
      chainId: payload.chainId,
      expectedChainVersion: payload.expectedChainVersion,
      expectedState: "executing",
    });
    expect(
      synthesis?.terminalResults
        .map((result) => executionResultSchema.parse(result).status)
        .sort(),
    ).toEqual(["failed", "failed", "succeeded"]);
  });

  it("atomically materializes a direct response before moving the chain to sending", async () => {
    const payload = await createChain("hello");
    const decision = interactionDecisionSchema.parse({
      mode: "direct",
      modelProfile: "main",
      userMessage: "Hi — what would you like to work on?",
      statusMessage: null,
      tasks: [],
      waitForTasks: false,
      memoryCandidates: [],
    });
    const committed = await orchestration.commitFinal({
      payload,
      decision,
      selectedModelProfile: "main",
      promptVersion: "1:fixture",
      promptSha256: "c".repeat(64),
      encryptedParts: ["cipher:Hi — what would you like to work on?"],
    });

    const [chain] = await client.database
      .select({ state: chains.state, decision: chains.decisionJson })
      .from(chains)
      .where(eq(chains.id, payload.chainId));
    const [batch] = await client.database
      .select({ id: outboundBatches.id })
      .from(outboundBatches)
      .where(eq(outboundBatches.chainId, payload.chainId));
    expect(chain?.state).toBe("sending");
    expect(JSON.stringify(chain?.decision)).not.toContain(
      "what would you like to work on",
    );
    expect(batch?.id).toBe(committed.outboundBatchId);
  });

  it("encrypts proposed-action payloads before storing execution results", async () => {
    const payload = await createChain("prepare an external send");
    const task = {
      id: "prepare",
      agentName: "release-reviewer",
      purpose: "Prepare the exact external action.",
      instructions: "Return an approval proposal without executing it.",
      workspaceBinding: "primary-repo",
      modelProfile: "main" as const,
      permissionProfile: "read" as const,
      dependsOn: [],
    };
    const decision = interactionDecisionSchema.parse({
      mode: "delegate",
      modelProfile: "main",
      userMessage: null,
      statusMessage: null,
      tasks: [task],
      waitForTasks: true,
      memoryCandidates: [],
    });
    const committed = await orchestration.commitDelegation({
      payload,
      decision,
      selectedModelProfile: "main",
      promptVersion: "1:fixture",
      tasks: [{ task, instructionsCiphertext: "cipher:instructions" }],
      rootLogicalTaskIds: [task.id],
    });
    const databaseTaskId = committed.rootTasks[0]?.taskId;
    if (databaseTaskId === undefined) {
      throw new Error("approval fixture task was not persisted");
    }
    const taskPayload = {
      taskId: databaseTaskId,
      chainId: payload.chainId,
      expectedChainVersion: payload.expectedChainVersion,
      expectedState: "queued" as const,
    };
    const claimed = await orchestration.claimTask(taskPayload);
    if (claimed === null) {
      throw new Error("approval fixture task was not claimable");
    }
    await orchestration.completeTask({
      payload: taskPayload,
      result: executionResultSchema.parse({
        taskId: claimed.task.id,
        status: "needs_approval",
        userSafeSummary: "The prepared send requires exact confirmation.",
        artifacts: [],
        proposedActions: [
          {
            actionType: "external.send",
            target: "release channel",
            normalizedPayload: {
              token: "secret-action-token",
              body: "private release draft",
            },
            humanSummary: "Publish the prepared release draft.",
          },
        ],
        memoryCandidates: [],
        error: null,
      }),
      promptSha256: "d".repeat(64),
      recovered: false,
    });

    const [stored] = await client.database
      .select({ result: executionTasks.resultJson })
      .from(executionTasks)
      .where(eq(executionTasks.id, databaseTaskId));
    const serialized = JSON.stringify(stored?.result);
    expect(serialized).not.toContain("secret-action-token");
    expect(serialized).not.toContain("private release draft");
    expect(serialized).toContain("secure:");
  });

  it("persists reusable thread summaries encrypted for interaction and named contexts", async () => {
    const payload = await createChain("establish an authorized conversation");
    const repository = new PostgresCodexThreadRepository(client.database, {
      encrypt: encryptFixture,
      decrypt: decryptFixture,
    });
    const interactionScope = {
      kind: "interaction" as const,
      ownerId,
      spaceId,
    };
    const executorScope = {
      kind: "executor" as const,
      ownerId,
      agentName: "runtime-reviewer",
      workspaceBinding: "primary-repo",
    };
    const updatedAt = new Date("2026-08-14T00:00:03Z");

    await repository.save({
      scopeKey: codexThreadScopeKey(interactionScope),
      scope: interactionScope,
      state: "active",
      threadId: "interaction-thread",
      recoverySummary: "private interaction summary",
      generation: 1,
      updatedAt,
    });
    await repository.save({
      scopeKey: codexThreadScopeKey(executorScope),
      scope: executorScope,
      state: "active",
      threadId: "executor-thread",
      recoverySummary: "private named context summary",
      generation: 1,
      updatedAt,
    });

    const restoredInteraction = await repository.get(
      codexThreadScopeKey(interactionScope),
    );
    const restoredExecutor = await repository.get(
      codexThreadScopeKey(executorScope),
    );
    expect(restoredInteraction?.recoverySummary).toBe(
      "private interaction summary",
    );
    expect(restoredExecutor?.threadId).toBe("executor-thread");
    expect(restoredExecutor?.recoverySummary).toBe(
      "private named context summary",
    );
    const planContext = await orchestration.loadPlanContext(payload);
    expect(planContext?.recoverySummary).toBe("private interaction summary");
    expect(planContext?.activeAgents).toEqual([
      expect.objectContaining({
        name: "runtime-reviewer",
        summary: "private named context summary",
      }),
    ]);

    const [storedSpace] = await client.database
      .select({ summary: spaces.interactionSummary })
      .from(spaces)
      .where(eq(spaces.id, spaceId));
    const [storedExecutor] = await client.database
      .select({ summary: agentThreads.summary })
      .from(agentThreads)
      .where(eq(agentThreads.ownerId, ownerId));
    expect(storedSpace?.summary).toMatch(/^secure:/u);
    expect(storedSpace?.summary).not.toContain("private interaction summary");
    expect(storedExecutor?.summary).toMatch(/^secure:/u);
    expect(storedExecutor?.summary).not.toContain("private named context summary");
  });
});
