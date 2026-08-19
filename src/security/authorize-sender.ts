/**
 * Deterministic sender authorization gates.
 *
 * The transport gate authorizes before persistence and queueing. The queued
 * work gate reauthorizes immediately before Codex or another child process
 * starts so revocation and rate-limit changes cannot be bypassed by old jobs.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";

import type { Database } from "../db/client.js";
import {
  channelIdentities,
  deployments,
  outboundBatches,
  outboundParts,
  owners,
} from "../db/schema.js";
import type {
  InboundTextForAuthorization,
  IngestDisposition,
} from "../transport/message-loop.js";
import type { OwnerRateLimitPolicy } from "./rate-limits.js";

export type SenderRole = "owner" | "collaborator";

export interface AuthorizationIdentity {
  deploymentId: string;
  ownerId: string;
  identityId: string;
  role: SenderRole;
  deploymentStatus: "active" | "disabled" | "maintenance";
  ownerStatus: "active" | "disabled";
  revokedAt: Date | null;
}

export interface AuthorizationDirectory {
  findByFingerprint(
    deploymentId: string,
    handleFingerprint: string,
  ): Promise<AuthorizationIdentity | undefined>;
  findById(
    deploymentId: string,
    identityId: string,
  ): Promise<AuthorizationIdentity | undefined>;
  /**
   * Optional for backward compatibility with existing directory adapters.
   * Queued authorization uses BatchedAuthorizationDirectory, where this
   * method is required, to reload every captured identity in one query.
   */
  findByIds?(
    deploymentId: string,
    ownerId: string,
    identityIds: readonly string[],
  ): Promise<readonly AuthorizationIdentity[]>;
}

export interface BatchedAuthorizationDirectory extends AuthorizationDirectory {
  findByIds(
    deploymentId: string,
    ownerId: string,
    identityIds: readonly string[],
  ): Promise<readonly AuthorizationIdentity[]>;
}

export class DatabaseAuthorizationDirectory
  implements BatchedAuthorizationDirectory
{
  public constructor(private readonly database: Database) {}

  public async findByFingerprint(
    deploymentId: string,
    handleFingerprint: string,
  ): Promise<AuthorizationIdentity | undefined> {
    return this.find(
      and(
        eq(channelIdentities.deploymentId, deploymentId),
        eq(channelIdentities.platform, "imessage"),
        eq(channelIdentities.handleFingerprint, handleFingerprint),
      ),
    );
  }

  public async findById(
    deploymentId: string,
    identityId: string,
  ): Promise<AuthorizationIdentity | undefined> {
    return this.find(
      and(
        eq(channelIdentities.deploymentId, deploymentId),
        eq(channelIdentities.id, identityId),
      ),
    );
  }

  public async findByIds(
    deploymentId: string,
    ownerId: string,
    identityIds: readonly string[],
  ): Promise<readonly AuthorizationIdentity[]> {
    const requestedIds = [...new Set(identityIds)];
    if (requestedIds.length === 0) {
      return [];
    }
    const rows = await this.database
      .select({
        deploymentId: channelIdentities.deploymentId,
        ownerId: channelIdentities.ownerId,
        identityId: channelIdentities.id,
        role: channelIdentities.role,
        deploymentStatus: deployments.status,
        ownerStatus: owners.status,
        revokedAt: channelIdentities.revokedAt,
      })
      .from(channelIdentities)
      .innerJoin(
        owners,
        and(
          eq(channelIdentities.ownerId, owners.id),
          eq(channelIdentities.deploymentId, owners.deploymentId),
        ),
      )
      .innerJoin(
        deployments,
        eq(channelIdentities.deploymentId, deployments.id),
      )
      .where(
        and(
          eq(channelIdentities.deploymentId, deploymentId),
          eq(channelIdentities.ownerId, ownerId),
          inArray(channelIdentities.id, requestedIds),
        ),
      );
    const byId = new Map(rows.map((row) => [row.identityId, row]));
    return requestedIds.flatMap((identityId) => {
      const row = byId.get(identityId);
      return row === undefined ? [] : [row];
    });
  }

  private async find(
    condition: ReturnType<typeof and>,
  ): Promise<AuthorizationIdentity | undefined> {
    const [row] = await this.database
      .select({
        deploymentId: channelIdentities.deploymentId,
        ownerId: channelIdentities.ownerId,
        identityId: channelIdentities.id,
        role: channelIdentities.role,
        deploymentStatus: deployments.status,
        ownerStatus: owners.status,
        revokedAt: channelIdentities.revokedAt,
      })
      .from(channelIdentities)
      .innerJoin(
        owners,
        and(
          eq(channelIdentities.ownerId, owners.id),
          eq(channelIdentities.deploymentId, owners.deploymentId),
        ),
      )
      .innerJoin(
        deployments,
        eq(channelIdentities.deploymentId, deployments.id),
      )
      .where(condition)
      .limit(1);
    return row;
  }
}

