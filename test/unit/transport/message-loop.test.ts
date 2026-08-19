import type { Message, Space } from "spectrum-ts";
import { describe, expect, it, vi } from "vitest";

import { SpectrumReadiness } from "../../../src/http/readiness.js";
import {
  handleSpectrumMessage,
  runSpectrumMessageLoop,
  SpectrumMessageLoopError,
  type AuthorizeAndIngest,
} from "../../../src/transport/message-loop.js";
import { ReadReceiptDispatcher } from "../../../src/transport/read-receipts.js";

function fakeSpace(
  overrides: Partial<Record<"id" | "phone" | "type", string>> = {},
): Space {
  return {
    __platform: "imessage",
    id: overrides.id ?? "opaque-space-guid",
    phone: overrides.phone ?? "+15559999999",
    send: vi.fn(async () => undefined),
    type: overrides.type ?? "dm",
  } as unknown as Space;
}

function fakeMessage(
  space: Space,
  overrides: {
    content?: unknown;
    direction?: "inbound" | "outbound";
    id?: string;
    mentions?: readonly { address: string; start: number; length: number }[];
    platform?: string;
    read?: Message["read"];
    sender?: unknown;
  } = {},
): Message {
  return {
    content: overrides.content ?? { type: "text", text: "hello" },
    direction: overrides.direction ?? "inbound",
    id: overrides.id ?? "external-message-id",
    mentions: overrides.mentions,
    platform: overrides.platform ?? "imessage",
    read: overrides.read ?? vi.fn(async () => undefined),
    sender:
      "sender" in overrides
        ? overrides.sender
        : {
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
  implementation: AuthorizeAndIngest["authorizeAndIngest"] = async () =>
    "accepted",
): AuthorizeAndIngest {
  return { authorizeAndIngest: vi.fn(implementation) };
}

describe("Spectrum message handling", () => {
  it("normalizes one inbound text event, ingests it, and then marks it read", async () => {
    const sequence: string[] = [];
    const authorizeAndIngest = ingestion(async () => {
      sequence.push("ingested");
      return "accepted";
    });
    const space = fakeSpace();
    const read = vi.fn(async () => {
      sequence.push("read");
    });
    const message = fakeMessage(space, { read });
    const dispatcher = new ReadReceiptDispatcher();

    await expect(
      handleSpectrumMessage(space, message, {
        authorizeAndIngest,
        readReceiptDispatcher: dispatcher,
        wait: async () => undefined,
      }),
    ).resolves.toBe("accepted");
    await dispatcher.close();

    expect(authorizeAndIngest.authorizeAndIngest).toHaveBeenCalledTimes(1);
    expect(authorizeAndIngest.authorizeAndIngest).toHaveBeenCalledWith(
      {
        externalMessageId: "external-message-id",
        receivedAt: new Date("2026-08-14T12:00:00.000Z"),
        sender: {
          address: "owner@example.com",
          kind: "email",
          service: "iMessage",
        },
        space: {
          routePhone: "+15559999999",
          spaceGuid: "opaque-space-guid",
          spaceType: "dm",
        },
        text: "hello",
        mentionedAddresses: [],
      },
      {},
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(sequence).toEqual(["ingested", "read"]);
  });

  it("marks a duplicate external message as read without re-ingesting it", async () => {
    const authorizeAndIngest = ingestion(async () => "duplicate");
    const space = fakeSpace();
    const read = vi.fn(async () => undefined);
    const dispatcher = new ReadReceiptDispatcher();

    await expect(
      handleSpectrumMessage(space, fakeMessage(space, { read }), {
        authorizeAndIngest,
        readReceiptDispatcher: dispatcher,
        wait: async () => undefined,
      }),
    ).resolves.toBe("duplicate");
    await dispatcher.close();

    expect(read).toHaveBeenCalledTimes(1);
  });

  it("reads an intercepted authorized command without starting agent presence", async () => {
    const authorizeAndIngest = ingestion(async (_inbound, context) => {
      context.onHandledWithoutAgentPresence?.();
      return "accepted";
    });
    const dispatcher = new ReadReceiptDispatcher();
    const space = fakeSpace();
    const read = vi.fn(async () => undefined);
    const conversationPresence = {
      beginRoute: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      endRoute: vi.fn(async () => undefined),
      reserve: vi.fn(() => 1),
      reset: vi.fn(async () => undefined),
    };

    await handleSpectrumMessage(space, fakeMessage(space, { read }), {
      authorizeAndIngest,
      conversationPresence,
      readReceiptDispatcher: dispatcher,
      wait: async () => undefined,
    });
    await dispatcher.close();

    expect(read).toHaveBeenCalledTimes(1);
    expect(conversationPresence.reserve).not.toHaveBeenCalled();
    expect(conversationPresence.beginRoute).not.toHaveBeenCalled();
  });

  it("does not mark an unauthorized inbound message as read", async () => {
    const authorizeAndIngest = ingestion(async () => "unauthorized");
    const space = fakeSpace();
    const read = vi.fn(async () => undefined);

    await expect(
      handleSpectrumMessage(space, fakeMessage(space, { read }), {
        authorizeAndIngest,
      }),
    ).resolves.toBe("unauthorized");

    expect(read).not.toHaveBeenCalled();
  });

  it("does not mark a message read when durable ingestion fails", async () => {
    const authorizeAndIngest = ingestion(async () => {
      throw new Error("database unavailable");
    });
    const space = fakeSpace();
    const read = vi.fn(async () => undefined);

    await expect(
      handleSpectrumMessage(space, fakeMessage(space, { read }), {
        authorizeAndIngest,
      }),
    ).rejects.toThrow("database unavailable");

    expect(read).not.toHaveBeenCalled();
  });

  it("preserves native mention and direct-reply evidence for deterministic group policy", async () => {
    const authorizeAndIngest = ingestion();
    const space = fakeSpace({ type: "group" });
    await handleSpectrumMessage(
      space,
      fakeMessage(space, {
        mentions: [{ address: "agent@example.com", start: 0, length: 6 }],
        content: {
          type: "reply",
          content: { type: "text", text: "please continue" },
          target: { id: "persisted-agent-message" },
        },
      }),
      { authorizeAndIngest },
    );

    expect(authorizeAndIngest.authorizeAndIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "please continue",
        mentionedAddresses: ["agent@example.com"],
        replyToExternalMessageId: "persisted-agent-message",
        space: expect.objectContaining({ spaceType: "group" }),
      }),
      {},
    );
  });

  it.each([
    ["outbound echo", { direction: "outbound" }, "outbound-echo"],
    [
      "reaction",
      { content: { type: "reaction", emoji: "like" } },
      "unsupported-content",
    ],
    [
      "read receipt",
      { content: { type: "read", target: {} } },
      "unsupported-content",
    ],
    [
      "attachment",
      { content: { type: "attachment", name: "photo.jpg" } },
      "unsupported-content",
    ],
    ["other platform", { platform: "telegram" }, "non-imessage"],
  ] as const)("ignores %s events", async (_name, overrides, expected) => {
    const authorizeAndIngest = ingestion();
    const onIgnored = vi.fn();
    const space = fakeSpace();
    const read = vi.fn(async () => undefined);

    await expect(
      handleSpectrumMessage(space, fakeMessage(space, { ...overrides, read }), {
        authorizeAndIngest,
        onIgnored,
      }),
    ).resolves.toBe(expected);

    expect(authorizeAndIngest.authorizeAndIngest).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(onIgnored).toHaveBeenCalledWith(expected);
  });

  it("ignores a missing sender before authorization handoff", async () => {
    const authorizeAndIngest = ingestion();
    const space = fakeSpace();
    const read = vi.fn(async () => undefined);

    await expect(
      handleSpectrumMessage(space, fakeMessage(space, { read, sender: null }), {
        authorizeAndIngest,
      }),
    ).resolves.toBe("invalid-sender");
    expect(authorizeAndIngest.authorizeAndIngest).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
});

describe("supervised Spectrum receive loop", () => {
  it("marks readiness degraded and stops after the bounded restart limit", async () => {
    const readiness = new SpectrumReadiness();
    const messages = vi.fn(() => {
      async function* disconnected(): AsyncIterable<readonly [Space, Message]> {
        throw new Error("provider disconnected for +15559999999");
      }
      return disconnected();
    });
    const wait = vi.fn(
      async (_milliseconds: number, _signal?: AbortSignal) => undefined,
    );

    await expect(
      runSpectrumMessageLoop({
        authorizeAndIngest: ingestion(),
        messages,
        readiness,
        restartPolicy: {
          initialDelayMs: 5,
          maximumDelayMs: 10,
          maxRestarts: 2,
        },
        wait,
      }),
    ).rejects.toMatchObject({
      code: "SPECTRUM_STREAM_RESTART_EXHAUSTED",
    } satisfies Partial<SpectrumMessageLoopError>);

    expect(messages).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls.map(([delay]) => delay)).toEqual([5, 10]);
    expect(readiness.snapshot()).toEqual({
      component: "spectrum",
      failureCode: "SPECTRUM_STREAM_RESTART_EXHAUSTED",
      ready: false,
      restartAttempt: 3,
      state: "degraded",
    });
    expect(JSON.stringify(readiness.snapshot())).not.toContain("+15559999999");
  });

  it("reconnects after a failure and stops cleanly when aborted", async () => {
    const controller = new AbortController();
    const readiness = new SpectrumReadiness();
    const space = fakeSpace();
    let sourceNumber = 0;
    const messages = vi.fn(() => {
      sourceNumber += 1;
      if (sourceNumber === 1) {
        return (async function* disconnected(): AsyncIterable<
          readonly [Space, Message]
        > {
          throw new Error("temporary disconnect");
        })();
      }

      return (async function* recovered(): AsyncIterable<
        readonly [Space, Message]
      > {
        yield [space, fakeMessage(space)] as const;
      })();
    });
    const authorizeAndIngest = ingestion(async () => {
      controller.abort();
      return "accepted";
    });

    await expect(
      runSpectrumMessageLoop({
        authorizeAndIngest,
        messages,
        readiness,
        restartPolicy: {
          initialDelayMs: 1,
          maximumDelayMs: 1,
          maxRestarts: 1,
        },
        signal: controller.signal,
        wait: async () => undefined,
      }),
    ).resolves.toBeUndefined();

    expect(messages).toHaveBeenCalledTimes(2);
    expect(authorizeAndIngest.authorizeAndIngest).toHaveBeenCalledTimes(1);
    expect(readiness.snapshot()).toEqual({
      component: "spectrum",
      ready: false,
      state: "stopped",
    });
  });
});
