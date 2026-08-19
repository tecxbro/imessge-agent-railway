import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, win32 } from "node:path";

import { z } from "zod";

import {
  enforcePermissionGrantSet,
  permissionGrantsForRole,
} from "../security/permission-grants.js";
import {
  permissionProfileNameSchema,
  type AuthorizedSenderRole,
  type PermissionProfileName,
} from "../security/permissions.js";

const bindingNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const relativeWorkspacePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) => value.trim().length > 0,
    "Workspace paths cannot be blank.",
  )
  .refine(
    (value) => !value.includes("\0"),
    "Workspace paths cannot contain NUL bytes.",
  );
const permissionProfileSetSchema = z
  .array(permissionProfileNameSchema)
  .min(1)
  .max(4)
  .superRefine((profiles, context) => {
    if (new Set(profiles).size !== profiles.length) {
      context.addIssue({
        code: "custom",
        message: "Permission profile sets cannot contain duplicates.",
      });
    }
  });

export const executionCapabilityBindingRecordSchema = z
  .object({
    deploymentId: z.uuid(),
    workspaceBinding: bindingNameSchema,
    relativeWorkspacePath: relativeWorkspacePathSchema,
    allowedPermissionProfiles: permissionProfileSetSchema,
    enabled: z.boolean(),
    revision: z.number().int().positive(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict();

const executionCapabilityActorSchema = z
  .object({
    deploymentId: z.uuid(),
    ownerId: z.uuid(),
    senderRole: z.enum(["owner", "collaborator"]),
  })
  .strict();

export type ExecutionCapabilityBindingRecord = z.infer<
  typeof executionCapabilityBindingRecordSchema
>;

export interface ExecutionCapabilityRepository {
  listForActor(
    deploymentId: string,
    ownerId: string,
  ): Promise<readonly ExecutionCapabilityBindingRecord[]>;
}

export interface ExecutionCapabilityActor {
  deploymentId: string;
  ownerId: string;
  senderRole: AuthorizedSenderRole;
}

export interface AvailableExecutionCapability {
  deploymentId: string;
  ownerId: string;
  workspaceBinding: string;
  relativeWorkspacePath: string;
  resolvedWorkspacePath: string;
  allowedPermissionProfiles: readonly PermissionProfileName[];
  revision: number;
}

export interface AuthorizedExecutionCapability
  extends AvailableExecutionCapability {
  permissionProfile: PermissionProfileName;
}

export type ExecutionCapabilityErrorCode =
  | "EXECUTION_CAPABILITY_NOT_FOUND"
  | "EXECUTION_CAPABILITY_DISABLED"
  | "EXECUTION_CAPABILITY_RECORD_INVALID"
  | "WORKSPACE_ROOT_INVALID"
  | "WORKSPACE_PATH_TRAVERSAL"
  | "WORKSPACE_BINDING_MISSING"
  | "WORKSPACE_BINDING_NOT_DIRECTORY"
  | "WORKSPACE_SYMLINK_ESCAPE"
  | "CODEX_HOME_INVALID"
  | "CODEX_HOME_OVERLAP";

export class ExecutionCapabilityError extends Error {
  public constructor(
    public readonly code: ExecutionCapabilityErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ExecutionCapabilityError";
  }
}

export interface ExecutionCapabilityServiceOptions {
  repository: ExecutionCapabilityRepository;
  workspaceRoot: string;
  codexHome: string;
}

interface ResolvedRoots {
  workspaceRoot: string;
  codexHome: string;
}

function isContained(parent: string, child: string): boolean {
  const childRelative = relative(parent, child);
  return (
    childRelative === "" ||
    (!childRelative.startsWith("..") && !isAbsolute(childRelative))
  );
}

function pathsOverlap(first: string, second: string): boolean {
  return isContained(first, second) || isContained(second, first);
}

function containsParentSegment(path: string): boolean {
  return path.split(/[\\/]+/u).some((segment) => segment === "..");
}

export class ExecutionCapabilityService {
  public constructor(
    private readonly options: ExecutionCapabilityServiceOptions,
  ) {}

  public async listAvailableCapabilities(
    actorInput: ExecutionCapabilityActor,
  ): Promise<readonly AvailableExecutionCapability[]> {
    const actor = executionCapabilityActorSchema.parse(actorInput);
    const records = await this.recordsForActor(actor);
    const roots = await this.resolveRoots();
    const available: AvailableExecutionCapability[] = [];

    for (const record of records) {
      if (!record.enabled) {
        continue;
      }
      const grants = permissionGrantsForRole(
        actor.senderRole,
        record.allowedPermissionProfiles,
      );
      if (grants.size === 0) {
        continue;
      }
      available.push(
        await this.resolveCapability(actor, record, grants, roots),
      );
    }

    return available;
  }

  public async authorizeExecutionCapability(
    actorInput: ExecutionCapabilityActor,
    request: {
      workspaceBinding: string;
      permissionProfile: PermissionProfileName;
    },
  ): Promise<AuthorizedExecutionCapability> {
    const actor = executionCapabilityActorSchema.parse(actorInput);
    const workspaceBinding = bindingNameSchema.parse(request.workspaceBinding);
    const permissionProfile = permissionProfileNameSchema.parse(
      request.permissionProfile,
    );
    const records = await this.recordsForActor(actor);
    const record = records.find(
      (candidate) => candidate.workspaceBinding === workspaceBinding,
    );

    if (record === undefined) {
      throw new ExecutionCapabilityError(
        "EXECUTION_CAPABILITY_NOT_FOUND",
        `Workspace binding ${workspaceBinding} is not code-authorized for this deployment and owner. Reject the task without starting Codex.`,
      );
    }
    if (!record.enabled) {
      throw new ExecutionCapabilityError(
        "EXECUTION_CAPABILITY_DISABLED",
        `Workspace binding ${workspaceBinding} is disabled. Enable a reviewed binding before retrying.`,
      );
    }

    const grants = permissionGrantsForRole(
      actor.senderRole,
      record.allowedPermissionProfiles,
    );
    enforcePermissionGrantSet(permissionProfile, grants);
    const capability = await this.resolveCapability(
      actor,
      record,
      grants,
      await this.resolveRoots(),
    );
    return { ...capability, permissionProfile };
  }

  private async recordsForActor(
    actor: ExecutionCapabilityActor,
  ): Promise<ExecutionCapabilityBindingRecord[]> {
    const records = await this.options.repository.listForActor(
      actor.deploymentId,
      actor.ownerId,
    );
    try {
      const parsed = records.map((record) =>
        executionCapabilityBindingRecordSchema.parse(record),
      );
      if (parsed.some((record) => record.deploymentId !== actor.deploymentId)) {
        throw new Error(
          "The execution capability repository returned a cross-deployment row.",
        );
      }
      return parsed;
    } catch (error) {
      throw new ExecutionCapabilityError(
        "EXECUTION_CAPABILITY_RECORD_INVALID",
        "An execution capability row is invalid. Repair the persisted binding before enabling execution.",
        { cause: error },
      );
    }
  }

  private async resolveRoots(): Promise<ResolvedRoots> {
    if (!isAbsolute(this.options.workspaceRoot)) {
      throw new ExecutionCapabilityError(
        "WORKSPACE_ROOT_INVALID",
        "AGENT_WORKSPACE_ROOT must be an absolute directory before capabilities can be resolved.",
      );
    }
    if (!isAbsolute(this.options.codexHome)) {
      throw new ExecutionCapabilityError(
        "CODEX_HOME_INVALID",
        "CODEX_HOME must be an absolute directory before capabilities can be resolved.",
      );
    }

    const workspaceRoot = await this.realDirectory(
      this.options.workspaceRoot,
      "WORKSPACE_ROOT_INVALID",
      "AGENT_WORKSPACE_ROOT must exist and be a directory before capabilities can be resolved.",
    );
    const codexHome = await this.realDirectory(
      this.options.codexHome,
      "CODEX_HOME_INVALID",
      "CODEX_HOME must exist and be a directory before capabilities can be resolved.",
    );
    if (pathsOverlap(workspaceRoot, codexHome)) {
      throw new ExecutionCapabilityError(
        "CODEX_HOME_OVERLAP",
        "CODEX_HOME and AGENT_WORKSPACE_ROOT overlap after realpath resolution. Separate the credential and workspace directories before enabling execution.",
      );
    }
    return { workspaceRoot, codexHome };
  }

  private async realDirectory(
    path: string,
    code: "WORKSPACE_ROOT_INVALID" | "CODEX_HOME_INVALID",
    message: string,
  ): Promise<string> {
    try {
      const resolvedPath = await realpath(path);
      if (!(await stat(resolvedPath)).isDirectory()) {
        throw new ExecutionCapabilityError(code, message);
      }
      return resolvedPath;
    } catch (error) {
      if (error instanceof ExecutionCapabilityError) {
        throw error;
      }
      throw new ExecutionCapabilityError(code, message, { cause: error });
    }
  }

  private async resolveCapability(
    actor: ExecutionCapabilityActor,
    record: ExecutionCapabilityBindingRecord,
    grants: ReadonlySet<PermissionProfileName>,
    roots: ResolvedRoots,
  ): Promise<AvailableExecutionCapability> {
    if (
      isAbsolute(record.relativeWorkspacePath) ||
      win32.isAbsolute(record.relativeWorkspacePath) ||
      containsParentSegment(record.relativeWorkspacePath)
    ) {
      throw new ExecutionCapabilityError(
        "WORKSPACE_PATH_TRAVERSAL",
        `Workspace binding ${record.workspaceBinding} is not a contained relative path. Repair the binding before retrying.`,
      );
    }

    const candidate = resolve(
      this.options.workspaceRoot,
      record.relativeWorkspacePath,
    );
    if (!isContained(this.options.workspaceRoot, candidate)) {
      throw new ExecutionCapabilityError(
        "WORKSPACE_PATH_TRAVERSAL",
        `Workspace binding ${record.workspaceBinding} resolved outside AGENT_WORKSPACE_ROOT. Repair the binding before retrying.`,
      );
    }

    let resolvedWorkspacePath: string;
    try {
      resolvedWorkspacePath = await realpath(candidate);
    } catch (error) {
      throw new ExecutionCapabilityError(
        "WORKSPACE_BINDING_MISSING",
        `Workspace binding ${record.workspaceBinding} does not exist. Create the reviewed directory before retrying.`,
        { cause: error },
      );
    }
    if (!isContained(roots.workspaceRoot, resolvedWorkspacePath)) {
      throw new ExecutionCapabilityError(
        "WORKSPACE_SYMLINK_ESCAPE",
        `Workspace binding ${record.workspaceBinding} escapes AGENT_WORKSPACE_ROOT through a symlink. Replace the binding with a contained directory.`,
      );
    }
    if (!(await stat(resolvedWorkspacePath)).isDirectory()) {
      throw new ExecutionCapabilityError(
        "WORKSPACE_BINDING_NOT_DIRECTORY",
        `Workspace binding ${record.workspaceBinding} is not a directory. Replace it with a reviewed workspace directory.`,
      );
    }
    if (pathsOverlap(resolvedWorkspacePath, roots.codexHome)) {
      throw new ExecutionCapabilityError(
        "CODEX_HOME_OVERLAP",
        `Workspace binding ${record.workspaceBinding} overlaps CODEX_HOME. Separate workspaces from Codex credentials before retrying.`,
      );
    }

    return {
      deploymentId: actor.deploymentId,
      ownerId: actor.ownerId,
      workspaceBinding: record.workspaceBinding,
      relativeWorkspacePath: record.relativeWorkspacePath,
      resolvedWorkspacePath,
      allowedPermissionProfiles: [...grants],
      revision: record.revision,
    };
  }
}