export type SenderAuthorizationRejection =
  | "unknown-sender"
  | "identity-revoked"
  | "owner-disabled"
  | "deployment-unavailable"
  | "group-disabled"
  | "group-mention-or-reply-required"
  | "message-rate-limited";

export interface AuthorizedSenderContext {
  deploymentId: string;
  ownerId: string;
  identityId: string;
  role: SenderRole;
  handleFingerprint: string;
  canApprove: boolean;
  canPair: boolean;
}

export type SenderAuthorizationResult =
  | { authorized: true; context: AuthorizedSenderContext }
  | { authorized: false; reason: SenderAuthorizationRejection };

export interface GroupPolicy {
  mode: "disabled" | "owner_mentions_only";
  /** Dedicated-line address(es) surfaced by native iMessage mentions. */
  agentHandles: readonly string[];
  /** Optional textual @names used only when the provider has no native mention. */
  agentMentionNames?: readonly string[];
}

export interface GroupReplyVerifier {
  isReplyToPersistedAgentMessage(
    inbound: InboundTextForAuthorization,
    targetExternalMessageId: string,
  ): Promise<boolean>;
}

export interface InternalSpaceLookup {
  findInternalSpaceId(
    deploymentId: string,
    inbound: InboundTextForAuthorization,
  ): Promise<string | undefined>;
}

/** Validates replies against a sent outbound row, not provider-supplied direction. */
export class DatabaseGroupReplyVerifier implements GroupReplyVerifier {
  public constructor(
    private readonly database: Database,
    private readonly spaces: InternalSpaceLookup,
    private readonly deploymentId: string,
  ) {}

  public async isReplyToPersistedAgentMessage(
    inbound: InboundTextForAuthorization,
    targetExternalMessageId: string,
  ): Promise<boolean> {
    if (
      inbound.space.spaceType !== "group" ||
      targetExternalMessageId.trim().length === 0
    ) {
      return false;
    }
    const spaceId = await this.spaces.findInternalSpaceId(
      this.deploymentId,
      inbound,
    );
    if (spaceId === undefined) {
      return false;
    }
    const [row] = await this.database
      .select({ id: outboundParts.id })
      .from(outboundParts)
      .innerJoin(outboundBatches, eq(outboundParts.batchId, outboundBatches.id))
      .where(
        and(
          eq(outboundBatches.spaceId, spaceId),
          eq(outboundParts.externalMessageId, targetExternalMessageId),
          eq(outboundParts.state, "sent"),
        ),
      )
      .limit(1);
    return row !== undefined;
  }
}

export interface UnknownSenderPairing {
  tryPair(
    inbound: InboundTextForAuthorization,
    handleFingerprint: string,
  ): Promise<boolean>;
}

export interface AuthorizedInboundConsumer {
  ingestAuthorized(
    inbound: InboundTextForAuthorization,
    sender: AuthorizedSenderContext,
    context: { signal?: AbortSignal },
  ): Promise<Exclude<IngestDisposition, "unauthorized">>;
}

export interface AuthorizedCommandInterceptor {
  /** Returns true when deterministic code handled the message completely. */
  interceptAuthorized(
    inbound: InboundTextForAuthorization,
    sender: AuthorizedSenderContext,
    context: { signal?: AbortSignal },
  ): Promise<boolean>;
}

