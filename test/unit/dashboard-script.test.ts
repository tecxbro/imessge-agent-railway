import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import { renderDashboardScript } from "../../src/http/deployment-page.js";

interface DashboardHarnessOptions {
  clipboardReject?: boolean;
  provider?: "photon" | "chatgpt";
  photonState?: string;
  popupBlocked?: boolean;
  userCode?: string;
}

function createDashboardHarness(options: DashboardHarnessOptions = {}) {
  const provider = options.provider ?? "photon";
  type CopyControl = {
    textContent: string;
    dataset: { copyTarget: string; copyStatus: string };
    addEventListener(
      type: string,
      listener: (event: { currentTarget: CopyControl }) => Promise<void> | void,
    ): void;
  };
  const authListeners: Array<
    (event: { currentTarget: { href: string }; preventDefault(): void }) => void
  > = [];
  const copyListeners: Array<
    (event: { currentTarget: CopyControl }) => Promise<void> | void
  > = [];
  const scheduled: Array<() => void | Promise<void>> = [];
  const reload = vi.fn();
  const focus = vi.fn();
  const preventDefault = vi.fn();
  const replace = vi.fn();
  const stateElement = { textContent: "Waiting for authentication" };
  const codeElement = {
    textContent:
      options.userCode ??
      (provider === "photon" ? "ABCD-EFGH" : "WXYZ-1234"),
  };
  const copyStatus = { textContent: "" };
  const copyButton: CopyControl = {
    textContent: "Copy code",
    dataset: {
      copyTarget: `${provider}-device-code`,
      copyStatus: `${provider}-copy-status`,
    },
    addEventListener(type, listener) {
      if (type === "click") copyListeners.push(listener);
    },
  };
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
  const writeText = options.clipboardReject
    ? vi.fn(async () => {
        throw new Error("Clipboard access denied");
      })
    : vi.fn(async (_code: string) => undefined);
  const documentObject = {
    currentScript: { dataset: { polling: "true" } },
    querySelector: () => null,
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
      if (id === "photon-state") return stateElement;
      if (id === `${provider}-device-code`) return codeElement;
      if (id === `${provider}-copy-status`) return copyStatus;
      return null;
    },
    querySelectorAll(selector: string) {
      if (selector === "[data-auth-link]") return [authLink];
      if (selector === "[data-copy-target]") return [copyButton];
      return [];
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
    navigator: { clipboard: { writeText } },
    window: windowObject,
  });

  return {
    authLink,
    authListeners,
    codeElement,
    copyButton,
    copyListeners,
    copyStatus,
    focus,
    fetchImplementation,
    popup,
    preventDefault,
    reload,
    replace,
    scheduled,
    stateElement,
    windowObject,
    writeText,
  };
}

