import type { BatchedAuthorizationDirectory } from "./authorize-sender.js";
import type { OwnerRateLimitPolicy } from "./rate-limits.js";

export interface QueuedAuthorizationReference {
  deploymentId: string;
  ownerId: string;
  chainId: string;
  principalIdentityId: string;
  contributorIdentityIds: readonly string[];
}

export interface QueuedAuthorizationReferenceStore {
  load(chainId: string): Promise<QueuedAuthorizationReference | undefined>;
}

export type CodexStartDeniedCode =
  | "CODEX_START_IDENTITY_REVOKED"
  | "CODEX_START_OWNER_DISABLED"
  | "CODEX_START_DEPLOYMENT_UNAVAILABLE"
  | "CODEX_START_TASK_RATE_LIMITED"
  | "CODEX_START_AUTHORIZATION_INVALID";

const SAFE_DENIAL_MESSAGES: Readonly<Record<CodexStartDeniedCode, string>> = {
  CODEX_START_IDENTITY_REVOKED:
    "Codex start denied because a captured identity is no longer authorized.",
  CODEX_START_OWNER_DISABLED:
    "Codex start denied because the owner is disabled.",
  CODEX_START_DEPLOYMENT_UNAVAILABLE:
    "Codex start denied because the deployment is unavailable.",
  CODEX_START_TASK_RATE_LIMITED:
    "Codex start denied by the task rate limit.",
  CODEX_START_AUTHORIZATION_INVALID:
    "Codex start denied because the queued authorization reference is invalid.",
};

export class CodexStartDeniedError extends Error {
  public readonly retryable = false as const;

  public constructor(public readonly code: CodexStartDeniedCode) {
    super(SAFE_DENIAL_MESSAGES[code]);
    this.name = "CodexStartDeniedError";
  }
}

function isBoundedIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= 512 && value.trim() === value;
}

export function isQueuedAuthorizationReferenceValid(
  reference: QueuedAuthorizationReference,
): boolean {
  const contributors = reference.contributorIdentityIds;
  const uniqueContributors = new Set(contributors);
  return (
    isBoundedIdentifier(reference.deploymentId) &&
    isBoundedIdentifier(reference.ownerId) &&
    isBoundedIdentifier(reference.chainId) &&
    isBoundedIdentifier(reference.principalIdentityId) &&
    contributors.length <= 256 &&
    contributors.every(isBoundedIdentifier) &&
    uniqueContributors.size === contributors.length &&
    !uniqueContributors.has(reference.principalIdentityId)
  );
}

/**
 * Reference-based queued-work gate. Every start reloads the complete captured
 * identity set through one directory call and consumes the task-start limit
 * only after all live authorization checks pass.
 */
export class QueuedCodexStartGate {
  public constructor(
    private readonly directory: BatchedAuthorizationDirectory,
    private readonly rateLimits?: Pick<OwnerRateLimitPolicy, "consumeTask">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async start<Value>(
    reference: QueuedAuthorizationReference,
    startCodex: () => Promise<Value>,
  ): Promise<Value> {
    if (!isQueuedAuthorizationReferenceValid(reference)) {
      throw new CodexStartDeniedError("CODEX_START_AUTHORIZATION_INVALID");
    }

    const expectedIds = [
      reference.principalIdentityId,
      ...reference.contributorIdentityIds,
    ];
    const identities = await this.directory.findByIds(
      reference.deploymentId,
      reference.ownerId,
      expectedIds,
    );
    const byId = new Map(
      identities.map((identity) => [identity.identityId, identity]),
    );
    if (
      byId.size !== expectedIds.length ||
      expectedIds.some((identityId) => !byId.has(identityId)) ||
      identities.some(
        (identity) =>
          identity.deploymentId !== reference.deploymentId ||
          identity.ownerId !== reference.ownerId,
      )
    ) {
      throw new CodexStartDeniedError("CODEX_START_AUTHORIZATION_INVALID");
    }
    if (identities.some((identity) => identity.revokedAt !== null)) {
      throw new CodexStartDeniedError("CODEX_START_IDENTITY_REVOKED");
    }
    if (identities.some((identity) => identity.ownerStatus !== "active")) {
      throw new CodexStartDeniedError("CODEX_START_OWNER_DISABLED");
    }
    if (identities.some((identity) => identity.deploymentStatus !== "active")) {
      throw new CodexStartDeniedError("CODEX_START_DEPLOYMENT_UNAVAILABLE");
    }

    const taskLimit = this.rateLimits?.consumeTask(
      reference.ownerId,
      this.now(),
    );
    if (taskLimit?.allowed === false) {
      throw new CodexStartDeniedError("CODEX_START_TASK_RATE_LIMITED");
    }
    return await startCodex();
  }
}