export interface DeterministicSenderAuthorizerOptions {
  deploymentId: string;
  fingerprintKey: string | Uint8Array;
  directory: AuthorizationDirectory;
  groupPolicy: GroupPolicy;
  replyVerifier?: GroupReplyVerifier;
  pairing?: UnknownSenderPairing;
  rateLimits?: Pick<OwnerRateLimitPolicy, "consumeMessage">;
  now?: () => Date;
}

function fingerprintKeyBytes(key: string | Uint8Array): Uint8Array {
  const bytes = typeof key === "string" ? Buffer.from(key, "utf8") : key;
  if (bytes.byteLength < 32) {
    throw new Error(
      "Sender fingerprint key must contain at least 32 bytes of deployment-scoped secret material.",
    );
  }
  return bytes;
}

export function fingerprintSenderHandle(
  deploymentId: string,
  normalizedHandle: string,
  key: string | Uint8Array,
): string {
  return createHmac("sha256", fingerprintKeyBytes(key))
    .update("imessage-agent-sender-v1\0", "utf8")
    .update(deploymentId, "utf8")
    .update("\0imessage\0", "utf8")
    .update(normalizedHandle, "utf8")
    .digest("hex");
}

export function fingerprintsEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function activeContext(
  identity: AuthorizationIdentity | undefined,
  handleFingerprint: string,
): SenderAuthorizationResult {
  if (identity === undefined) {
    return { authorized: false, reason: "unknown-sender" };
  }
  if (identity.revokedAt !== null) {
    return { authorized: false, reason: "identity-revoked" };
  }
  if (identity.ownerStatus !== "active") {
    return { authorized: false, reason: "owner-disabled" };
  }
  if (identity.deploymentStatus !== "active") {
    return { authorized: false, reason: "deployment-unavailable" };
  }
  return {
    authorized: true,
    context: {
      deploymentId: identity.deploymentId,
      ownerId: identity.ownerId,
      identityId: identity.identityId,
      role: identity.role,
      handleFingerprint,
      canApprove: identity.role === "owner",
      canPair: identity.role === "owner",
    },
  };
}

function normalizedMention(value: string): string {
  return value
    .trim()
    .replace(/^mailto:/iu, "")
    .replace(/^tel:/iu, "")
    .replace(/[\s().-]/gu, "")
    .toLowerCase();
}

function escapedRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function hasTextMention(text: string, names: readonly string[]): boolean {
  return names.some((name) => {
    const normalized = name.trim().replace(/^@/u, "");
    return (
      normalized.length > 0 &&
      new RegExp(`(?:^|\\s)@${escapedRegex(normalized)}(?:\\b|$)`, "iu").test(
        text,
      )
    );
  });
}

export class DeterministicSenderAuthorizer {
  private readonly fingerprintKey: Uint8Array;

  public constructor(private readonly options: DeterministicSenderAuthorizerOptions) {
    this.fingerprintKey = fingerprintKeyBytes(options.fingerprintKey);
  }

  public async authorize(
    inbound: InboundTextForAuthorization,
  ): Promise<SenderAuthorizationResult> {
    const handleFingerprint = fingerprintSenderHandle(
      this.options.deploymentId,
      inbound.sender.address,
      this.fingerprintKey,
    );
    let identity = await this.options.directory.findByFingerprint(
      this.options.deploymentId,
      handleFingerprint,
    );
    if (identity === undefined && this.options.pairing !== undefined) {
      const paired = await this.options.pairing.tryPair(
        inbound,
        handleFingerprint,
      );
      if (paired) {
        identity = await this.options.directory.findByFingerprint(
          this.options.deploymentId,
          handleFingerprint,
        );
      }
    }

    const active = activeContext(identity, handleFingerprint);
    if (!active.authorized) {
      return active;
    }
    if (inbound.space.spaceType === "group") {
      const groupAllowed = await this.groupAllows(inbound);
      if (!groupAllowed) {
        return {
          authorized: false,
          reason:
            this.options.groupPolicy.mode === "disabled"
              ? "group-disabled"
              : "group-mention-or-reply-required",
        };
      }
    }

    const rateLimit = this.options.rateLimits?.consumeMessage(
      active.context.ownerId,
      this.options.now?.() ?? new Date(),
    );
    if (rateLimit?.allowed === false) {
      return { authorized: false, reason: "message-rate-limited" };
    }
    return active;
  }