function createOwnerFormHarness(responseOk = true) {
  type OwnerForm = {
    addEventListener(
      type: string,
      listener: (event: SubmitEvent) => Promise<void> | void,
    ): void;
    querySelector(): { disabled: boolean };
    setAttribute: ReturnType<typeof vi.fn>;
    removeAttribute: ReturnType<typeof vi.fn>;
  };
  type SubmitEvent = {
    preventDefault(): void;
    currentTarget: OwnerForm;
  };
  let submit: ((event: SubmitEvent) => Promise<void> | void) | undefined;
  let toggleCountry: (() => void) | undefined;
  let changeCountry: (() => void) | undefined;
  const reload = vi.fn();
  const submitButton = { disabled: false };
  const input = {
    value: "(415) 555-0123",
    placeholder: "(415) 555-0123",
    focus: vi.fn(),
    setAttribute: vi.fn(),
    removeAttribute: vi.fn(),
  };
  const country = {
    value: "",
    disabled: true,
    required: false,
    selectedIndex: 0,
    options: [
      { dataset: {} },
      { dataset: { callingCode: "44" } },
    ],
    focus: vi.fn(),
    setAttribute: vi.fn(),
    removeAttribute: vi.fn(),
    addEventListener(type: string, listener: () => void) {
      if (type === "change") changeCountry = listener;
    },
  };
  const fields = { hidden: true };
  const prefix = { textContent: "+1", hidden: false };
  const help = { textContent: "U.S. number — we’ll add +1." };
  const error = { textContent: "" };
  const attributes = new Map([["aria-expanded", "false"]]);
  const toggle = {
    textContent: "Not in the U.S.?",
    getAttribute(name: string) {
      return attributes.get(name) ?? null;
    },
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
    },
    addEventListener(type: string, listener: () => void) {
      if (type === "click") toggleCountry = listener;
    },
  };
  const form: OwnerForm = {
    addEventListener(
      type: string,
      listener: (event: SubmitEvent) => Promise<void> | void,
    ) {
      if (type === "submit") submit = listener;
    },
    querySelector: () => submitButton,
    setAttribute: vi.fn(),
    removeAttribute: vi.fn(),
  };
  const fetchImplementation = vi.fn(async () => ({
    ok: responseOk,
    json: async () =>
      responseOk
        ? { state: "configured", maskedPhoneNumber: "••••••0123" }
        : { error: "OWNER_PHONE_NUMBER_INVALID" },
  }));

  runInNewContext(renderDashboardScript(), {
    document: {
      currentScript: { dataset: { polling: "false" } },
      querySelector: () => null,
      querySelectorAll: () => [],
      body: { dataset: {} },
      getElementById(id: string) {
        if (id === "owner-form") return form;
        if (id === "owner-phone-number") return input;
        if (id === "owner-country") return country;
        if (id === "owner-international-fields") return fields;
        if (id === "owner-phone-prefix") return prefix;
        if (id === "owner-format-help") return help;
        if (id === "owner-country-toggle") return toggle;
        if (id === "owner-error") return error;
        return null;
      },
    },
    fetch: fetchImplementation,
    window: {
      location: { reload },
      addEventListener: vi.fn(),
      clearTimeout: vi.fn(),
    },
  });

  return {
    changeCountry: () => changeCountry!(),
    country,
    error,
    fetchImplementation,
    fields,
    help,
    input,
    prefix,
    reload,
    submit: async () => {
      const preventDefault = vi.fn();
      await submit!({ preventDefault, currentTarget: form });
      expect(preventDefault).toHaveBeenCalledOnce();
    },
    toggle,
    toggleCountry: () => toggleCountry!(),
  };
}

