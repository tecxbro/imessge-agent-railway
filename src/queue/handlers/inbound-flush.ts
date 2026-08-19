import type { ChainRepository } from "../../db/repositories/chains.js";
import type { QueuePublisher } from "../publisher.js";
import type { InboundFlushPayload } from "../payloads.js";

export interface InboundFlushDependencies {
  chains: Pick<ChainRepository, "flushInboundMessages">;
  publisher: Pick<QueuePublisher, "enqueueTurnPlan">;
  onChainsSuperseded?: (chainIds: readonly string[]) => void;
  onChainCreated?: (chainId: string, spaceId: string) => void;
  now?: () => Date;
}

export function createInboundFlushHandler(dependencies: InboundFlushDependencies) {
  return async (payload: InboundFlushPayload): Promise<void> => {
    // The repository atomically drains carried/current messages into one
    // versioned chain before the identifier-only planning job is published.
    const flushed = await dependencies.chains.flushInboundMessages(
      payload.spaceId,
      dependencies.now?.() ?? new Date(),
    );
    if (flushed === null) {
      return;
    }
    if (flushed.canceledChainIds.length > 0) {
      dependencies.onChainsSuperseded?.(flushed.canceledChainIds);
    }
    dependencies.onChainCreated?.(flushed.chainId, payload.spaceId);

    await dependencies.publisher.enqueueTurnPlan({
      chainId: flushed.chainId,
      expectedChainVersion: flushed.version,
      expectedState: "queued",
    });
  };
}
