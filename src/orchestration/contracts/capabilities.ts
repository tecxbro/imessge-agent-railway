import type { PermissionProfileName } from "../../security/permissions.js";

export interface OrchestrationIdentity {
  deploymentId: string;
  ownerId: string;
  spaceId: string;
  chainId?: string;
}

export interface ExecutionCapability {
  workspaceBinding: string;
  permissionProfiles: readonly PermissionProfileName[];
}

export type ExecutionCapabilitySource = (
  input: OrchestrationIdentity,
) =>
  | Promise<readonly ExecutionCapability[]>
  | readonly ExecutionCapability[];