function createModelSettingsHarness() {
  type Listener = (event?: { preventDefault(): void }) => void | Promise<void>;
  const listeners = new Map<string, Listener>();
  const createText = () => ({ textContent: "", hidden: false });
  const createSelect = (id: string) => ({
    id,
    value: "",
    disabled: true,
    options: [] as Array<{ value: string; textContent: string; title: string }>,
    replaceChildren() {
      this.options = [];
      this.value = "";
    },
    append(option: { value: string; textContent: string; title: string }) {
      this.options.push(option);
      if (!this.value) this.value = option.value;
    },
    addEventListener(type: string, listener: Listener) {
      listeners.set(`${id}:${type}`, listener);
    },
  });
  const modelSelect = createSelect("model-select");
  const effortSelect = createSelect("effort-select");
  const form = {
    addEventListener(type: string, listener: Listener) {
      listeners.set(`form:${type}`, listener);
    },
    setAttribute: vi.fn(),
    removeAttribute: vi.fn(),
  };
  const restore = {
    disabled: true,
    addEventListener(type: string, listener: Listener) {
      listeners.set(`restore:${type}`, listener);
    },
  };
  const submit = { disabled: true };
  const elements: Record<string, unknown> = {
    "advanced-settings": {},
    "model-select": modelSelect,
    "effort-select": effortSelect,
    "model-settings-form": form,
    "restore-luna-default": restore,
    "model-settings-status": createText(),
    "chatgpt-plan": createText(),
    "active-model": createText(),
    "active-effort": createText(),
    "preferred-model": createText(),
    "preferred-model-row": { hidden: true },
    "model-fallback-explanation": { textContent: "", hidden: true },
  };
  const settings = {
    planType: "plus",
    preferred: { modelId: "gpt-5.6-luna", reasoningEffort: "high" },
    effective: { modelId: "gpt-5.6-terra", reasoningEffort: "low" },
    selectionState: "fallback",
    availableModels: [
      {
        id: "gpt-5.6-luna",
        displayName: "GPT-5.6 Luna",
        supportedReasoningEfforts: [
          { reasoningEffort: "medium", description: "Default" },
          { reasoningEffort: "high", description: "More reasoning" },
        ],
        defaultReasoningEffort: "medium",
      },
      {
        id: "gpt-5.6-terra",
        displayName: "GPT-5.6 Terra",
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "Fast" },
        ],
        defaultReasoningEffort: "low",
      },
    ],
  };
  const fetchImplementation = vi.fn(async (_url: string, init?: RequestInit) => ({
    ok: true,
    json: async () =>
      init?.method === "PUT"
        ? {
            ...settings,
            preferred: { modelId: "gpt-5.6-luna", reasoningEffort: "high" },
            effective: { modelId: "gpt-5.6-luna", reasoningEffort: "high" },
            selectionState: "preferred",
          }
        : settings,
  }));

  runInNewContext(renderDashboardScript(), {
    document: {
      currentScript: { dataset: { polling: "false" } },
      body: { dataset: {} },
      createElement: () => ({ value: "", textContent: "", title: "" }),
      getElementById: (id: string) => elements[id] ?? null,
      querySelector: (selector: string) =>
        selector === '#model-settings-form button[type="submit"]'
          ? submit
          : null,
      querySelectorAll: () => [],
    },
    fetch: fetchImplementation,
    window: {
      addEventListener: vi.fn(),
      clearTimeout: vi.fn(),
    },
  });

  return {
    effortSelect,
    elements,
    fetchImplementation,
    listeners,
    modelSelect,
    restore,
    submit,
  };
}

describe("dashboard authentication code copy", () => {
  it.each([
    { provider: "photon" as const, userCode: "ABCD-EFGH" },
    { provider: "chatgpt" as const, userCode: "WXYZ-1234" },
  ])("copies the exact $provider code locally", async ({ provider, userCode }) => {
    const harness = createDashboardHarness({ provider, userCode });

    await harness.copyListeners[0]!({ currentTarget: harness.copyButton });

    expect(harness.writeText).toHaveBeenCalledOnce();
    expect(harness.writeText).toHaveBeenCalledWith(userCode);
    expect(harness.copyButton.textContent).toBe("Copied");
    expect(harness.copyStatus.textContent).toBe(
      "Authentication code copied.",
    );
    expect(harness.fetchImplementation).not.toHaveBeenCalled();
  });

  it("does not copy surrounding whitespace", async () => {
    const harness = createDashboardHarness({ userCode: "ABCD-EFGH" });
    harness.codeElement.textContent = "\n  ABCD-EFGH\t ";

    await harness.copyListeners[0]!({ currentTarget: harness.copyButton });

    expect(harness.writeText).toHaveBeenCalledWith("ABCD-EFGH");
  });

  it("shows manual-copy guidance when clipboard access fails", async () => {
    const harness = createDashboardHarness({ clipboardReject: true });

    await harness.copyListeners[0]!({ currentTarget: harness.copyButton });

    expect(harness.copyButton.textContent).toBe("Copy code");
    expect(harness.copyStatus.textContent).toBe(
      "Could not copy. Select the code and copy it manually.",
    );
    expect(harness.fetchImplementation).not.toHaveBeenCalled();
  });
});

