import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ActionExecutor,
  ActionExecutorInput,
} from "../../src/actions/action-executor.js";
import { ActionExecutorRegistry } from "../../src/actions/action-executor-registry.js";
import { executionResultSchema } from "../../src/agent/schemas.js";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";
import { runDatabaseMigrations } from "../../src/db/migrate.js";
import { ActionExecutionRepository } from "../../src/db/repositories/action-executions.js";
import { ApprovalRepository } from "../../src/db/repositories/approvals.js";
import { actionExecutions } from "../../src/db/schema-fragments/approval-executions.js";
import {
  agentThreads,
  approvals,
  chains,
  channelIdentities,
  deployments,
  executionTasks,
  owners,
  spaces,
} from "../../src/db/schema.js";
import { createApprovalExecuteHandler } from "../../src/queue/handlers/approval-execute.js";
import { createApprovalRequestHandler } from "../../src/queue/handlers/approval-request.js";
import {
  ApprovalService,
  createApprovalPayloadCipher,
  type ApprovalActor,
} from "../../src/security/approvals.js";

const databaseUrl = process.env["POSTGRES_PIPELINE_TEST_DATABASE_URL"];
const describeDatabase = databaseUrl === undefined ? describe.skip : describe;

const deploymentId = "53000000-0000-4000-8000-000000000001";
const ownerId = "53000000-0000-4000-8000-000000000002";
const identityId = "53000000-0000-4000-8000-000000000003";
const spaceId = "53000000-0000-4000-8000-000000000004";
const chainId = "53000000-0000-4000-8000-000000000005";
const agentThreadId = "53000000-0000-4000-8000-000000000006";
const taskId = "53000000-0000-4000-8000-000000000007";

const encryptFixture = (plaintext: string) =>
  `secure:${Buffer.from(plaintext, "utf8").toString("base64")}`;
const decryptFixture = (ciphertext: string) =>
  Buffer.from(ciphertext.slice("secure:".length), "base64").toString("utf8");

const owner: ApprovalActor = {
  ownerId,
  identityId,
  role: "owner",
  canApprove: true,
};

async function applyLeafMigration(client: DatabaseClient): Promise<void> {
  const table = await client.pool.query<{ table_name: string | null }>(
    "select to_regclass('public.action_executions')::text as table_name",
  );
  if (table.rows[0]?.table_name != null) {
    return;
  }
  const migration = readFileSync(
    resolve("src/db/migrations/0009_approval_action_execution.sql"),
    "utf8",
  );
  await client.pool.query("begin");
  try {
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim().length > 0) {
        await client.pool.query(statement);
      }
    }
    await client.pool.query("commit");
  } catch (error) {
    await client.pool.query("rollback");
    throw error;
  }
}

