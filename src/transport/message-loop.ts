/**
 * Spectrum intake boundary.
 *
 * The receive loop only normalizes, filters, authorizes, persists, and
 * schedules. It must never perform model or memory work inline. Consecutive
 * restart counts reset only after a provider event is processed successfully.
 */
import type { Message, Space } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

import {
  SpectrumReadiness,
  type SpectrumFailureCode,
} from "../http/readiness.js";
import {
  DEFAULT_READ_RECEIPT_DELAY_MS,
  DEFAULT_TYPING_START_DELAY_MS,
  ReadReceiptDispatcher,
  type ReadReceiptDispatcherPort,
} from "./read-receipts.js";
import { InboundPresenceDispatcher } from "./inbound-presence.js";
import type { InboundConversationPresencePort } from "./conversation-presence.js";
import {
  SenderIdentityError,
  normalizeIMessageSender,
  type NormalizedSenderIdentity,
} from "./sender-identity.js";
import {
  SpaceResolutionError,
  persistedRouteFromIMessageSpace,
  type PersistedSpaceRoute,
} from "./space-resolver.js";

export const IGNORED_SPECTRUM_EVENT_REASONS = [
  "non-imessage",
  "outbound-echo",
  "unsupported-content",
  "invalid-sender",
  "invalid-space",
] as const;

export type IgnoredSpectrumEventReason =
  (typeof IGNORED_SPECTRUM_EVENT_REASONS)[number];

export interface InboundTextForAuthorization {
  externalMessageId: string;
  receivedAt: Date;
  sender: NormalizedSenderIdentity;
  space: PersistedSpaceRoute;
  text: string;
  mentionedAddresses: string[];
  /** Must be verified against a persisted agent outbound in the same space. */
  replyToExternalMessageId?: string;
}

export const INGEST_DISPOSITIONS = [
  "accepted",
  "duplicate",
  "unauthorized",
] as const;

export type IngestDisposition = (typeof INGEST_DISPOSITIONS)[number];

export interface AuthorizeAndIngest {
  authorizeAndIngest(
    inbound: InboundTextForAuthorization,
    context: {
      signal?: AbortSignal;
      onHandledWithoutAgentPresence?: () => void;
    },
  ): Promise<IngestDisposition>;
}

export interface RestartPolicy {
  maxRestarts: number;
  initialDelayMs: number;
  maximumDelayMs: number;
}

export const DEFAULT_RESTART_POLICY: RestartPolicy = {
  maxRestarts: 5,
  initialDelayMs: 500,
  maximumDelayMs: 10_000,
};

export interface SpectrumMessageLoopOptions {
  authorizeAndIngest: AuthorizeAndIngest;
  messages: () => AsyncIterable<readonly [Space, Message]>;
  readiness: SpectrumReadiness;
  onIgnored?: (reason: IgnoredSpectrumEventReason) => void;
  conversationPresence?: InboundConversationPresencePort;
  readReceiptDispatcher?: ReadReceiptDispatcherPort;
  readDelayMs?: number;
  restartPolicy?: RestartPolicy;
  signal?: AbortSignal;
  typingStartDelayMs?: number;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export class SpectrumMessageLoopError extends Error {
  public readonly code: SpectrumFailureCode;

  public constructor(code: SpectrumFailureCode, cause?: unknown) {
    super(
      code === "SPECTRUM_STREAM_RESTART_EXHAUSTED"
        ? "Spectrum receive-loop restart attempts were exhausted. Check Photon connectivity and credentials, then restart the service."
        : "Spectrum message stream disconnected. The receive loop will retry using the configured bounded restart policy.",
      cause === undefined ? undefined : { cause },
    );
    this.name = "SpectrumMessageLoopError";
    this.code = code;
  }
}

class SpectrumStreamEndedError extends Error {
  public constructor() {
    super("Spectrum message stream ended unexpectedly");
    this.name = "SpectrumStreamEndedError";
  }
}

function calculateRestartDelay(
  restartAttempt: number,
  policy: RestartPolicy,
): number {
  return Math.min(
    policy.initialDelayMs * 2 ** Math.max(0, restartAttempt - 1),
    policy.maximumDelayMs,
  );
}

function defaultWait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (isAborted(signal)) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timeout = setTimeout(finish, milliseconds);
    timeout.unref();

    signal?.addEventListener("abort", finish, { once: true });
  });
}

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted ?? false;
}

const directHandleReadReceiptDispatcher = new ReadReceiptDispatcher();

function normalizeInboundText(
  space: Space,
  message: Message,
):
  | { ignored: IgnoredSpectrumEventReason }
  | { inbound: InboundTextForAuthorization } {
  if (message.platform !== "imessage") {
    return { ignored: "non-imessage" };
  }

  const narrowedMessage = imessage(message);
  if (narrowedMessage.direction !== "inbound") {
    return { ignored: "outbound-echo" };
  }

  const content = narrowedMessage.content;
  const text =
    content.type === "text"
      ? content.text
      : content.type === "reply" && content.content.type === "text"
        ? content.content.text
        : undefined;
  if (text === undefined) {
    return { ignored: "unsupported-content" };
  }

  let sender: NormalizedSenderIdentity;
  try {
    sender = normalizeIMessageSender(narrowedMessage.sender);
  } catch (error) {
    if (error instanceof SenderIdentityError) {
      return { ignored: "invalid-sender" };
    }
    throw error;
  }

  let persistedSpace: PersistedSpaceRoute;
  try {
    persistedSpace = persistedRouteFromIMessageSpace(imessage(space));
  } catch (error) {
    if (error instanceof SpaceResolutionError) {
      return { ignored: "invalid-space" };
    }
    throw error;
  }

  return {
    inbound: {
      externalMessageId: narrowedMessage.id,
      receivedAt: narrowedMessage.timestamp,
      sender,
      space: persistedSpace,
      text,
      mentionedAddresses: ((narrowedMessage as unknown as {
        mentions?: readonly { address: string }[];
      }).mentions ?? []).map(
        (mention) => mention.address,
      ),
      ...(content.type === "reply"
        ? { replyToExternalMessageId: content.target.id }
        : {}),
    },
  };
}

