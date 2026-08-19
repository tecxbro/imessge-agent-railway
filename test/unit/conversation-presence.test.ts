import type { Space } from "spectrum-ts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CONVERSATION_PRESENCE_METRICS,
  ConversationPresenceCoordinator,
  ConversationPresenceMetrics,
} from "../../src/transport/conversation-presence.js";
import type { PersistedSpaceRoute } from "../../src/transport/space-resolver.js";

const route: PersistedSpaceRoute = {
  routePhone: "+15559999999",
  spaceGuid: "provider-space-guid",
  spaceType: "dm",
};

function harness(
  options: {
    startTyping?: () => Promise<void>;
    stopTyping?: () => Promise<void>;
  } = {},
) {
  const startTyping = vi.fn(options.startTyping ?? (async () => undefined));
  const stopTyping = vi.fn(options.stopTyping ?? (async () => undefined));
  const space = {
    startTyping,
    stopTyping,
  } as unknown as Space;
  const metrics = new ConversationPresenceMetrics();
  const operational = {
    getPersistedRoute: vi.fn(async () => route),
  };
  const resolver = {
    resolve: vi.fn(async () => space),
  };
  const coordinator = new ConversationPresenceCoordinator({
    maximumTypingDurationMs: 1_000,
    metrics,
    operational,
    resolver: resolver as never,
  });
  coordinator.associateSpace("internal-space-id", route);
  return {
    coordinator,
    metrics,
    operational,
    resolver,
    startTyping,
    stopTyping,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ConversationPresenceCoordinator", () => {
  it("deduplicates concurrent begin calls for the same conversation", async () => {
    let releaseStart!: () => void;
    const started = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const { coordinator, startTyping } = harness({
      startTyping: async () => started,
    });
    const generation = coordinator.reserve(route);

    const first = coordinator.beginRoute(route, generation);
    const second = coordinator.beginRoute(route, generation);
    await Promise.resolve();
    releaseStart();
    await Promise.all([first, second]);

    expect(startTyping).toHaveBeenCalledTimes(1);
    await coordinator.close();
  });

  it("starts typing once and refreshes the deadline on a repeated begin", async () => {
    vi.useFakeTimers();
    const { coordinator, startTyping, stopTyping } = harness();

    const firstGeneration = await coordinator.begin("internal-space-id");
    await vi.advanceTimersByTimeAsync(900);
    const secondGeneration = await coordinator.begin("internal-space-id");
    await vi.advanceTimersByTimeAsync(900);

    expect(secondGeneration).toBeGreaterThan(firstGeneration);
    expect(startTyping).toHaveBeenCalledTimes(1);
    expect(stopTyping).not.toHaveBeenCalled();

    await coordinator.close();
  });

  it("ends typing once and makes repeated end calls no-ops", async () => {
    const { coordinator, startTyping, stopTyping } = harness();
    await coordinator.begin("internal-space-id");

    await coordinator.end("internal-space-id");
    await coordinator.end("internal-space-id");

    expect(startTyping).toHaveBeenCalledTimes(1);
    expect(stopTyping).toHaveBeenCalledTimes(1);
  });

  it("does not let an old generation stop a newer inbound generation", async () => {
    const { coordinator, stopTyping } = harness();
    const older = coordinator.reserve(route);
    await coordinator.beginRoute(route, older);
    const newer = coordinator.reserve(route);

    await coordinator.endRoute(route, older);
    expect(stopTyping).not.toHaveBeenCalled();

    await coordinator.endRoute(route, newer);
    expect(stopTyping).toHaveBeenCalledTimes(1);
  });

  it("stops an abandoned indicator at the hard safety deadline", async () => {
    vi.useFakeTimers();
    const { coordinator, metrics, stopTyping } = harness();
    await coordinator.begin("internal-space-id");

    await vi.advanceTimersByTimeAsync(1_000);

    expect(stopTyping).toHaveBeenCalledTimes(1);
    expect(
      metrics.snapshot()[CONVERSATION_PRESENCE_METRICS.safetyTimeouts],
    ).toBe(1);
  });

  it("closes every active conversation", async () => {
    const secondRoute: PersistedSpaceRoute = {
      spaceGuid: "second-provider-space-guid",
      spaceType: "group",
    };
    const first = harness();
    first.coordinator.associateSpace("second-space-id", secondRoute);
    await first.coordinator.begin("internal-space-id");
    const secondGeneration = first.coordinator.reserve(secondRoute);
    await first.coordinator.beginRoute(secondRoute, secondGeneration);

    await first.coordinator.close();

    expect(first.startTyping).toHaveBeenCalledTimes(2);
    expect(first.stopTyping).toHaveBeenCalledTimes(2);
  });

  it("contains provider failures and exposes only label-free aggregate metrics", async () => {
    const sensitiveValues = [
      "provider-space-guid",
      "+15559999999",
      "internal-space-id",
      "private message text",
    ];
    const { coordinator, metrics } = harness({
      startTyping: async () => {
        throw new Error(`provider failure ${sensitiveValues.join(" ")}`);
      },
    });

    await expect(coordinator.begin("internal-space-id")).resolves.toBe(1);
    await expect(coordinator.end("internal-space-id")).resolves.toBeUndefined();

    const snapshot = metrics.snapshot();
    expect(snapshot[CONVERSATION_PRESENCE_METRICS.startAttempts]).toBe(1);
    expect(snapshot[CONVERSATION_PRESENCE_METRICS.startFailures]).toBe(1);
    for (const sensitive of sensitiveValues) {
      expect(JSON.stringify(snapshot)).not.toContain(sensitive);
    }
  });

  it("contains stop failures and still clears the active generation", async () => {
    const { coordinator, metrics } = harness({
      stopTyping: async () => {
        throw new Error("provider stop failed");
      },
    });
    await coordinator.begin("internal-space-id");

    await expect(coordinator.end("internal-space-id")).resolves.toBeUndefined();
    await expect(coordinator.end("internal-space-id")).resolves.toBeUndefined();

    expect(metrics.snapshot()[CONVERSATION_PRESENCE_METRICS.stopAttempts]).toBe(
      1,
    );
    expect(metrics.snapshot()[CONVERSATION_PRESENCE_METRICS.stopFailures]).toBe(
      1,
    );
  });

  it("binds chain cleanup to the generation active when the chain was created", async () => {
    const { coordinator, stopTyping } = harness();
    const older = coordinator.reserve(route);
    await coordinator.beginRoute(route, older);
    coordinator.bindChain("older-chain", "internal-space-id");
    const newer = coordinator.reserve(route);

    await coordinator.endChain("older-chain");
    expect(stopTyping).not.toHaveBeenCalled();

    await coordinator.endRoute(route, newer);
    expect(stopTyping).toHaveBeenCalledTimes(1);
  });
});