  /** Re-checks queued authority immediately before any model/process start. */
  public async reauthorize(
    context: AuthorizedSenderContext,
  ): Promise<SenderAuthorizationResult> {
    const identity = await this.options.directory.findById(
      context.deploymentId,
      context.identityId,
    );
    return activeContext(identity, context.handleFingerprint);
  }

  private async groupAllows(
    inbound: InboundTextForAuthorization,
  ): Promise<boolean> {
    if (this.options.groupPolicy.mode === "disabled") {
      return false;
    }

    const configuredHandles = new Set(
      this.options.groupPolicy.agentHandles.map(normalizedMention),
    );
    const nativeMention = inbound.mentionedAddresses.some((address) =>
      configuredHandles.has(normalizedMention(address)),
    );
    const textualMention =
      inbound.mentionedAddresses.length === 0 &&
      hasTextMention(
        inbound.text,
        this.options.groupPolicy.agentMentionNames ?? [],
      );
    if (nativeMention || textualMention) {
      return true;
    }

    return (
      inbound.replyToExternalMessageId !== undefined &&
      this.options.replyVerifier !== undefined &&
      (await this.options.replyVerifier.isReplyToPersistedAgentMessage(
        inbound,
        inbound.replyToExternalMessageId,
      ))
    );
  }
}

/** Concrete transport boundary: rejected senders never reach persistence/queue/model. */
export class SecureAuthorizeAndIngest {
  public constructor(
    private readonly authorizer: DeterministicSenderAuthorizer,
    private readonly consumer: AuthorizedInboundConsumer,
    private readonly commands?: AuthorizedCommandInterceptor,
  ) {}

  public async authorizeAndIngest(
    inbound: InboundTextForAuthorization,
    context: {
      signal?: AbortSignal;
      onHandledWithoutAgentPresence?: () => void;
    },
  ): Promise<IngestDisposition> {
    const authorization = await this.authorizer.authorize(inbound);
    if (!authorization.authorized) {
      return "unauthorized";
    }
    const downstreamContext =
      context.signal === undefined ? {} : { signal: context.signal };
    if (
      this.commands !== undefined &&
      (await this.commands.interceptAuthorized(
        inbound,
        authorization.context,
        downstreamContext,
      ))
    ) {
      context.onHandledWithoutAgentPresence?.();
      return "accepted";
    }
    return this.consumer.ingestAuthorized(
      inbound,
      authorization.context,
      downstreamContext,
    );
  }
}

export type SecureProcessStartResult<Value> =
  | { started: true; value: Value; context: AuthorizedSenderContext }
  | {
      started: false;
      reason: SenderAuthorizationRejection | "task-rate-limited";
    };

/** Final queued-work gate: revocation and task limits are checked before spawn. */
export class SecureCodexStartGate {
  public constructor(
    private readonly authorizer: DeterministicSenderAuthorizer,
    private readonly rateLimits?: Pick<OwnerRateLimitPolicy, "consumeTask">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async start<Value>(
    acceptedContext: AuthorizedSenderContext,
    spawnCodex: (context: AuthorizedSenderContext) => Promise<Value>,
  ): Promise<SecureProcessStartResult<Value>> {
    const live = await this.authorizer.reauthorize(acceptedContext);
    if (!live.authorized) {
      return { started: false, reason: live.reason };
    }
    const rateLimit = this.rateLimits?.consumeTask(
      live.context.ownerId,
      this.now(),
    );
    if (rateLimit?.allowed === false) {
      return { started: false, reason: "task-rate-limited" };
    }
    return {
      started: true,
      value: await spawnCodex(live.context),
      context: live.context,
    };
  }
}
