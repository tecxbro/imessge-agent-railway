import type {
  OutboundPartToSend,
  OutboundRepository,
} from "../../db/repositories/outbound.js";
import type { FailureRepository } from "../../db/repositories/failures.js";
import type { OutboundSendPayload } from "../payloads.js";

export interface OutboundTransportRequest {
  spaceId: string;
  clientGuid: string;
  text: string;
  signal: AbortSignal;
}

export interface OutboundTransportReceipt {
  externalMessageId: string | null;
}

export interface OutboundTransport {
  send(request: OutboundTransportRequest): Promise<OutboundTransportReceipt>;
}

export interface OutboundSendDependencies {
  outbound: Pick<
    OutboundRepository,
    "claimNextPart" | "checkpointSentPart"
  >;
  failures: Pick<FailureRepository, "recordFailureFailSafe">;
  transport: OutboundTransport;
  decrypt(ciphertext: string): Promise<string> | string;
  failureRetentionDays: number;
  now?: () => Date;
  afterAcknowledgement?: (part: OutboundPartToSend) => Promise<void> | void;
  afterBatchComplete?: (outboundBatchId: string) => Promise<void> | void;
}

function retentionExpiry(now: Date, days: number): Date {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1_000);
}

export function createOutboundSendHandler(dependencies: OutboundSendDependencies) {
  return async (
    payload: OutboundSendPayload,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<void> => {
    // Claim, send, then checkpoint each materialized part. The cursor must not
    // advance before provider acknowledgement, even when the worker retries.
    try {
      while (!signal.aborted) {
        const part = await dependencies.outbound.claimNextPart(
          payload.outboundBatchId,
        );
        if (part === null) {
          await dependencies.afterBatchComplete?.(payload.outboundBatchId);
          return;
        }

        const text = await dependencies.decrypt(part.contentCiphertext);
        const receipt = await dependencies.transport.send({
          spaceId: part.spaceId,
          clientGuid: part.clientGuid,
          text,
          signal,
        });
        await dependencies.afterAcknowledgement?.(part);
        const checkpoint = await dependencies.outbound.checkpointSentPart(
          part.batchId,
          part.position,
          receipt.externalMessageId,
          dependencies.now?.() ?? new Date(),
        );
        if (checkpoint.batchComplete) {
          await dependencies.afterBatchComplete?.(payload.outboundBatchId);
          return;
        }
      }

      throw new Error(
        "Outbound send was aborted before the materialized batch completed; pg-boss may retry from the persisted cursor.",
      );
    } catch (error) {
      const now = dependencies.now?.() ?? new Date();
      const message = error instanceof Error ? error.message : "Unknown outbound failure";
      await dependencies.failures.recordFailureFailSafe({
        correlationType: "outbound_batch",
        correlationId: payload.outboundBatchId,
        component: "outbound",
        errorCode: signal.aborted ? "OUTBOUND_ABORTED" : "OUTBOUND_SEND_FAILED",
        retryable: true,
        safeMessage: message,
        payloadSummary: { expectedState: payload.expectedState },
        retentionExpiresAt: retentionExpiry(now, dependencies.failureRetentionDays),
      });
      throw error;
    }
  };
}
