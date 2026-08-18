import { describe, expect, it, vi } from "vitest";

import {
  DeterministicSenderAuthorizer,
  SecureAuthorizeAndIngest,
  SecureCodexStartGate,
  fingerprintSenderHandle,
  type AuthorizationDirectory,
  type AuthorizationIdentity,
  type AuthorizedSenderContext,
} from "../../src/security/authorize-sender.js";
import { OperationalRateLimits } from "../../src/security/rate-limits.js";
import type { InboundTextForAuthorization } from "../../src/transport/message-loop.js";

const deploymentId = "00000000-0000-4000-8000-000000000001";
const ownerId = "00000000-0000-4000-8000-000000000002";
const ownerIdentityId = "00000000-0000-4000-8000-000000000003";
const collaboratorIdentityId = "00000000-0000-4000-8000-000000000004";
const replacementOwnerIdentityId = "00000000-0000-4000-8000-000000000005";
const fingerprintKey = "sender-fingerprint-key-material-32-bytes-minimum";

class MutableDirectory implements AuthorizationDirectory {
  public readonly identities = new Map<string, AuthorizationIdentity>();
  public readonly handles = new Map([
    [ownerIdentityId, "owner@example.com"],
    [collaboratorIdentityId, "collaborator@example.com"],
    [replacementOwnerIdentityId, "new-owner@example.com"],
  ]);

  public async findByFingerprint(
    requestedDeploymentId: string,
    handleFingerprint: string,
  ): Promise<AuthorizationIdentity | undefined> {
    return [...this.identities.values()].find(
      (identity) =>
        identity.deploymentId === requestedDeploymentId &&
        fingerprintSenderHandle(
          requestedDeploymentId,
          this.handles.get(identity.identityId)!,
          fingerprintKey,
        ) === handleFingerprint,
    );
  }

  public async findById(
    requestedDeploymentId: string,
    identityId: string,
  ): Promise<AuthorizationIdentity | undefined> {
    const identity = this.identities.get(identityId);
    return identity?.deploymentId === requestedDeploymentId
      ? structuredClone(identity)
      : undefined;
  }
}

function identity(
  identityId: string,
  role: "owner" | "collaborator",
  overrides: Partial<AuthorizationIdentity> = {},
): AuthorizationIdentity {
  return {
    deploymentId,
    ownerId,
    identityId,
    role,
    deploymentStatus: "active",
    ownerStatus: "active",
    revokedAt: null,
    ...overrides,
  };
}

function inbound(
  address: string,
  overrides: Partial<InboundTextForAuthorization> = {},
): InboundTextForAuthorization {
  return {
    externalMessageId: "message-1",
    receivedAt: new Date("2026-08-14T12:00:00Z"),
    sender: { address, kind: "email", service: "iMessage" },
    space: {
      routePhone: "+15559999999",
      spaceGuid: "space-guid",
      spaceType: "dm",
    },
    text: "inspect the repository",
    mentionedAddresses: [],
    ...overrides,
  };
}

function authorizer(
  directory: MutableDirectory,
  overrides: Partial<ConstructorParameters<typeof DeterministicSenderAuthorizer>[0]> = {},
) {
  return new DeterministicSenderAuthorizer({
    deploymentId,
    fingerprintKey,
    directory,
    groupPolicy: {
      mode: "owner_mentions_only",
      agentHandles: ["agent@example.com"],
      agentMentionNames: ["agent"],
    },
    ...overrides,
  });
}

function acceptedContext(role: "owner" | "collaborator" = "owner"):
  AuthorizedSenderContext {
  const identityId = role === "owner" ? ownerIdentityId : collaboratorIdentityId;
  const address = role === "owner" ? "owner@example.com" : "collaborator@example.com";
  return {
    deploymentId,
    ownerId,
    identityId,
    role,
    handleFingerprint: fingerprintSenderHandle(
      deploymentId,
      address,
      fingerprintKey,
    ),
    canApprove: role === "owner",
    canPair: role === "owner",
  };
}