export async function handleSpectrumMessage(
  space: Space,
  message: Message,
  options: Pick<
    SpectrumMessageLoopOptions,
    | "authorizeAndIngest"
    | "conversationPresence"
    | "onIgnored"
    | "readDelayMs"
    | "readReceiptDispatcher"
    | "signal"
    | "typingStartDelayMs"
    | "wait"
  >,
): Promise<IngestDisposition | IgnoredSpectrumEventReason> {
  const normalized = normalizeInboundText(space, message);
  if ("ignored" in normalized) {
    options.onIgnored?.(normalized.ignored);
    return normalized.ignored;
  }

  let handledWithoutAgentPresence = false;
  const disposition = await options.authorizeAndIngest.authorizeAndIngest(
    normalized.inbound,
    {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.conversationPresence === undefined
        ? {}
        : {
            onHandledWithoutAgentPresence: () => {
              handledWithoutAgentPresence = true;
            },
          }),
    },
  );

  if (disposition !== "unauthorized") {
    const presenceGeneration = handledWithoutAgentPresence
      ? undefined
      : options.conversationPresence?.reserve(normalized.inbound.space);
    const dispatcher = new InboundPresenceDispatcher({
      readDelayMs: options.readDelayMs ?? DEFAULT_READ_RECEIPT_DELAY_MS,
      readReceiptDispatcher:
        options.readReceiptDispatcher ?? directHandleReadReceiptDispatcher,
      typingStartDelayMs:
        options.typingStartDelayMs ?? DEFAULT_TYPING_START_DELAY_MS,
      wait: options.wait ?? defaultWait,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const scheduled = dispatcher.dispatch({
      read: () => message.read(),
      beginTyping: async () => {
        if (presenceGeneration !== undefined) {
          await options.conversationPresence?.beginRoute(
            normalized.inbound.space,
            presenceGeneration,
          );
        }
      },
    });
    if (!scheduled && presenceGeneration !== undefined) {
      void options.conversationPresence
        ?.endRoute(normalized.inbound.space, presenceGeneration)
        .catch(() => undefined);
    }
  }

  return disposition;
}

export async function runSpectrumMessageLoop(
  options: SpectrumMessageLoopOptions,
): Promise<void> {
  const policy = options.restartPolicy ?? DEFAULT_RESTART_POLICY;
  const wait = options.wait ?? defaultWait;
  const readReceiptDispatcher =
    options.readReceiptDispatcher ?? new ReadReceiptDispatcher();
  let restartAttempt = 0;

  try {
    options.readiness.markStarting();

    while (!isAborted(options.signal)) {
      try {
        const messages = options.messages();
        options.readiness.markConnected();

        for await (const [space, message] of messages) {
          if (isAborted(options.signal)) {
            break;
          }

          await handleSpectrumMessage(space, message, {
            authorizeAndIngest: options.authorizeAndIngest,
            ...(options.conversationPresence === undefined
              ? {}
              : { conversationPresence: options.conversationPresence }),
            ...(options.onIgnored === undefined
              ? {}
              : { onIgnored: options.onIgnored }),
            readDelayMs: options.readDelayMs ?? DEFAULT_READ_RECEIPT_DELAY_MS,
            readReceiptDispatcher,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            typingStartDelayMs:
              options.typingStartDelayMs ?? DEFAULT_TYPING_START_DELAY_MS,
            wait,
          });
          // Receiving and handling an event proves that the restarted stream
          // is healthy; future disconnects begin a new consecutive-failure
          // window. Receipt failures never enter this control flow.
          restartAttempt = 0;
        }

        if (isAborted(options.signal)) {
          break;
        }

        throw new SpectrumStreamEndedError();
      } catch (error) {
        if (isAborted(options.signal)) {
          break;
        }

        // A disconnected provider cannot retain trustworthy presence state.
        // Cleanup stays detached from stream supervision and retry health.
        void options.conversationPresence?.reset().catch(() => undefined);

        restartAttempt += 1;
        const exhausted = restartAttempt > policy.maxRestarts;
        options.readiness.markDegraded(
          exhausted
            ? "SPECTRUM_STREAM_RESTART_EXHAUSTED"
            : "SPECTRUM_STREAM_DISCONNECTED",
          restartAttempt,
        );

        if (exhausted) {
          throw new SpectrumMessageLoopError(
            "SPECTRUM_STREAM_RESTART_EXHAUSTED",
            error,
          );
        }

        await wait(
          calculateRestartDelay(restartAttempt, policy),
          options.signal,
        );
        if (!isAborted(options.signal)) {
          options.readiness.markStarting(restartAttempt);
        }
      }
    }

    options.readiness.markStopped();
  } finally {
    await options.conversationPresence?.close().catch(() => undefined);
    await readReceiptDispatcher.close().catch(() => undefined);
  }
}
