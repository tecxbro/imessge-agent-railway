import type { Message, Space } from "spectrum-ts";
import { describe, expect, it, vi } from "vitest";

import { SpectrumReadiness } from "../../src/http/readiness.js";
import {
  READ_RECEIPT_METRICS,
  ReadReceiptMetrics,
} from "../../src/observability/read-receipt-metrics.js";
import {
  handleSpectrumMessage,
  runSpectrumMessageLoop,
  type AuthorizeAndIngest,
} from "../../src/transport/message-loop.js";
import {
  DEFAULT_READ_RECEIPT_DELAY_MS,
  DEFAULT_TYPING_START_DELAY_MS,
  ReadReceiptDispatcher,
} from "../../src/transport/read-receipts.js";
import type { InboundConversationPresencePort } from "../../src/transport/conversation-presence.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function fakeSpace(): Space {
  return {
    __platform: "imessage",
    id: "opaque-space-guid",
    phone: "+15559999999",
    send: vi.fn(async () => undefined),
    type: "dm",
  } as unknown as Space;
}

function fakeMessage(
  space: Space,
  options: { id?: string; read?: Message["read"] } = {},
): Message {
  return {
    content: { type: "text", text: "hello" },
    direction: "inbound",
    id: options.id ?? "external-message-id",
    platform: "imessage",
    read: options.read ?? vi.fn(async () => undefined),
    sender: {
      __platform: "imessage",
      address: "Owner@Example.com",
      id: "Owner@Example.com",
      service: "iMessage",
    },
    space,
    timestamp: new Date("2026-08-14T12:00:00.000Z"),
  } as unknown as Message;
}

function ingestion(
  implementation: AuthorizeAndIngest["authorizeAndIngest"],
): AuthorizeAndIngest {
  return { authorizeAndIngest: vi.fn(implementation) };
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}

function fakePresence(
  beginRoute: InboundConversationPresencePort["beginRoute"] = async () =>
    undefined,
): InboundConversationPresencePort {
  return {
    beginRoute: vi.fn(beginRoute),
    close: vi.fn(async () => undefined),
    endRoute: vi.fn(async () => undefined),
    reserve: vi.fn(() => 1),
    reset: vi.fn(async () => undefined),
  };
}

