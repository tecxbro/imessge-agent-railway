import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import type {
  CodexRunRequest,
  CodexRunResult,
  StructuredCodexRunner,
} from "../../src/agent/codex-client.js";
import type {
  AuthorizationIdentity,
  BatchedAuthorizationDirectory,
} from "../../src/security/authorize-sender.js";
import {
  CodexStartDeniedError,
  type QueuedAuthorizationReference,
  type QueuedAuthorizationReferenceStore,
  QueuedCodexStartGate,
} from "../../src/security/queued-authorization.js";
import { SecureStructuredCodexRunner } from "../../src/security/secure-codex-runner.js";

const deploymentId = "30000000-0000-4000-8000-000000000001";
const ownerId = "30000000-0000-4000-8000-000000000002";
const chainId = "30000000-0000-4000-8000-000000000003";
const principalIdentityId = "30000000-0000-4000-8000-000000000004";
const contributorIdentityId = "30000000-0000-4000-8000-000000000005";

const outputSchema = z.object({ accepted: z.literal(true) }).strict();
const request: CodexRunRequest<{ accepted: true }> = {
  prompt: "bounded queued task",
  outputSchema,
  modelProfile: { model: "gpt-5.6-luna", effort: "high" },
  permissionProfile: "read",
  workingDirectory: "/tmp",
  skipGitRepoCheck: true,
};

const reference: QueuedAuthorizationReference = {
  deploymentId,
  ownerId,
  chainId,
  principalIdentityId,
  contributorIdentityIds: [contributorIdentityId],
};

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

class MutableBatchedDirectory implements BatchedAuthorizationDirectory {
  public readonly identities = new Map<string, AuthorizationIdentity>([
    [principalIdentityId, identity(principalIdentityId, "owner")],
    [
      contributorIdentityId,
      identity(contributorIdentityId, "collaborator"),
    ],
  ]);
  public readonly reloads = vi.fn();

  public async findByFingerprint(): Promise<undefined> {
    return undefined;
  }

  public async findById(
    _deploymentId: string,
    identityId: string,
  ): Promise<AuthorizationIdentity | undefined> {
    return this.identities.get(identityId);
  }

  public async findByIds(
    requestedDeploymentId: string,
    requestedOwnerId: string,
    identityIds: readonly string[],
  ): Promise<readonly AuthorizationIdentity[]> {
    this.reloads(requestedDeploymentId, requestedOwnerId, identityIds);
    return identityIds.flatMap((identityId) => {
      const current = this.identities.get(identityId);
      return current === undefined ? [] : [structuredClone(current)];
    });
  }
}

class MutableReferenceStore implements QueuedAuthorizationReferenceStore {
  public current: QueuedAuthorizationReference | undefined = structuredClone(reference);
  public readonly loads = vi.fn();

  public async load(requestedChainId: string) {
    this.loads(requestedChainId);
    return this.current === undefined
      ? undefined
      : structuredClone(this.current);
  }
}

class RecordingRunner implements StructuredCodexRunner {
  public readonly calls = vi.fn();

  public async runStructured<Output>(
    requested: CodexRunRequest<Output>,
  ): Promise<CodexRunResult<Output>> {
    this.calls(requested);
    return {
      threadId: "thread-1",
      output: requested.outputSchema.parse({ accepted: true }),
      usage: null,
    };
  }
}

function secureRunner(
  directory = new MutableBatchedDirectory(),
  store = new MutableReferenceStore(),
  delegate = new RecordingRunner(),
  rateLimits?: ConstructorParameters<typeof QueuedCodexStartGate>[1],
) {
  const gate = new QueuedCodexStartGate(directory, rateLimits);
  const runner = new SecureStructuredCodexRunner({
    chainId,
    authorizationReferences: store,
    startGate: gate,
    delegate,
  });
  const structuredRunnerContract: StructuredCodexRunner = runner;
  return {
    directory,
    store,
    delegate,
    runner: structuredRunnerContract,
  };
}

