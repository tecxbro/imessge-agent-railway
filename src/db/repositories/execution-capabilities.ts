import { and, asc, eq } from "drizzle-orm";

import {
  executionCapabilityBindingRecordSchema,
  type ExecutionCapabilityBindingRecord,
  type ExecutionCapabilityRepository,
} from "../../agent/execution-capability-service.js";
import type { Database } from "../client.js";
import { executionCapabilityBindings } from "../schema-fragments/execution-capabilities.js";
import { deployments, owners } from "../schema.js";

export class PostgresExecutionCapabilityRepository
  implements ExecutionCapabilityRepository
{
  public constructor(private readonly database: Database) {}

  /** Idempotent production seed for the deployment's reviewed personal root. */
  public async seedPersonalWorkspaceBinding(
    deploymentId: string,
  ): Promise<void> {
    await this.database
      .insert(executionCapabilityBindings)
      .values({
        deploymentId,
        workspaceBinding: "personal",
        relativeWorkspacePath: ".",
        allowedPermissionProfiles: [
          "read",
          "workspace-write",
          "network-read",
          "approval-required",
        ],
        enabled: true,
        revision: 1,
      })
      .onConflictDoNothing();
  }

  public async listForActor(
    deploymentId: string,
    ownerId: string,
  ): Promise<readonly ExecutionCapabilityBindingRecord[]> {
    const rows = await this.database
      .select({
        deploymentId: executionCapabilityBindings.deploymentId,
        workspaceBinding: executionCapabilityBindings.workspaceBinding,
        relativeWorkspacePath:
          executionCapabilityBindings.relativeWorkspacePath,
        allowedPermissionProfiles:
          executionCapabilityBindings.allowedPermissionProfiles,
        enabled: executionCapabilityBindings.enabled,
        revision: executionCapabilityBindings.revision,
        createdAt: executionCapabilityBindings.createdAt,
        updatedAt: executionCapabilityBindings.updatedAt,
      })
      .from(executionCapabilityBindings)
      .innerJoin(
        deployments,
        eq(deployments.id, executionCapabilityBindings.deploymentId),
      )
      .innerJoin(
        owners,
        and(
          eq(owners.id, ownerId),
          eq(owners.deploymentId, executionCapabilityBindings.deploymentId),
        ),
      )
      .where(
        and(
          eq(executionCapabilityBindings.deploymentId, deploymentId),
          eq(deployments.status, "active"),
          eq(owners.status, "active"),
        ),
      )
      .orderBy(asc(executionCapabilityBindings.workspaceBinding));

    return rows.map((row) => executionCapabilityBindingRecordSchema.parse(row));
  }
}