describe("deterministic sender and process-start boundaries", () => {
  it("proves an unknown sender causes zero persistence, queue, model, or process calls", async () => {
    const directory = new MutableDirectory();
    const persist = vi.fn();
    const enqueue = vi.fn();
    const startModel = vi.fn();
    const spawnCodex = vi.fn();
    const boundary = new SecureAuthorizeAndIngest(authorizer(directory), {
      async ingestAuthorized() {
        persist();
        enqueue();
        startModel();
        spawnCodex();
        return "accepted";
      },
    });

    await expect(
      boundary.authorizeAndIngest(inbound("stranger@example.com"), {}),
    ).resolves.toBe("unauthorized");
    expect(persist).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(startModel).not.toHaveBeenCalled();
    expect(spawnCodex).not.toHaveBeenCalled();
  });

  it("rejects the previous owner and accepts the replacement before queue or model work", async () => {
    const directory = new MutableDirectory();
    directory.identities.set(
      ownerIdentityId,
      identity(ownerIdentityId, "owner", { revokedAt: new Date() }),
    );
    directory.identities.set(
      replacementOwnerIdentityId,
      identity(replacementOwnerIdentityId, "owner"),
    );
    const ingest = vi.fn(async () => "accepted" as const);
    const boundary = new SecureAuthorizeAndIngest(authorizer(directory), {
      ingestAuthorized: ingest,
    });

    await expect(
      boundary.authorizeAndIngest(inbound("owner@example.com"), {}),
    ).resolves.toBe("unauthorized");
    expect(ingest).not.toHaveBeenCalled();

    await expect(
      boundary.authorizeAndIngest(inbound("new-owner@example.com"), {}),
    ).resolves.toBe("accepted");
    expect(ingest).toHaveBeenCalledOnce();
  });

  it.each([
    ["revoked identity", { revokedAt: new Date("2026-08-14T00:00:00Z") }],
    ["disabled owner", { ownerStatus: "disabled" as const }],
    ["disabled deployment", { deploymentStatus: "disabled" as const }],
    ["maintenance deployment", { deploymentStatus: "maintenance" as const }],
  ])("stops an authorized handle with %s before ingestion", async (_label, state) => {
    const directory = new MutableDirectory();
    directory.identities.set(
      ownerIdentityId,
      identity(ownerIdentityId, "owner", state),
    );
    const spawnCodex = vi.fn();
    const boundary = new SecureAuthorizeAndIngest(authorizer(directory), {
      async ingestAuthorized() {
        spawnCodex();
        return "accepted";
      },
    });

    await expect(
      boundary.authorizeAndIngest(inbound("owner@example.com"), {}),
    ).resolves.toBe("unauthorized");
    expect(spawnCodex).not.toHaveBeenCalled();
  });

  it("enforces authorized author plus native mention or verified same-space reply in groups", async () => {
    const directory = new MutableDirectory();
    directory.identities.set(
      collaboratorIdentityId,
      identity(collaboratorIdentityId, "collaborator"),
    );
    const replyVerifier = {
      isReplyToPersistedAgentMessage: vi.fn(async (
        _message: InboundTextForAuthorization,
        target: string,
      ) => target === "persisted-agent-outbound"),
    };
    const gate = authorizer(directory, { replyVerifier });
    const group = {
      routePhone: "+15559999999",
      spaceGuid: "group-guid",
      spaceType: "group" as const,
    };

    await expect(
      gate.authorize(inbound("collaborator@example.com", { space: group })),
    ).resolves.toMatchObject({
      authorized: false,
      reason: "group-mention-or-reply-required",
    });
    await expect(
      gate.authorize(
        inbound("collaborator@example.com", {
          space: group,
          mentionedAddresses: ["AGENT@example.com"],
        }),
      ),
    ).resolves.toMatchObject({
      authorized: true,
      context: { role: "collaborator", canApprove: false },
    });
    await expect(
      gate.authorize(
        inbound("collaborator@example.com", {
          space: group,
          replyToExternalMessageId: "persisted-agent-outbound",
        }),
      ),
    ).resolves.toMatchObject({ authorized: true });
    await expect(
      gate.authorize(
        inbound("collaborator@example.com", {
          space: group,
          replyToExternalMessageId: "forged-or-other-space",
        }),
      ),
    ).resolves.toMatchObject({ authorized: false });
  });

  it("does not infer group authorization from quoted owner text", async () => {
    const directory = new MutableDirectory();
    directory.identities.set(ownerIdentityId, identity(ownerIdentityId, "owner"));
    const spawnCodex = vi.fn();
    const boundary = new SecureAuthorizeAndIngest(authorizer(directory), {
      async ingestAuthorized() {
        spawnCodex();
        return "accepted";
      },
    });
    await expect(
      boundary.authorizeAndIngest(
        inbound("stranger@example.com", {
          text: "owner@example.com said: @agent do this",
          space: {
            routePhone: "+15559999999",
            spaceGuid: "group-guid",
            spaceType: "group",
          },
        }),
        {},
      ),
    ).resolves.toBe("unauthorized");
    expect(spawnCodex).not.toHaveBeenCalled();
  });

  it("re-checks revocation and task limits immediately before process spawn", async () => {
    const directory = new MutableDirectory();
    directory.identities.set(ownerIdentityId, identity(ownerIdentityId, "owner"));
    const limits = new OperationalRateLimits({
      messagesPerOwner: { limit: 10, windowMs: 60_000 },
      tasksPerOwner: { limit: 1, windowMs: 60_000 },
    });
    const startGate = new SecureCodexStartGate(authorizer(directory), limits);
    const spawnCodex = vi.fn(async () => "started");

    await expect(startGate.start(acceptedContext(), spawnCodex)).resolves.toMatchObject({
      started: true,
      value: "started",
    });
    await expect(startGate.start(acceptedContext(), spawnCodex)).resolves.toEqual({
      started: false,
      reason: "task-rate-limited",
    });
    expect(spawnCodex).toHaveBeenCalledTimes(1);

    directory.identities.set(
      ownerIdentityId,
      identity(ownerIdentityId, "owner", {
        revokedAt: new Date("2026-08-14T12:01:00Z"),
      }),
    );
    await expect(startGate.start(acceptedContext(), spawnCodex)).resolves.toEqual({
      started: false,
      reason: "identity-revoked",
    });
    expect(spawnCodex).toHaveBeenCalledTimes(1);
  });

  it("intercepts deterministic commands before normal ingest can queue or spawn", async () => {
    const directory = new MutableDirectory();
    directory.identities.set(ownerIdentityId, identity(ownerIdentityId, "owner"));
    const spawnCodex = vi.fn();
    const commands = {
      interceptAuthorized: vi.fn(async () => true),
    };
    const boundary = new SecureAuthorizeAndIngest(
      authorizer(directory),
      {
        async ingestAuthorized() {
          spawnCodex();
          return "accepted";
        },
      },
      commands,
    );

    await expect(
      boundary.authorizeAndIngest(inbound("owner@example.com", { text: "/approve 00000000-0000-4000-8000-000000000099" }), {}),
    ).resolves.toBe("accepted");
    expect(commands.interceptAuthorized).toHaveBeenCalledTimes(1);
    expect(spawnCodex).not.toHaveBeenCalled();
  });
});