describe("dashboard authentication popup", () => {
  it("loads account options, changes efforts with the model, and restores Luna High", async () => {
    const harness = createModelSettingsHarness();
    await vi.waitFor(() => expect(harness.modelSelect.options).toHaveLength(2));

    expect(harness.modelSelect.value).toBe("gpt-5.6-luna");
    expect(harness.effortSelect.options.map((option) => option.value)).toEqual([
      "medium",
      "high",
    ]);
    expect(harness.effortSelect.value).toBe("high");
    expect(harness.restore.disabled).toBe(false);
    expect(harness.submit.disabled).toBe(false);
    expect(
      harness.elements["model-fallback-explanation"],
    ).toMatchObject({
      hidden: false,
      textContent:
        "GPT-5.6 Luna High is not currently available for this ChatGPT account.",
    });

    harness.modelSelect.value = "gpt-5.6-terra";
    await harness.listeners.get("model-select:change")?.();
    expect(harness.effortSelect.options.map((option) => option.value)).toEqual([
      "low",
    ]);

    await harness.listeners.get("restore:click")?.();
    await vi.waitFor(() =>
      expect(harness.fetchImplementation).toHaveBeenCalledWith(
        "/api/settings/model",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({
            modelId: "gpt-5.6-luna",
            reasoningEffort: "high",
          }),
        }),
      ),
    );
  });

  it("uses same-origin setup requests without a password or CSRF credential", () => {
    const script = renderDashboardScript();

    expect(script).toContain('credentials: "same-origin"');
    expect(script).not.toContain("X-CSRF-Token");
    expect(script).not.toContain("csrfToken");
    expect(script).toContain('body: JSON.stringify({})');
    expect(script).toContain('fetch("/api/setup/owner"');
    expect(script).toContain("JSON.stringify({ countryCode, phoneNumber })");
    expect(script).not.toContain("+14155550123");
    expect(script).not.toContain("x-agent-setup");
  });

  it("submits the owner phone from the dashboard and clears the browser field immediately", async () => {
    const harness = createOwnerFormHarness();

    await harness.submit();

    expect(harness.input.value).toBe("");
    expect(harness.fetchImplementation).toHaveBeenCalledWith(
      "/api/setup/owner",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({
          countryCode: "US",
          phoneNumber: "(415) 555-0123",
        }),
      }),
    );
    expect(harness.reload).toHaveBeenCalledOnce();
  });

  it("reveals international entry, updates the calling code, and submits the selected country", async () => {
    const harness = createOwnerFormHarness();

    harness.toggleCountry();

    expect(harness.fields.hidden).toBe(false);
    expect(harness.country.disabled).toBe(false);
    expect(harness.country.required).toBe(true);
    expect(harness.country.focus).toHaveBeenCalledOnce();
    expect(harness.toggle.getAttribute("aria-expanded")).toBe("true");
    expect(harness.toggle.textContent).toBe("Use a U.S. number");
    expect(harness.help.textContent).toContain("country code is optional");

    harness.country.value = "GB";
    harness.country.selectedIndex = 1;
    harness.changeCountry();
    harness.input.value = "020 7183 8750";
    expect(harness.prefix.textContent).toBe("+44");
    expect(harness.prefix.hidden).toBe(false);

    await harness.submit();
    expect(harness.fetchImplementation).toHaveBeenCalledWith(
      "/api/setup/owner",
      expect.objectContaining({
        body: JSON.stringify({
          countryCode: "GB",
          phoneNumber: "020 7183 8750",
        }),
      }),
    );
  });

  it("requires a country in international mode and can switch back to the U.S.", async () => {
    const harness = createOwnerFormHarness();

    harness.toggleCountry();
    await harness.submit();
    expect(harness.fetchImplementation).not.toHaveBeenCalled();
    expect(harness.error.textContent).toBe("Select your country or region.");
    expect(harness.country.focus).toHaveBeenCalledTimes(2);

    harness.toggleCountry();
    expect(harness.fields.hidden).toBe(true);
    expect(harness.country.disabled).toBe(true);
    expect(harness.country.required).toBe(false);
    expect(harness.country.value).toBe("");
    expect(harness.prefix.textContent).toBe("+1");
    expect(harness.toggle.getAttribute("aria-expanded")).toBe("false");
    expect(harness.input.focus).toHaveBeenCalledOnce();
  });

  it("shows the selected-country validation error without echoing the raw number", async () => {
    const harness = createOwnerFormHarness(false);

    await harness.submit();

    expect(harness.input.value).toBe("");
    expect(harness.error.textContent).toBe(
      "Enter a valid phone number for the selected country.",
    );
    expect(harness.error.textContent).not.toContain("(415) 555-0123");
  });

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