describeDatabase("durable approval action execution", () => {
  let client: DatabaseClient;

  beforeAll(async () => {
    if (databaseUrl === undefined) {
      return;
    }
    client = createDatabaseClient({ connectionString: databaseUrl });
    await runDatabaseMigrations(client, resolve("src/db/migrations"));
    await applyLeafMigration(client);
  });

  beforeEach(async () => {
    await client.pool.query(`
      truncate table
        action_executions,
        approvals,
        execution_tasks,
        agent_threads,
        chains,
        spaces,
        channel_identities,
        owners,
        deployments
      restart identity cascade
    `);
    await client.database.insert(deployments).values({
      id: deploymentId,
      name: "approval-integration",
      defaultModelProfile: "main",
      effectiveModelId: "gpt-5.6-luna",
      effectiveReasoningEffort: "high",
      modelSelectionState: "preferred",
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
      handleFingerprint: "approval-owner",
      role: "owner",
      verifiedAt: new Date("2026-08-18T12:00:00Z"),
    });
    await client.database.insert(spaces).values({
      id: spaceId,
      deploymentId,
      externalSpaceGuid: "approval-space",
      type: "dm",
      lastMessageAt: new Date("2026-08-18T12:00:00Z"),
    });
    await client.database.insert(chains).values({
      id: chainId,
      spaceId,
      version: 1,
      state: "executing",
      chainStartedAt: new Date("2026-08-18T12:00:00Z"),
      modelId: "gpt-5.6-luna",
      reasoningEffort: "high",
    });
    await client.database.insert(agentThreads).values({
      id: agentThreadId,
      ownerId,
      agentName: "sender",
      workspaceBinding: "primary-repo",
      lastUsedAt: new Date("2026-08-18T12:00:00Z"),
    });
    const result = executionResultSchema.parse({
      taskId: "send-release",
      status: "needs_approval",
      userSafeSummary: "The prepared release needs approval.",
      artifacts: [],
      proposedActions: [
        {
          actionType: "external.send",
          target: "release@example.com",
          normalizedPayload: {
            recipient: "release@example.com",
            body: "durable exact body",
          },
          humanSummary: "Send the prepared release.",
        },
      ],
      memoryCandidates: [],
      error: null,
    });
    await client.database.insert(executionTasks).values({
      id: taskId,
      chainId,
      agentThreadId,
      name: "send-release",
      purpose: "Send a prepared release.",
      modelProfile: "main",
      permissionProfile: "write",
      state: "needs_approval",
      resultJson: { ciphertext: encryptFixture(JSON.stringify(result)) },
    });
  });

  afterAll(async () => {
    await client?.close();
  });

  it("creates once, consumes once, and executes the stored payload once", async () => {
    const approvalCipher = createApprovalPayloadCipher("55".repeat(32));
    const approvalRepository = new ApprovalRepository(client.database, {
      encryptExecutionResult: encryptFixture,
    });
    const approvalsService = new ApprovalService(
      approvalRepository,
      approvalCipher,
      () => new Date("2026-08-18T12:00:01Z"),
    );
    const execute = vi.fn(
      async (_input: ActionExecutorInput, _signal: AbortSignal) => ({
        safeSummary: "The prepared release was sent.",
        providerReference: "provider-reference",
        safeMetadata: { delivered: true },
      }),
    );
    const executor: ActionExecutor = {
      actionType: "external.send",
      execute,
    };
    const executors = new ActionExecutorRegistry([executor]);
    const requestHandler = createApprovalRequestHandler({
      repository: approvalRepository,
      approvals: approvalsService,
      executors,
      publisher: { publishApprovalRequest: async () => undefined },
      decryptExecutionResult: decryptFixture,
    });

    const first = await requestHandler({ executionTaskId: taskId });
    const second = await requestHandler({ executionTaskId: taskId });
    expect(first?.id).toBe(second?.id);
    const approvalRows = await client.database.select().from(approvals);
    expect(approvalRows).toHaveLength(1);

    await expect(
      approvalsService.respond(owner, spaceId, first!.id, "approved"),
    ).resolves.toBe(true);
    await expect(
      approvalRepository.findApprovedActionRecoveries(
        new Date("2026-08-18T12:00:02Z"),
      ),
    ).resolves.toEqual([
      {
        approvalId: first!.id,
        ownerId,
        spaceId,
        executionTaskId: taskId,
      },
    ]);
    const consumed = await approvalsService.consume(
      first!.id,
      ownerId,
      spaceId,
      taskId,
    );
    expect(consumed?.action.normalizedPayload).toEqual({
      recipient: "release@example.com",
      body: "durable exact body",
    });
    await expect(
      approvalRepository.findApprovedActionRecoveries(
        new Date("2026-08-18T12:00:02Z"),
      ),
    ).resolves.toEqual([]);
    await expect(
      approvalsService.consume(first!.id, ownerId, spaceId, taskId),
    ).resolves.toBeUndefined();
    const executionRows = await client.database.select().from(actionExecutions);
    expect(executionRows).toHaveLength(1);

    const executeHandler = createApprovalExecuteHandler({
      repository: new ActionExecutionRepository(client.database, {
        encryptExecutionResult: encryptFixture,
      }),
      executors,
      cipher: approvalCipher,
      publisher: {
        enqueueNewlyRunnableTask: async () => undefined,
        enqueueApprovalSynthesis: async () => undefined,
      },
    });
    await executeHandler({ actionExecutionId: consumed!.actionExecutionId });
    await executeHandler({ actionExecutionId: consumed!.actionExecutionId });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0].actionExecutionId).toBe(
      consumed?.actionExecutionId,
    );
    const [execution] = await client.database
      .select({ status: actionExecutions.status })
      .from(actionExecutions)
      .where(eq(actionExecutions.id, consumed!.actionExecutionId));
    const [task] = await client.database
      .select({ state: executionTasks.state })
      .from(executionTasks)
      .where(eq(executionTasks.id, taskId));
    expect(execution?.status).toBe("succeeded");
    expect(task?.state).toBe("succeeded");
  });

  it("revalidates the approving owner identity in the consume transaction", async () => {
    const approvalCipher = createApprovalPayloadCipher("56".repeat(32));
    const repository = new ApprovalRepository(client.database, {
      encryptExecutionResult: encryptFixture,
    });
    const service = new ApprovalService(repository, approvalCipher);
    const handler = createApprovalRequestHandler({
      repository,
      approvals: service,
      executors: new ActionExecutorRegistry([
        {
          actionType: "external.send",
          execute: async () => ({
            safeSummary: "sent",
            providerReference: null,
            safeMetadata: {},
          }),
        },
      ]),
      publisher: { publishApprovalRequest: async () => undefined },
      decryptExecutionResult: decryptFixture,
    });
    const request = await handler({ executionTaskId: taskId });
    await service.respond(owner, spaceId, request!.id, "approved");
    await client.database
      .update(channelIdentities)
      .set({ revokedAt: new Date("2026-08-18T12:00:02Z") })
      .where(eq(channelIdentities.id, identityId));

    await expect(
      service.consume(request!.id, ownerId, spaceId, taskId),
    ).resolves.toBeUndefined();
    expect(await client.database.select().from(actionExecutions)).toHaveLength(0);
  });

  it("discovers expired approval scopes for the production sweep", async () => {
    const repository = new ApprovalRepository(client.database, {
      encryptExecutionResult: encryptFixture,
    });
    await client.database.insert(approvals).values({
      id: "53000000-0000-4000-8000-000000000008",
      chainId,
      executionTaskId: taskId,
      ownerId,
      spaceId,
      actionType: "external.send",
      normalizedPayloadCiphertext: "encrypted-action",
      actionHash: "a".repeat(64),
      humanSummary: "Send the prepared release.",
      status: "pending",
      expiresAt: new Date("2026-08-18T11:59:59Z"),
    });

    await expect(
      repository.findExpiredApprovalScopes(
        new Date("2026-08-18T12:00:00Z"),
      ),
    ).resolves.toEqual([{ ownerId, spaceId }]);

    const service = new ApprovalService(
      repository,
      createApprovalPayloadCipher("57".repeat(32)),
      () => new Date("2026-08-18T12:00:00Z"),
    );
    await expect(service.expireWithProgression(ownerId, spaceId)).resolves.toMatchObject({
      expiredCount: 1,
    });
    await expect(
      repository.findExpiredApprovalScopes(
        new Date("2026-08-18T12:00:00Z"),
      ),
    ).resolves.toEqual([]);
  });
});
