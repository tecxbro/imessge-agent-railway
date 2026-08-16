import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import { renderDashboardScript } from "../../src/http/deployment-page.js";

interface DashboardHarnessOptions {
  provider?: "photon" | "chatgpt";
  photonState?: string;
  popupBlocked?: boolean;
}

function createDashboardHarness(options: DashboardHarnessOptions = {}) {
  const provider = options.provider ?? "photon";
  const authListeners: Array<
    (event: { currentTarget: { href: string }; preventDefault(): void }) => void
  > = [];
  const scheduled: Array<() => void | Promise<void>> = [];
  const reload = vi.fn();
  const focus = vi.fn();
  const preventDefault = vi.fn();
  const replace = vi.fn();
  const stateElement = { textContent: "Waiting for authentication" };
  const authLink = {
    href:
      provider === "photon"
        ? "https://app.photon.codes/device"
        : "https://auth.openai.com/codex/device",
    addEventListener(
      type: string,
      listener: (
        event: {
          currentTarget: { href: string };
          preventDefault(): void;
        },
      ) => void,
    ) {
      if (type === "click") authListeners.push(listener);
    },
  };
  const popup = {
    closed: false,
    opener: {} as unknown,
    location: { replace },
    close: vi.fn(),
  };
  popup.close.mockImplementation(() => {
    popup.closed = true;
  });

  const windowObject = {
    open: vi.fn(() => (options.popupBlocked === true ? null : popup)),
    location: { reload },
    focus,
    setTimeout: vi.fn((callback: () => void | Promise<void>) => {
      scheduled.push(callback);
      return scheduled.length;
    }),
    clearTimeout: vi.fn(),
    addEventListener: vi.fn(),
  };
  const documentObject = {
    currentScript: { dataset: { polling: "true" } },
    body: {
      dataset: {
        photonState:
          provider === "photon" ? "awaiting_authorization" : "connected",
        chatgptState:
          provider === "chatgpt" ? "awaiting_authorization" : "connected",
        ready: "false",
      },
    },
    getElementById(id: string) {
      return id === "photon-state" ? stateElement : null;
    },
    querySelectorAll() {
      return [authLink];
    },
  };
  const fetchImplementation = vi.fn(async (url: string) => ({
    json: async () => {
      if (url.includes("photon/status")) {
        return {
          state:
            provider === "photon"
              ? (options.photonState ?? "connected")
              : "connected",
        };
      }
      if (url.includes("chatgpt/status")) return { state: "connected" };
      return { ready: false };
    },
  }));

  runInNewContext(renderDashboardScript(), {
    document: documentObject,
    fetch: fetchImplementation,
    window: windowObject,
  });

  return {
    authLink,
    authListeners,
    focus,
    popup,
    preventDefault,
    reload,
    replace,
    scheduled,
    stateElement,
    windowObject,
  };
}

describe("dashboard authentication popup", () => {
  it.each(["photon", "chatgpt"] as const)(
    "closes the %s popup and returns focus after authentication",
    async (provider) => {
      const harness = createDashboardHarness({ provider });

      harness.authListeners[0]!({
        currentTarget: harness.authLink,
        preventDefault: harness.preventDefault,
      });

      expect(harness.preventDefault).toHaveBeenCalledOnce();
      expect(harness.popup.opener).toBeNull();
      expect(harness.replace).toHaveBeenCalledWith(harness.authLink.href);

      await harness.scheduled.shift()!();

      expect(harness.popup.close).toHaveBeenCalledOnce();
      expect(harness.focus).toHaveBeenCalledOnce();
      expect(harness.reload).toHaveBeenCalledOnce();
    },
  );

  it("keeps the normal external-link fallback when a popup is blocked", () => {
    const harness = createDashboardHarness({ popupBlocked: true });

    harness.authListeners[0]!({
      currentTarget: harness.authLink,
      preventDefault: harness.preventDefault,
    });

    expect(harness.windowObject.open).toHaveBeenCalledOnce();
    expect(harness.preventDefault).not.toHaveBeenCalled();
  });

  it("keeps polling through Photon provisioning without losing the popup", async () => {
    const harness = createDashboardHarness({ photonState: "provisioning" });

    harness.authListeners[0]!({
      currentTarget: harness.authLink,
      preventDefault: harness.preventDefault,
    });
    await harness.scheduled.shift()!();

    expect(harness.stateElement.textContent).toBe("Finishing setup");
    expect(harness.popup.close).not.toHaveBeenCalled();
    expect(harness.reload).not.toHaveBeenCalled();
    expect(harness.scheduled).toHaveLength(1);
  });
});
