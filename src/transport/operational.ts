import { createHmac } from "node:crypto";

import { text, type Message, type Space } from "spectrum-ts";

import type { OperationalRepository } from "../db/repositories/operational.js";
import type { DataCipher } from "../security/data-cipher.js";
import type {
  AuthorizedInboundConsumer,
  AuthorizedSenderContext,
} from "../security/authorize-sender.js";
import type { OutboundTransport } from "../queue/handlers/outbound-send.js";
import type { DurablePipeline } from "../queue/pipeline.js";
import type { InboundTextForAuthorization } from "./message-loop.js";
import type { SpaceResolver } from "./space-resolver.js";
import type { ConversationPresencePort } from "./conversation-presence.js";

export interface DurableInboundConsumerOptions {
  operational: OperationalRepository;
  pipeline: Pick<DurablePipeline, "ingestAndSchedule">;
  cipher: DataCipher;
  contentHashKey: string;
  rawMessageRetentionDays: number;
  onSpacePersisted?: (
    spaceId: string,
    route: InboundTextForAuthorization["space"],
  ) => void;
}

function retentionExpiry(receivedAt: Date, days: number): Date {
  return new Date(receivedAt.getTime() + days * 24 * 60 * 60 * 1_000);
}

export class DurableInboundConsumer implements AuthorizedInboundConsumer {
  public constructor(private readonly options: DurableInboundConsumerOptions) {}

  public async ingestAuthorized(
    inbound: InboundTextForAuthorization,
    sender: AuthorizedSenderContext,
    context: { signal?: AbortSignal },
  ): Promise<"accepted" | "duplicate"> {
    context.signal?.throwIfAborted();
    const spaceId = await this.options.operational.upsertAuthorizedSpace(
      inbound,
      sender,
    );
    this.options.onSpacePersisted?.(spaceId, inbound.space);
    const contentHash = createHmac("sha256", this.options.contentHashKey)
      .update("imessage-agent-message-v1\0", "utf8")
      .update(inbound.text, "utf8")
      .digest("hex");
    const result = await this.options.pipeline.ingestAndSchedule({
      spaceId,
      externalMessageId: inbound.externalMessageId,
      senderIdentityId: sender.identityId,
      contentCiphertext: this.options.cipher.encrypt(inbound.text),
      contentHash,
      receivedAt: inbound.receivedAt,
      retentionExpiresAt: retentionExpiry(
        inbound.receivedAt,
        this.options.rawMessageRetentionDays,
      ),
    });
    return result.inserted ? "accepted" : "duplicate";
  }
}

export interface NativeSpectrumOutboundOptions {
  operational: Pick<OperationalRepository, "getPersistedRoute">;
  resolver: SpaceResolver<Space>;
  conversationPresence?: Pick<ConversationPresencePort, "end">;
}

/**
 * Uses Spectrum's public native `space.send(text(...))` path. The persisted
 * outbox still supplies a stable logical GUID, although spectrum-ts 12.7 does
 * not yet accept that GUID as a caller-provided delivery parameter.
 */
export class NativeSpectrumOutboundTransport implements OutboundTransport {
  public constructor(private readonly options: NativeSpectrumOutboundOptions) {}

  public async send(request: {
    spaceId: string;
    clientGuid: string;
    text: string;
    signal: AbortSignal;
  }): Promise<{ externalMessageId: string | null }> {
    await this.options.conversationPresence
      ?.end(request.spaceId)
      .catch(() => undefined);
    request.signal.throwIfAborted();
    const route = await this.options.operational.getPersistedRoute(
      request.spaceId,
    );
    const space = await this.options.resolver.resolve(route);
    request.signal.throwIfAborted();
    const sent = await space.send(text(request.text));
    return { externalMessageId: messageId(sent) };
  }
}

function messageId(message: Message | undefined): string | null {
  return message?.id ?? null;
}
