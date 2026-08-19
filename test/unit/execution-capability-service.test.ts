import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  ExecutionCapabilityService,
  type ExecutionCapabilityActor,
  type ExecutionCapabilityBindingRecord,
  type ExecutionCapabilityRepository,
} from "../../src/agent/execution-capability-service.js";

const deploymentId = "00000000-0000-4000-8000-000000000001";
const ownerId = "00000000-0000-4000-8000-000000000002";
const now = new Date("2026-08-18T16:00:00Z");
const actor: ExecutionCapabilityActor = {
  deploymentId,
  ownerId,
  senderRole: "owner",
};

class FakeExecutionCapabilityRepository
  implements ExecutionCapabilityRepository
{
  public readonly calls: Array<{ deploymentId: string; ownerId: string }> = [];

  public constructor(
    private readonly records: readonly ExecutionCapabilityBindingRecord[],
  ) {}

  public async listForActor(
    requestedDeploymentId: string,
    requestedOwnerId: string,
  ): Promise<readonly ExecutionCapabilityBindingRecord[]> {
    this.calls.push({
      deploymentId: requestedDeploymentId,
      ownerId: requestedOwnerId,
    });
    return this.records.filter(
      (record) => record.deploymentId === requestedDeploymentId,
    );
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function record(
  overrides: Partial<ExecutionCapabilityBindingRecord> = {},
): ExecutionCapabilityBindingRecord {
  return {
    deploymentId,
    workspaceBinding: "personal",
    relativeWorkspacePath: "personal",
    allowedPermissionProfiles: [
      "read",
      "workspace-write",
      "network-read",
      "approval-required",
    ],
    enabled: true,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function serviceFor(
  records: readonly ExecutionCapabilityBindingRecord[],
): Promise<{
  root: string;
  codexHome: string;
  repository: FakeExecutionCapabilityRepository;
  service: ExecutionCapabilityService;
}> {
  const root = await temporaryDirectory("execution-capability-root-");
  const codexHome = await temporaryDirectory("execution-capability-codex-");
  const repository = new FakeExecutionCapabilityRepository(records);
  return {
    root,
    codexHome,
    repository,
    service: new ExecutionCapabilityService({
      repository,
      workspaceRoot: root,
      codexHome,
    }),
  };
}

describe("ExecutionCapabilityService", () => {
  it("authorizes an exact configured profile in a real contained workspace", async () => {
    const harness = await serviceFor([record()]);
    await mkdir(join(harness.root, "personal"));

    const capability = await harness.service.authorizeExecutionCapability(actor, {
      workspaceBinding: "personal",
      permissionProfile: "workspace-write",
    });

    expect(capability).toEqual({
      deploymentId,
      ownerId,
      workspaceBinding: "personal",
      relativeWorkspacePath: "personal",
      resolvedWorkspacePath: await realpath(join(harness.root, "personal")),
      allowedPermissionProfiles: [
        "read",
        "workspace-write",
        "network-read",
        "approval-required",
      ],
      revision: 1,
      permissionProfile: "workspace-write",
    });
    expect(harness.repository.calls).toEqual([{ deploymentId, ownerId }]);
  });

  it("rejects a relative path containing traversal segments", async () => {
    const root = await temporaryDirectory("execution-capability-root-");
    const outside = await temporaryDirectory("execution-capability-outside-");
    const codexHome = await temporaryDirectory("execution-capability-codex-");
    const repository = new FakeExecutionCapabilityRepository([
      record({ relativeWorkspacePath: relative(root, outside) }),
    ]);
    const service = new ExecutionCapabilityService({
      repository,
      workspaceRoot: root,
      codexHome,
    });

    await expect(
      service.authorizeExecutionCapability(actor, {
        workspaceBinding: "personal",
        permissionProfile: "read",
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_PATH_TRAVERSAL" });
  });

  it("rejects a workspace symlink that escapes the real workspace root", async () => {
    const harness = await serviceFor([
      record({ workspaceBinding: "escaped", relativeWorkspacePath: "escaped" }),
    ]);
    const outside = await temporaryDirectory("execution-capability-outside-");
    await symlink(outside, join(harness.root, "escaped"), "dir");

    await expect(
      harness.service.authorizeExecutionCapability(actor, {
        workspaceBinding: "escaped",
        permissionProfile: "read",
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_SYMLINK_ESCAPE" });
  });

  it("rejects a disabled binding and omits it from capability listing", async () => {
    const harness = await serviceFor([record({ enabled: false })]);
    await mkdir(join(harness.root, "personal"));

    await expect(
      harness.service.authorizeExecutionCapability(actor, {
        workspaceBinding: "personal",
        permissionProfile: "read",
      }),
    ).rejects.toMatchObject({ code: "EXECUTION_CAPABILITY_DISABLED" });
    await expect(
      harness.service.listAvailableCapabilities(actor),
    ).resolves.toEqual([]);
  });

  it("restricts collaborators to configured read access", async () => {
    const harness = await serviceFor([record()]);
    await mkdir(join(harness.root, "personal"));
    const collaborator = { ...actor, senderRole: "collaborator" } as const;

    await expect(
      harness.service.listAvailableCapabilities(collaborator),
    ).resolves.toMatchObject([
      { workspaceBinding: "personal", allowedPermissionProfiles: ["read"] },
    ]);
    await expect(
      harness.service.authorizeExecutionCapability(collaborator, {
        workspaceBinding: "personal",
        permissionProfile: "workspace-write",
      }),
    ).rejects.toMatchObject({
      code: "PERMISSION_PROFILE_NOT_GRANTED",
      requested: "workspace-write",
      allowedPermissionProfiles: ["read"],
    });
  });

  it("rejects an owner permission outside the configured set", async () => {
    const harness = await serviceFor([
      record({ allowedPermissionProfiles: ["read", "network-read"] }),
    ]);
    await mkdir(join(harness.root, "personal"));

    await expect(
      harness.service.authorizeExecutionCapability(actor, {
        workspaceBinding: "personal",
        permissionProfile: "approval-required",
      }),
    ).rejects.toMatchObject({
      code: "PERMISSION_PROFILE_NOT_GRANTED",
      requested: "approval-required",
      allowedPermissionProfiles: ["read", "network-read"],
    });
  });

  it("authorizes multiple non-hierarchical profiles without implying read", async () => {
    const harness = await serviceFor([
      record({
        allowedPermissionProfiles: ["workspace-write", "network-read"],
      }),
    ]);
    await mkdir(join(harness.root, "personal"));

    await expect(
      harness.service.authorizeExecutionCapability(actor, {
        workspaceBinding: "personal",
        permissionProfile: "workspace-write",
      }),
    ).resolves.toMatchObject({ permissionProfile: "workspace-write" });
    await expect(
      harness.service.authorizeExecutionCapability(actor, {
        workspaceBinding: "personal",
        permissionProfile: "network-read",
      }),
    ).resolves.toMatchObject({ permissionProfile: "network-read" });
    await expect(
      harness.service.authorizeExecutionCapability(actor, {
        workspaceBinding: "personal",
        permissionProfile: "read",
      }),
    ).rejects.toMatchObject({
      code: "PERMISSION_PROFILE_NOT_GRANTED",
      allowedPermissionProfiles: ["workspace-write", "network-read"],
    });
  });

  it("rejects a workspace binding that is not in the persisted set", async () => {
    const harness = await serviceFor([record()]);
    await mkdir(join(harness.root, "personal"));

    await expect(
      harness.service.authorizeExecutionCapability(actor, {
        workspaceBinding: "model-added",
        permissionProfile: "read",
      }),
    ).rejects.toMatchObject({ code: "EXECUTION_CAPABILITY_NOT_FOUND" });
  });

  it("rejects a missing workspace binding", async () => {
    const harness = await serviceFor([record()]);

    await expect(
      harness.service.authorizeExecutionCapability(actor, {
        workspaceBinding: "personal",
        permissionProfile: "read",
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_BINDING_MISSING" });
  });

  it("rejects a workspace binding that is not a directory", async () => {
    const harness = await serviceFor([record()]);
    await writeFile(join(harness.root, "personal"), "not a workspace", "utf8");

    await expect(
      harness.service.authorizeExecutionCapability(actor, {
        workspaceBinding: "personal",
        permissionProfile: "read",
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_BINDING_NOT_DIRECTORY" });
  });

  it("rejects realpath overlap between CODEX_HOME and the workspace root", async () => {
    const root = await temporaryDirectory("execution-capability-root-");
    const codexHome = join(root, "codex");
    await mkdir(codexHome);
    await mkdir(join(root, "personal"));
    const service = new ExecutionCapabilityService({
      repository: new FakeExecutionCapabilityRepository([record()]),
      workspaceRoot: root,
      codexHome,
    });

    await expect(
      service.authorizeExecutionCapability(actor, {
        workspaceBinding: "personal",
        permissionProfile: "read",
      }),
    ).rejects.toMatchObject({ code: "CODEX_HOME_OVERLAP" });
  });

  it("does not grant collaborator read when the binding omits read", async () => {
    const harness = await serviceFor([
      record({ allowedPermissionProfiles: ["workspace-write"] }),
    ]);
    await mkdir(join(harness.root, "personal"));

    await expect(
      harness.service.listAvailableCapabilities({
        ...actor,
        senderRole: "collaborator",
      }),
    ).resolves.toEqual([]);
  });
});