describe("read-receipt isolation from Spectrum stream health", () => {
  it("keeps the delayed read-to-typing sequence after a read failure", async () => {
    const sequence: string[] = [];
    const metrics = new ReadReceiptMetrics();
    const dispatcher = new ReadReceiptDispatcher({
      attemptTimeoutMs: 100,
      concurrency: 1,
      maxPending: 1,
      metrics,
      shutdownDrainMs: 100,
    });
    const space = fakeSpace();
    const read = vi.fn(async () => {
      sequence.push("read");
      throw new Error("provider read failed");
    });
    const presence = fakePresence(async () => {
      sequence.push("startTyping");
    });
    const wait = vi.fn(async (milliseconds: number) => {
      sequence.push(`wait:${milliseconds}`);
    });

    await expect(
      handleSpectrumMessage(space, fakeMessage(space, { read }), {
        authorizeAndIngest: ingestion(async () => {
          sequence.push("durably-ingested");
          return "accepted";
        }),
        conversationPresence: presence,
        readDelayMs: DEFAULT_READ_RECEIPT_DELAY_MS,
        readReceiptDispatcher: dispatcher,
        typingStartDelayMs: DEFAULT_TYPING_START_DELAY_MS,
        wait,
      }),
    ).resolves.toBe("accepted");
    await dispatcher.close();

    expect(read).toHaveBeenCalledTimes(1);
    expect(presence.beginRoute).toHaveBeenCalledTimes(1);
    expect(sequence).toEqual([
      "durably-ingested",
      `wait:${DEFAULT_READ_RECEIPT_DELAY_MS}`,
      "read",
      `wait:${DEFAULT_TYPING_START_DELAY_MS}`,
      "startTyping",
    ]);
    expect(metrics.snapshot()[READ_RECEIPT_METRICS.failures]).toBe(1);
  });

  it("keeps the stream connected and processes the next message while a read is unresolved", async () => {
    const controller = new AbortController();
    const readiness = new SpectrumReadiness();
    const firstRead = deferred<void>();
    const secondHandled = deferred<void>();
    const space = fakeSpace();
    const secondRead = vi.fn(async () => undefined);
    const messages = vi.fn(() =>
      (async function* stream(): AsyncIterable<readonly [Space, Message]> {
        yield [
          space,
          fakeMessage(space, {
            id: "first-message",
            read: vi.fn(() => firstRead.promise),
          }),
        ] as const;
        yield [
          space,
          fakeMessage(space, { id: "second-message", read: secondRead }),
        ] as const;
        if (!controller.signal.aborted) {
          await new Promise<void>((resolve) => {
            controller.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
        }
      })(),
    );
    let handled = 0;
    const authorizeAndIngest = ingestion(async () => {
      handled += 1;
      if (handled === 2) {
        secondHandled.resolve();
      }
      return "accepted";
    });
    const dispatcher = new ReadReceiptDispatcher({
      attemptTimeoutMs: 1_000,
      concurrency: 2,
      maxPending: 2,
      shutdownDrainMs: 10,
    });

    const loop = runSpectrumMessageLoop({
      authorizeAndIngest,
      messages,
      readReceiptDispatcher: dispatcher,
      readiness,
      restartPolicy: {
        initialDelayMs: 1,
        maximumDelayMs: 1,
        maxRestarts: 1,
      },
      signal: controller.signal,
      wait: async () => undefined,
    });

    await secondHandled.promise;
    await flushPromises();

    expect(authorizeAndIngest.authorizeAndIngest).toHaveBeenCalledTimes(2);
    expect(secondRead).toHaveBeenCalledTimes(1);
    expect(readiness.snapshot()).toEqual({
      component: "spectrum",
      ready: true,
      state: "connected",
    });
    expect(readiness.snapshot().restartAttempt ?? 0).toBe(0);

    controller.abort();
    await loop;
    firstRead.resolve();
    await flushPromises();
  });

  it("never schedules a receipt for an unauthorized message", async () => {
    const dispatcher = new ReadReceiptDispatcher();
    const space = fakeSpace();
    const read = vi.fn(async () => undefined);
    const presence = fakePresence();

    await expect(
      handleSpectrumMessage(space, fakeMessage(space, { read }), {
        authorizeAndIngest: ingestion(async () => "unauthorized"),
        conversationPresence: presence,
        readReceiptDispatcher: dispatcher,
        wait: async () => undefined,
      }),
    ).resolves.toBe("unauthorized");
    await dispatcher.close();

    expect(read).not.toHaveBeenCalled();
    expect(presence.reserve).not.toHaveBeenCalled();
    expect(presence.beginRoute).not.toHaveBeenCalled();
  });

  it("schedules a receipt for a duplicate message", async () => {
    const dispatcher = new ReadReceiptDispatcher();
    const space = fakeSpace();
    const read = vi.fn(async () => undefined);
    const presence = fakePresence();

    await expect(
      handleSpectrumMessage(space, fakeMessage(space, { read }), {
        authorizeAndIngest: ingestion(async () => "duplicate"),
        conversationPresence: presence,
        readReceiptDispatcher: dispatcher,
        wait: async () => undefined,
      }),
    ).resolves.toBe("duplicate");
    await dispatcher.close();

    expect(read).toHaveBeenCalledTimes(1);
    expect(presence.beginRoute).toHaveBeenCalledTimes(1);
  });

  it("contains read and typing failures without reconnecting the Spectrum stream", async () => {
    const controller = new AbortController();
    const readiness = new SpectrumReadiness();
    const space = fakeSpace();
    const presence = fakePresence(async () => {
      controller.abort();
      throw new Error("provider typing failed");
    });
    const messages = vi.fn(() =>
      (async function* stream(): AsyncIterable<readonly [Space, Message]> {
        yield [
          space,
          fakeMessage(space, {
            read: vi.fn(async () => {
              throw new Error("provider read failed");
            }),
          }),
        ] as const;
      })(),
    );

    await runSpectrumMessageLoop({
      authorizeAndIngest: ingestion(async () => "accepted"),
      conversationPresence: presence,
      messages,
      readiness,
      signal: controller.signal,
      wait: async () => undefined,
    });

    expect(messages).toHaveBeenCalledTimes(1);
    expect(presence.beginRoute).toHaveBeenCalledTimes(1);
    expect(readiness.snapshot()).toEqual({
      component: "spectrum",
      ready: false,
      state: "stopped",
    });
  });

  it("uses and closes an injected dispatcher during loop cleanup", async () => {
    const controller = new AbortController();
    const space = fakeSpace();
    const dispatcher = {
      close: vi.fn(async () => undefined),
      dispatch: vi.fn(() => true),
    };

    await runSpectrumMessageLoop({
      authorizeAndIngest: ingestion(async () => {
        controller.abort();
        return "accepted";
      }),
      messages: () =>
        (async function* stream(): AsyncIterable<readonly [Space, Message]> {
          yield [space, fakeMessage(space)] as const;
        })(),
      readReceiptDispatcher: dispatcher,
      readiness: new SpectrumReadiness(),
      signal: controller.signal,
    });

    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(dispatcher.close).toHaveBeenCalledTimes(1);
  });
});