describe("secure structured Codex runner", () => {
  it("makes no child call after live principal revocation", async () => {
    const fixture = secureRunner();

    await expect(fixture.runner.runStructured(request)).resolves.toMatchObject({
      threadId: "thread-1",
    });
    fixture.directory.identities.set(
      principalIdentityId,
      identity(principalIdentityId, "owner", { revokedAt: new Date() }),
    );

    await expect(fixture.runner.runStructured(request)).rejects.toMatchObject({
      code: "CODEX_START_IDENTITY_REVOKED",
      retryable: false,
    });
    expect(fixture.delegate.calls).toHaveBeenCalledTimes(1);
    expect(fixture.store.loads).toHaveBeenCalledTimes(2);
    expect(fixture.directory.reloads).toHaveBeenCalledTimes(2);
  });

  it("blocks the entire chain when one contributor is revoked", async () => {
    const fixture = secureRunner();
    fixture.directory.identities.set(
      contributorIdentityId,
      identity(contributorIdentityId, "collaborator", {
        revokedAt: new Date("2026-08-18T00:00:00Z"),
      }),
    );

    await expect(fixture.runner.runStructured(request)).rejects.toMatchObject({
      code: "CODEX_START_IDENTITY_REVOKED",
      retryable: false,
    });
    expect(fixture.delegate.calls).not.toHaveBeenCalled();
  });

  it("consumes the task-start rate limit before allowing the child", async () => {
    const consumeTask = vi.fn(() => ({
      allowed: false,
      remaining: 0,
      retryAfterMs: 30_000,
    }));
    const fixture = secureRunner(
      new MutableBatchedDirectory(),
      new MutableReferenceStore(),
      new RecordingRunner(),
      { consumeTask },
    );

    await expect(fixture.runner.runStructured(request)).rejects.toMatchObject({
      code: "CODEX_START_TASK_RATE_LIMITED",
      retryable: false,
    });
    expect(consumeTask).toHaveBeenCalledOnce();
    expect(consumeTask).toHaveBeenCalledWith(ownerId, expect.any(Date));
    expect(fixture.delegate.calls).not.toHaveBeenCalled();
  });

  it("reloads the reference and live identity set on every invocation", async () => {
    const fixture = secureRunner();

    await fixture.runner.runStructured(request);
    await fixture.runner.runStructured(request);

    expect(fixture.store.loads).toHaveBeenNthCalledWith(1, chainId);
    expect(fixture.store.loads).toHaveBeenNthCalledWith(2, chainId);
    expect(fixture.directory.reloads).toHaveBeenCalledTimes(2);
    expect(fixture.delegate.calls).toHaveBeenCalledTimes(2);
  });

  it("uses typed non-retryable denials for invalid queued references", async () => {
    const store = new MutableReferenceStore();
    store.current = undefined;
    const fixture = secureRunner(
      new MutableBatchedDirectory(),
      store,
      new RecordingRunner(),
    );

    const denial = await fixture.runner.runStructured(request).catch(
      (error: unknown) => error,
    );
    expect(denial).toBeInstanceOf(CodexStartDeniedError);
    expect(denial).toMatchObject({
      code: "CODEX_START_AUTHORIZATION_INVALID",
      retryable: false,
      name: "CodexStartDeniedError",
    });
    expect(fixture.delegate.calls).not.toHaveBeenCalled();
  });

  it("treats a missing captured contributor as stale authorization", async () => {
    const fixture = secureRunner();
    fixture.directory.identities.delete(contributorIdentityId);

    await expect(fixture.runner.runStructured(request)).rejects.toMatchObject({
      code: "CODEX_START_AUTHORIZATION_INVALID",
      retryable: false,
    });
    expect(fixture.delegate.calls).not.toHaveBeenCalled();
  });

  it.each([
    [
      "disabled owner",
      { ownerStatus: "disabled" as const },
      "CODEX_START_OWNER_DISABLED",
    ],
    [
      "maintenance deployment",
      { deploymentStatus: "maintenance" as const },
      "CODEX_START_DEPLOYMENT_UNAVAILABLE",
    ],
  ])("maps %s to a safe non-retryable denial", async (_label, state, code) => {
    const directory = new MutableBatchedDirectory();
    directory.identities.set(
      principalIdentityId,
      identity(principalIdentityId, "owner", state),
    );
    const fixture = secureRunner(directory);

    await expect(fixture.runner.runStructured(request)).rejects.toMatchObject({
      code,
      retryable: false,
    });
    expect(fixture.delegate.calls).not.toHaveBeenCalled();
  });
});
