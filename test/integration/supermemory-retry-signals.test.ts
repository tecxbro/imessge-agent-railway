import Supermemory from "supermemory";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SupermemoryClient,
  ownerContainerTag,
} from "../../src/memory/supermemory-client.js";

const CONTAINER_TAG = ownerContainerTag(
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-00000000000a",
);
const PROFILE_RESPONSE = {
  profile: { static: ["The owner prefers concise summaries."], dynamic: [] },
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Supermemory application and SDK retry integration", () => {
  it("never stacks SDK retries inside application read attempts", async () => {
    vi.useFakeTimers();
    const retryCounts: Array<string | null> = [];
    let calls = 0;
    const request: typeof fetch = async (_url, init) => {
      calls += 1;
      retryCounts.push(new Headers(init?.headers).get("x-stainless-retry-count"));
      if (calls === 1) {
        return new Response("unavailable", { status: 503 });
      }
      return new Response(JSON.stringify(PROFILE_RESPONSE), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const sdk = new Supermemory({
      apiKey: "fixture-key",
      baseURL: "https://supermemory.invalid",
      fetch: request,
      maxRetries: 2,
      logLevel: "off",
    });
    const client = new SupermemoryClient({
      apiKey: "fixture-key",
      maxReadRetries: 1,
      sdk,
    });

    const result = client.getOwnerProfile(CONTAINER_TAG);
    await vi.runAllTimersAsync();

    await expect(result).resolves.toEqual(PROFILE_RESPONSE.profile);
    expect(calls).toBe(2);
    expect(retryCounts).toEqual(["0", "0"]);
  });
});
