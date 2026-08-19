import Supermemory from "supermemory";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SupermemoryClient,
  ownerContainerTag,
} from "../../src/memory/supermemory-client.js";

const DEPLOYMENT_ID = "00000000-0000-4000-8000-000000000001";
const OWNER_ID = "00000000-0000-4000-8000-00000000000a";
const CONTAINER_TAG = ownerContainerTag(DEPLOYMENT_ID, OWNER_ID);

const PROFILE_RESPONSE = {
  profile: { static: ["The owner prefers concise summaries."], dynamic: [] },
};
const SEARCH_RESPONSE = { results: [], timing: 0, total: 0 };
const LIST_RESPONSE = {
  memoryEntries: [],
  pagination: { currentPage: 1, totalItems: 0, totalPages: 0 },
};

interface FakeRequestOptions {
  signal?: AbortSignal | null;
  timeout?: number;
  maxRetries?: number;
}

type FakeSdkMethod = (
  body: unknown,
  options?: FakeRequestOptions,
) => Promise<unknown>;

function fakeSdk(overrides: {
  profile?: FakeSdkMethod;
  search?: FakeSdkMethod;
  updateMemory?: FakeSdkMethod;
  forget?: FakeSdkMethod;
}): Supermemory {
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected fake SDK call.");
  };
  return {
    profile: overrides.profile ?? unexpected,
    search: overrides.search ?? unexpected,
    memories: {
      updateMemory: overrides.updateMemory ?? unexpected,
      forget: overrides.forget ?? unexpected,
    },
  } as unknown as Supermemory;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Supermemory provider boundary", () => {
  it("builds a provider-valid namespace entirely from internal IDs", () => {
    expect(CONTAINER_TAG).toHaveLength(94);
    expect(CONTAINER_TAG).toMatch(/^[a-zA-Z0-9_:-]+$/);
    expect(CONTAINER_TAG).not.toContain("+1555");
  });

  it("validates direct API responses instead of trusting provider JSON", async () => {
    const request: typeof fetch = async () =>
      new Response(JSON.stringify({ unexpected: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const client = new SupermemoryClient({
      apiKey: "fixture-key",
      fetchImplementation: request,
      maxReadRetries: 0,
    });

    await expect(
      client.listMemories({ containerTag: CONTAINER_TAG, limit: 10 }),
    ).rejects.toMatchObject({
      code: "MEMORY_PROVIDER_INVALID_RESPONSE",
      retryable: false,
    });
  });

  it("uses a fresh live signal when a timed-out first attempt is retried", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const caller = new AbortController();
    const addListener = vi.spyOn(caller.signal, "addEventListener");
    const removeListener = vi.spyOn(caller.signal, "removeEventListener");
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const attemptSignals: AbortSignal[] = [];
    const wasAbortedAtInvocation: boolean[] = [];

    const profile = vi.fn<FakeSdkMethod>(async (_body, options) => {
      const signal = options?.signal;
      if (signal === undefined || signal === null) {
        throw new Error("Missing attempt signal.");
      }
      attemptSignals.push(signal);
      wasAbortedAtInvocation.push(signal.aborted);
      if (attemptSignals.length === 1) {
        return await new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Supermemory.APIUserAbortError()),
            { once: true },
          );
        });
      }
      return PROFILE_RESPONSE;
    });
    const client = new SupermemoryClient({
      apiKey: "fixture-key",
      timeoutMs: 100,
      maxReadRetries: 1,
      sdk: fakeSdk({ profile }),
    });

    const result = client.getOwnerProfile(CONTAINER_TAG, caller.signal);
    await vi.runAllTimersAsync();

    await expect(result).resolves.toEqual(PROFILE_RESPONSE.profile);
    expect(attemptSignals).toHaveLength(2);
    expect(attemptSignals[0]).not.toBe(attemptSignals[1]);
    expect(attemptSignals[0]?.aborted).toBe(true);
    expect(wasAbortedAtInvocation).toEqual([false, false]);
    expect(removeListener.mock.calls.map((call) => call[1])).toEqual(
      addListener.mock.calls.map((call) => call[1]),
    );
    const attemptTimeouts = setTimeoutSpy.mock.results.flatMap((result, index) =>
      setTimeoutSpy.mock.calls[index]?.[1] === 100 ? [result.value] : [],
    );
    expect(attemptTimeouts).toHaveLength(2);
    for (const timeout of attemptTimeouts) {
      expect(clearTimeoutSpy).toHaveBeenCalledWith(timeout);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports an exhausted attempt timeout separately from caller cancellation", async () => {
    vi.useFakeTimers();
    const profile = vi.fn<FakeSdkMethod>(async (_body, options) => {
      const signal = options?.signal;
      if (signal === undefined || signal === null) {
        throw new Error("Missing attempt signal.");
      }
      return await new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new Supermemory.APIUserAbortError()),
          { once: true },
        );
      });
    });
    const client = new SupermemoryClient({
      apiKey: "fixture-key",
      timeoutMs: 100,
      maxReadRetries: 0,
      sdk: fakeSdk({ profile }),
    });

    const result = client.getOwnerProfile(CONTAINER_TAG);
    const rejection = expect(result).rejects.toMatchObject({
      code: "MEMORY_PROVIDER_TIMEOUT",
      retryable: true,
    });
    await vi.runAllTimersAsync();

    await rejection;
    expect(profile).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels immediately without starting any later attempt", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const profile = vi.fn<FakeSdkMethod>(async (_body, options) => {
      const signal = options?.signal;
      if (signal === undefined || signal === null) {
        throw new Error("Missing attempt signal.");
      }
      return await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    });
    const client = new SupermemoryClient({
      apiKey: "fixture-key",
      timeoutMs: 100,
      maxReadRetries: 2,
      sdk: fakeSdk({ profile }),
    });

    const result = client.getOwnerProfile(CONTAINER_TAG, caller.signal);
    const rejection = expect(result).rejects.toMatchObject({
      code: "MEMORY_PROVIDER_ABORTED",
      retryable: false,
    });
    caller.abort(new Error("turn superseded"));

    await rejection;
    await vi.runAllTimersAsync();
    expect(profile).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts retry backoff and prevents the next attempt", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const caller = new AbortController();
    const profile = vi.fn<FakeSdkMethod>().mockRejectedValue(new Error("offline"));
    const client = new SupermemoryClient({
      apiKey: "fixture-key",
      timeoutMs: 100,
      maxReadRetries: 2,
      sdk: fakeSdk({ profile }),
    });

    const result = client.getOwnerProfile(CONTAINER_TAG, caller.signal);
    const rejection = expect(result).rejects.toMatchObject({
      code: "MEMORY_PROVIDER_ABORTED",
      retryable: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(profile).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    caller.abort(new Error("turn superseded"));

    await rejection;
    expect(profile).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the exact configured maximum attempt count", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const request = vi.fn<typeof fetch>(async () =>
      new Response("unavailable", { status: 503 }),
    );
    const client = new SupermemoryClient({
      apiKey: "fixture-key",
      fetchImplementation: request,
      maxReadRetries: 2,
    });

    const result = client.listMemories({ containerTag: CONTAINER_TAG, limit: 10 });
    const rejection = expect(result).rejects.toMatchObject({
      code: "MEMORY_PROVIDER_UNAVAILABLE",
      retryable: true,
    });
    await vi.runAllTimersAsync();

    await rejection;
    expect(request).toHaveBeenCalledTimes(3);
    const backoffDelays = setTimeoutSpy.mock.calls
      .map((call) => call[1])
      .filter((delay): delay is number =>
        typeof delay === "number" && delay < 1_500
      );
    expect(backoffDelays).toHaveLength(2);
    expect(backoffDelays[1]).toBeGreaterThan(backoffDelays[0] ?? 0);
    expect(backoffDelays.every((delay) => delay <= 1_000)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries search with fresh application signals and SDK retries disabled", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const retrySettings: Array<number | undefined> = [];
    const search = vi.fn<FakeSdkMethod>(async (_body, options) => {
      if (options?.signal === undefined || options.signal === null) {
        throw new Error("Missing attempt signal.");
      }
      signals.push(options.signal);
      retrySettings.push(options.maxRetries);
      if (signals.length === 1) {
        throw new Error("offline");
      }
      return SEARCH_RESPONSE;
    });
    const client = new SupermemoryClient({
      apiKey: "fixture-key",
      maxReadRetries: 1,
      sdk: fakeSdk({ search }),
    });

    const result = client.searchMemories({
      containerTag: CONTAINER_TAG,
      query: "preferences",
      limit: 5,
    });
    await vi.runAllTimersAsync();

    await expect(result).resolves.toEqual([]);
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(retrySettings).toEqual([0, 0]);
  });

  it("releases a failed response body before retrying list", async () => {
    vi.useFakeTimers();
    let released = false;
    let calls = 0;
    const request: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(
          new ReadableStream({
            cancel() {
              released = true;
            },
          }),
          { status: 503 },
        );
      }
      expect(released).toBe(true);
      return new Response(JSON.stringify(LIST_RESPONSE), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const client = new SupermemoryClient({
      apiKey: "fixture-key",
      fetchImplementation: request,
      maxReadRetries: 1,
    });

    const result = client.listMemories({ containerTag: CONTAINER_TAG, limit: 10 });
    await vi.runAllTimersAsync();

    await expect(result).resolves.toEqual([]);
    expect(calls).toBe(2);
    expect(released).toBe(true);
  });

  it.each([
    [400, "MEMORY_PROVIDER_REJECTED"],
    [401, "MEMORY_PROVIDER_AUTH_FAILED"],
    [403, "MEMORY_PROVIDER_AUTH_FAILED"],
    [404, "MEMORY_PROVIDER_REJECTED"],
    [408, "MEMORY_PROVIDER_REJECTED"],
    [409, "MEMORY_PROVIDER_REJECTED"],
    [422, "MEMORY_PROVIDER_REJECTED"],
  ] as const)("does not retry SDK HTTP %i failures", async (status, code) => {
    const profile = vi.fn<FakeSdkMethod>().mockRejectedValue(
      Supermemory.APIError.generate(status, {}, undefined, new Headers()),
    );
    const client = new SupermemoryClient({
      apiKey: "fixture-key",
      maxReadRetries: 2,
      sdk: fakeSdk({ profile }),
    });

    await expect(client.getOwnerProfile(CONTAINER_TAG)).rejects.toMatchObject({
      code,
      retryable: false,
    });
    expect(profile).toHaveBeenCalledTimes(1);
  });

  it.each([
    [400, "MEMORY_PROVIDER_REJECTED", false],
    [401, "MEMORY_PROVIDER_AUTH_FAILED", false],
    [403, "MEMORY_PROVIDER_AUTH_FAILED", false],
    [404, "MEMORY_PROVIDER_REJECTED", false],
    [408, "MEMORY_PROVIDER_REJECTED", false],
    [409, "MEMORY_PROVIDER_REJECTED", false],
    [422, "MEMORY_PROVIDER_REJECTED", false],
    [429, "MEMORY_PROVIDER_RATE_LIMITED", true],
  ] as const)(
    "classifies direct HTTP %i failures without an SDK retry loop",
    async (status, code, retryable) => {
      const request = vi.fn<typeof fetch>(async () =>
        new Response("rejected", { status }),
      );
      const client = new SupermemoryClient({
        apiKey: "fixture-key",
        fetchImplementation: request,
        maxReadRetries: 0,
      });

      await expect(
        client.listMemories({ containerTag: CONTAINER_TAG, limit: 10 }),
      ).rejects.toMatchObject({ code, retryable });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it("classifies rate limits separately and retries them", async () => {
    vi.useFakeTimers();
    const profile = vi
      .fn<FakeSdkMethod>()
      .mockRejectedValueOnce(
        Supermemory.APIError.generate(429, {}, undefined, new Headers()),
      )
      .mockResolvedValueOnce(PROFILE_RESPONSE);
    const client = new SupermemoryClient({
      apiKey: "fixture-key",
      maxReadRetries: 1,
      sdk: fakeSdk({ profile }),
    });

    const result = client.getOwnerProfile(CONTAINER_TAG);
    await vi.runAllTimersAsync();

    await expect(result).resolves.toEqual(PROFILE_RESPONSE.profile);
    expect(profile).toHaveBeenCalledTimes(2);

    const rejectedProfile = vi.fn<FakeSdkMethod>().mockRejectedValue(
      Supermemory.APIError.generate(429, {}, undefined, new Headers()),
    );
    const rejectedClient = new SupermemoryClient({
      apiKey: "fixture-key",
      maxReadRetries: 0,
      sdk: fakeSdk({ profile: rejectedProfile }),
    });
    await expect(rejectedClient.getOwnerProfile(CONTAINER_TAG)).rejects.toMatchObject({
      code: "MEMORY_PROVIDER_RATE_LIMITED",
      retryable: true,
    });
  });

  it("keeps every semantic write to one application and SDK attempt", async () => {
    const directCalls: string[] = [];
    const request: typeof fetch = async (url) => {
      directCalls.push(String(url));
      return new Response("unavailable", { status: 503 });
    };
    const updateMemory = vi
      .fn<FakeSdkMethod>()
      .mockRejectedValue(new Error("offline"));
    const forget = vi.fn<FakeSdkMethod>().mockRejectedValue(new Error("offline"));
    const client = new SupermemoryClient({
      apiKey: "fixture-key",
      fetchImplementation: request,
      maxReadRetries: 2,
      sdk: fakeSdk({ updateMemory, forget }),
    });

    await expect(
      client.createMemories({
        containerTag: CONTAINER_TAG,
        memories: [
          {
            content: "The owner prefers concise summaries.",
            isStatic: true,
            metadata: { scope: "owner", contentHash: "fixture" },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "MEMORY_PROVIDER_UNAVAILABLE" });
    await expect(
      client.updateMemory({
        containerTag: CONTAINER_TAG,
        memoryId: "memory-1",
        content: "Updated preference",
        metadata: { scope: "owner" },
      }),
    ).rejects.toMatchObject({ code: "MEMORY_PROVIDER_UNAVAILABLE" });
    await expect(
      client.forgetMemory({
        containerTag: CONTAINER_TAG,
        memoryId: "memory-1",
        reason: "Owner requested deletion",
      }),
    ).rejects.toMatchObject({ code: "MEMORY_PROVIDER_UNAVAILABLE" });
    await expect(
      client.deleteContainer({ containerTag: CONTAINER_TAG }),
    ).rejects.toMatchObject({ code: "MEMORY_PROVIDER_UNAVAILABLE" });

    expect(directCalls).toHaveLength(2);
    expect(
      directCalls.filter((url) => url.endsWith("/v4/memories")),
    ).toHaveLength(1);
    expect(
      directCalls.filter((url) => url.includes("/v3/container-tags/")),
    ).toHaveLength(1);
    expect(updateMemory).toHaveBeenCalledTimes(1);
    expect(forget).toHaveBeenCalledTimes(1);
    expect(updateMemory.mock.calls[0]?.[1]).toMatchObject({ maxRetries: 0 });
    expect(forget.mock.calls[0]?.[1]).toMatchObject({ maxRetries: 0 });
  });

});
