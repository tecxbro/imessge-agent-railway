import type { Message, Space } from "spectrum-ts";
import { describe, expect, it, vi } from "vitest";

import { ConversationPresenceCoordinator } from "../../../src/transport/conversation-presence.js";
import { NativeSpectrumOutboundTransport } from "../../../src/transport/operational.js";
import type { PersistedSpaceRoute } from "../../../src/transport/space-resolver.js";

const route: PersistedSpaceRoute = {
  routePhone: "+15559999999",
  spaceGuid: "provider-space-guid",
  spaceType: "dm",
};

function outboundHarness() {
  const sequence: string[] = [];
  const startTyping = vi.fn(async () => {
    sequence.push("startTyping");
  });
  const stopTyping = vi.fn(async () => {
    sequence.push("stopTyping");
  });
  const send = vi.fn(async () => {
    sequence.push("send");
    return { id: "provider-message-id" } as Message;
  });
  const responding = vi.fn();
  const space = {
    responding,
    send,
    startTyping,
    stopTyping,
  } as unknown as Space;
  const operational = {
    getPersistedRoute: vi.fn(async () => route),
  };
  const resolver = {
    resolve: vi.fn(async () => space),
  };
  return {
    operational,
    resolver,
    responding,
    send,
    sequence,
    space,
    startTyping,
    stopTyping,
  };
}

describe("NativeSpectrumOutboundTransport presence", () => {
  it("stops typing immediately before sending and does not use responding", async () => {
    const harness = outboundHarness();
    const presence = {
      end: vi.fn(async () => {
        harness.sequence.push("stopTyping");
      }),
    };
    const transport = new NativeSpectrumOutboundTransport({
      conversationPresence: presence,
      operational: harness.operational as never,
      resolver: harness.resolver as never,
    });

    await expect(
      transport.send({
        clientGuid: "stable-client-guid",
        signal: new AbortController().signal,
        spaceId: "internal-space-id",
        text: "reply",
      }),
    ).resolves.toEqual({ externalMessageId: "provider-message-id" });

    expect(harness.sequence).toEqual(["stopTyping", "send"]);
    expect(harness.responding).not.toHaveBeenCalled();
  });

  it("stops real presence only once across multiple response bubbles", async () => {
    const harness = outboundHarness();
    const presence = new ConversationPresenceCoordinator({
      maximumTypingDurationMs: 10_000,
      operational: harness.operational as never,
      resolver: harness.resolver as never,
    });
    presence.associateSpace("internal-space-id", route);
    const generation = presence.reserve(route);
    await presence.beginRoute(route, generation);
    const transport = new NativeSpectrumOutboundTransport({
      conversationPresence: presence,
      operational: harness.operational as never,
      resolver: harness.resolver as never,
    });

    for (const reply of ["first bubble", "second bubble"]) {
      await transport.send({
        clientGuid: reply,
        signal: new AbortController().signal,
        spaceId: "internal-space-id",
        text: reply,
      });
    }

    expect(harness.stopTyping).toHaveBeenCalledTimes(1);
    expect(harness.send).toHaveBeenCalledTimes(2);
    expect(harness.sequence).toEqual([
      "startTyping",
      "stopTyping",
      "send",
      "send",
    ]);
    expect(harness.responding).not.toHaveBeenCalled();
  });

  it("does not block a reply when stop-typing fails", async () => {
    const harness = outboundHarness();
    const transport = new NativeSpectrumOutboundTransport({
      conversationPresence: {
        end: vi.fn(async () => {
          throw new Error("typing provider unavailable");
        }),
      },
      operational: harness.operational as never,
      resolver: harness.resolver as never,
    });

    await expect(
      transport.send({
        clientGuid: "stable-client-guid",
        signal: new AbortController().signal,
        spaceId: "internal-space-id",
        text: "reply",
      }),
    ).resolves.toEqual({ externalMessageId: "provider-message-id" });
    expect(harness.send).toHaveBeenCalledTimes(1);
  });

  it("cleans up presence before honoring an already-aborted send", async () => {
    const harness = outboundHarness();
    const presence = new ConversationPresenceCoordinator({
      maximumTypingDurationMs: 10_000,
      operational: harness.operational as never,
      resolver: harness.resolver as never,
    });
    presence.associateSpace("internal-space-id", route);
    const generation = presence.reserve(route);
    await presence.beginRoute(route, generation);
    const controller = new AbortController();
    controller.abort(new Error("outbound canceled"));
    const transport = new NativeSpectrumOutboundTransport({
      conversationPresence: presence,
      operational: harness.operational as never,
      resolver: harness.resolver as never,
    });

    await expect(
      transport.send({
        clientGuid: "stable-client-guid",
        signal: controller.signal,
        spaceId: "internal-space-id",
        text: "reply",
      }),
    ).rejects.toThrow("outbound canceled");

    expect(harness.stopTyping).toHaveBeenCalledTimes(1);
    expect(harness.send).not.toHaveBeenCalled();
  });
});
