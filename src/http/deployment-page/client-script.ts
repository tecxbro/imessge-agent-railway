export function renderDashboardScript(): string {
  return `(() => {
  const script = document.currentScript;
  let timer;
  let authWindow;
  const reload = () => window.location.reload();
  const hasOpenAuthWindow = () => {
    try {
      return Boolean(authWindow && !authWindow.closed);
    } catch {
      return false;
    }
  };
  const closeAuthWindow = () => {
    try {
      if (authWindow && !authWindow.closed) authWindow.close();
    } catch {}
    authWindow = undefined;
  };
  const returnToDashboard = () => {
    closeAuthWindow();
    window.focus();
    reload();
  };
  function setAuthenticationStatus(control, message) {
    const statusId = control.dataset.authStatus;
    const status = statusId ? document.getElementById(statusId) : null;
    if (status) status.textContent = message;
  }
  function openAuthentication(event) {
    const control = event.currentTarget;
    event.preventDefault();
    setAuthenticationStatus(control, "");
    closeAuthWindow();

    const width = 560;
    const height = 760;
    const screenX = Number.isFinite(window.screenX) ? window.screenX : 0;
    const screenY = Number.isFinite(window.screenY) ? window.screenY : 0;
    const outerWidth = Number.isFinite(window.outerWidth)
      ? window.outerWidth
      : width;
    const outerHeight = Number.isFinite(window.outerHeight)
      ? window.outerHeight
      : height;
    const left = Math.max(0, Math.round(screenX + (outerWidth - width) / 2));
    const top = Math.max(0, Math.round(screenY + (outerHeight - height) / 2));
    const popup = window.open(
      control.href,
      "_blank",
      [
        "popup=yes",
        "width=" + width,
        "height=" + height,
        "left=" + left,
        "top=" + top,
        "resizable=yes",
        "scrollbars=yes"
      ].join(",")
    );
    if (!popup) {
      setAuthenticationStatus(
        control,
        "Pop-up blocked. Allow pop-ups for this site, then try again."
      );
      return;
    }

    authWindow = popup;
    try {
      popup.opener = null;
    } catch {}
    try {
      popup.focus();
    } catch {}
  }
  async function copyAuthenticationCode(event) {
    const control = event.currentTarget;
    const targetId = control.dataset.copyTarget;
    const statusId = control.dataset.copyStatus;
    const status = statusId ? document.getElementById(statusId) : null;
    const codeElement = targetId ? document.getElementById(targetId) : null;
    const code = codeElement ? codeElement.textContent.trim() : "";
    try {
      if (!code) throw new Error("Authentication code is unavailable");
      await navigator.clipboard.writeText(code);
      control.textContent = "Copied";
      if (status) status.textContent = "Authentication code copied.";
    } catch {
      control.textContent = "Copy code";
      if (status) {
        status.textContent = "Could not copy. Select the code and copy it manually.";
      }
    }
  }
  async function start(kind) {
    const control = document.getElementById(kind + "-start");
    if (control) control.disabled = true;
    try {
      await fetch("/api/setup/" + kind + "/start", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({})
      });
    } finally {
      reload();
    }
  }
  let availableModels = [];
  function titleCase(value) {
    if (typeof value !== "string" || !value) return "Unknown";
    return value.charAt(0).toUpperCase() + value.slice(1);
  }
  function modelDisplayName(modelId) {
    const model = availableModels.find((candidate) => candidate.id === modelId);
    if (model) return model.displayName;
    const match = /^gpt-([0-9.]+)(?:-(.+))?$/i.exec(modelId);
    if (!match) return modelId;
    const suffix = match[2]
      ? " " + match[2].split("-").map(titleCase).join(" ")
      : "";
    return "GPT-" + match[1] + suffix;
  }
  function selectedModel() {
    const select = document.getElementById("model-select");
    return select
      ? availableModels.find((model) => model.id === select.value)
      : undefined;
  }
  function fillEfforts(model, requestedEffort) {
    const select = document.getElementById("effort-select");
    if (!select) return;
    select.replaceChildren();
    if (!model) {
      select.disabled = true;
      return;
    }
    for (const effort of model.supportedReasoningEfforts) {
      const option = document.createElement("option");
      option.value = effort.reasoningEffort;
      option.textContent = titleCase(effort.reasoningEffort);
      option.title = effort.description;
      select.append(option);
    }
    const supported = model.supportedReasoningEfforts.some(
      (effort) => effort.reasoningEffort === requestedEffort
    );
    select.value = supported ? requestedEffort : model.defaultReasoningEffort;
    select.disabled = false;
  }
  function setModelSettingsUnavailable() {
    for (const id of ["model-select", "effort-select", "restore-luna-default"]) {
      const control = document.getElementById(id);
      if (control) control.disabled = true;
    }
    const submit = document.querySelector('#model-settings-form button[type="submit"]');
    if (submit) submit.disabled = true;
    const status = document.getElementById("model-settings-status");
    if (status) status.textContent = "Model options could not be loaded.";
  }
  function applyModelSettings(settings) {
    availableModels = Array.isArray(settings.availableModels)
      ? settings.availableModels
      : [];
    if (!settings.effective || availableModels.length === 0) {
      setModelSettingsUnavailable();
      return;
    }
    const plan = document.getElementById("chatgpt-plan");
    const activeModel = document.getElementById("active-model");
    const activeEffort = document.getElementById("active-effort");
    const preferredModel = document.getElementById("preferred-model");
    const preferredRow = document.getElementById("preferred-model-row");
    const fallback = document.getElementById("model-fallback-explanation");
    const modelSelect = document.getElementById("model-select");
    const restore = document.getElementById("restore-luna-default");
    const submit = document.querySelector('#model-settings-form button[type="submit"]');
    const status = document.getElementById("model-settings-status");
    if (plan) plan.textContent = titleCase(settings.planType || "unknown");
    if (activeModel) activeModel.textContent = modelDisplayName(settings.effective.modelId);
    if (activeEffort) activeEffort.textContent = titleCase(settings.effective.reasoningEffort);
    if (preferredModel) {
      preferredModel.textContent = modelDisplayName(settings.preferred.modelId) +
        " · " + titleCase(settings.preferred.reasoningEffort);
    }
    if (preferredRow) preferredRow.hidden = settings.selectionState !== "fallback";
    if (fallback) {
      fallback.hidden = settings.selectionState !== "fallback";
      fallback.textContent = settings.selectionState === "fallback"
        ? modelDisplayName(settings.preferred.modelId) + " " +
          titleCase(settings.preferred.reasoningEffort) +
          " is not currently available for this ChatGPT account."
        : "";
    }
    if (modelSelect) {
      modelSelect.replaceChildren();
      for (const model of availableModels) {
        const option = document.createElement("option");
        option.value = model.id;
        option.textContent = model.displayName;
        modelSelect.append(option);
      }
      const preferredAvailable = availableModels.some(
        (model) => model.id === settings.preferred.modelId
      );
      modelSelect.value = preferredAvailable
        ? settings.preferred.modelId
        : settings.effective.modelId;
      modelSelect.disabled = false;
      fillEfforts(
        selectedModel(),
        preferredAvailable
          ? settings.preferred.reasoningEffort
          : settings.effective.reasoningEffort
      );
    }
    if (restore) restore.disabled = false;
    if (submit) submit.disabled = false;
    if (status) status.textContent = "";
  }
  async function loadModelSettings() {
    if (!document.getElementById("advanced-settings")) return;
    try {
      const response = await fetch("/api/settings/model", {
        cache: "no-store",
        credentials: "same-origin"
      });
      if (!response.ok) {
        setModelSettingsUnavailable();
        return;
      }
      applyModelSettings(await response.json());
    } catch {
      setModelSettingsUnavailable();
    }
  }
  async function saveModelSettings(selection) {
    const status = document.getElementById("model-settings-status");
    const form = document.getElementById("model-settings-form");
    if (form) form.setAttribute("aria-busy", "true");
    if (status) status.textContent = "Saving…";
    try {
      const response = await fetch("/api/settings/model", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(selection)
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (status) {
          status.textContent = result.error === "MODEL_SELECTION_STALE"
            ? "Those model options changed. Reload Advanced and choose again."
            : result.error === "MODEL_PAIR_UNAVAILABLE"
              ? "Codex could not use that model and reasoning pair."
              : "Model settings could not be saved.";
        }
        return;
      }
      applyModelSettings(result);
      if (status) status.textContent = "Saved. New message chains will use this model.";
    } catch {
      if (status) status.textContent = "Model settings could not be saved.";
    } finally {
      if (form) form.removeAttribute("aria-busy");
    }
  }
  async function submitModelSettings(event) {
    event.preventDefault();
    const model = document.getElementById("model-select");
    const effort = document.getElementById("effort-select");
    if (!model || !effort) return;
    await saveModelSettings({
      modelId: model.value,
      reasoningEffort: effort.value
    });
  }
  function updatePhonePrefix() {
    const country = document.getElementById("owner-country");
    const prefix = document.getElementById("owner-phone-prefix");
    if (!country || !prefix) return;
    const option = country.options[country.selectedIndex];
    const callingCode = option && option.dataset
      ? option.dataset.callingCode
      : undefined;
    prefix.textContent = callingCode ? "+" + callingCode : "";
    prefix.hidden = !callingCode;
  }
  function setInternationalPhoneEntry(expanded) {
    const fields = document.getElementById("owner-international-fields");
    const country = document.getElementById("owner-country");
    const input = document.getElementById("owner-phone-number");
    const prefix = document.getElementById("owner-phone-prefix");
    const help = document.getElementById("owner-format-help");
    const toggle = document.getElementById("owner-country-toggle");
    if (!fields || !country || !input || !prefix || !help || !toggle) return;
    fields.hidden = !expanded;
    country.disabled = !expanded;
    country.required = expanded;
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.textContent = expanded ? "Use a U.S. number" : "Not in the U.S.?";
    input.placeholder = expanded ? "Phone number" : "(415) 555-0123";
    help.textContent = expanded
      ? "Choose your country, then enter your number. The country code is optional."
      : "U.S. number — we’ll add +1.";
    input.removeAttribute("aria-invalid");
    country.removeAttribute("aria-invalid");
    if (expanded) {
      updatePhonePrefix();
      country.focus();
      return;
    }
    country.value = "";
    prefix.textContent = "+1";
    prefix.hidden = false;
    input.focus();
  }
  async function saveOwner(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const input = document.getElementById("owner-phone-number");
    const country = document.getElementById("owner-country");
    const toggle = document.getElementById("owner-country-toggle");
    const error = document.getElementById("owner-error");
    const button = form.querySelector('button[type="submit"]');
    if (!input || !country || !toggle) return;
    const international = toggle.getAttribute("aria-expanded") === "true";
    const countryCode = international ? country.value : "US";
    if (!input.value.trim()) {
      if (error) error.textContent = "Enter your phone number.";
      input.setAttribute("aria-invalid", "true");
      input.focus();
      return;
    }
    if (!countryCode) {
      if (error) error.textContent = "Select your country or region.";
      country.setAttribute("aria-invalid", "true");
      country.focus();
      return;
    }
    const phoneNumber = input.value;
    input.value = "";
    if (button) button.disabled = true;
    form.setAttribute("aria-busy", "true");
    if (error) error.textContent = "";
    try {
      const response = await fetch("/api/setup/owner", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ countryCode, phoneNumber })
      });
      if (response.ok) {
        reload();
        return;
      }
      const result = await response.json().catch(() => ({}));
      if (error) {
        error.textContent = result.error === "OWNER_PHONE_NUMBER_INVALID"
          ? "Enter a valid phone number for the selected country."
          : "The owner phone number could not be saved. Try again.";
      }
      input.setAttribute("aria-invalid", "true");
      input.focus();
    } catch {
      if (error) error.textContent = "The owner phone number could not be saved. Try again.";
      input.focus();
    } finally {
      if (button) button.disabled = false;
      form.removeAttribute("aria-busy");
    }
  }
  async function refresh() {
    try {
      const [ownerResponse, photonResponse, chatgptResponse, readinessResponse] = await Promise.all([
        fetch("/api/setup/owner/status", { cache: "no-store", credentials: "same-origin" }),
        fetch("/api/setup/photon/status", { cache: "no-store", credentials: "same-origin" }),
        fetch("/api/setup/chatgpt/status", { cache: "no-store", credentials: "same-origin" }),
        fetch("/readyz", { cache: "no-store", credentials: "same-origin" })
      ]);
      const owner = await ownerResponse.json();
      const photon = await photonResponse.json();
      const chatgpt = await chatgptResponse.json();
      const readiness = await readinessResponse.json();
      const ownerState = document.body.dataset.ownerState;
      const photonState = document.body.dataset.photonState;
      const chatgptState = document.body.dataset.chatgptState;
      const authCompleted =
        (photonState === "awaiting_authorization" && photon.state === "connected") ||
        (chatgptState === "awaiting_authorization" && chatgpt.state === "connected");
      if (authCompleted) {
        returnToDashboard();
        return;
      }
      const photonProvisioningInPopup =
        hasOpenAuthWindow() &&
        photonState === "awaiting_authorization" &&
        photon.state === "provisioning";
      const stateChanged =
        (typeof owner.state === "string" && owner.state !== ownerState) ||
        photon.state !== photonState ||
        chatgpt.state !== chatgptState ||
        String(readiness.ready) !== document.body.dataset.ready;
      if (photonProvisioningInPopup) {
        const state = document.getElementById("photon-state");
        if (state) state.textContent = "Finishing setup";
      } else if (stateChanged) {
        closeAuthWindow();
        reload();
        return;
      }
    } catch {}
    timer = window.setTimeout(refresh, 2000);
  }
  const ownerForm = document.getElementById("owner-form");
  if (ownerForm) ownerForm.addEventListener("submit", saveOwner);
  const ownerCountryToggle = document.getElementById("owner-country-toggle");
  if (ownerCountryToggle) {
    ownerCountryToggle.addEventListener("click", () => {
      setInternationalPhoneEntry(
        ownerCountryToggle.getAttribute("aria-expanded") !== "true"
      );
    });
  }
  const ownerCountry = document.getElementById("owner-country");
  if (ownerCountry) ownerCountry.addEventListener("change", updatePhonePrefix);
  const modelSelect = document.getElementById("model-select");
  if (modelSelect) {
    modelSelect.addEventListener("change", () => {
      const model = selectedModel();
      fillEfforts(model, model ? model.defaultReasoningEffort : "medium");
    });
  }
  const modelSettingsForm = document.getElementById("model-settings-form");
  if (modelSettingsForm) {
    modelSettingsForm.addEventListener("submit", (event) => void submitModelSettings(event));
  }
  const restoreLuna = document.getElementById("restore-luna-default");
  if (restoreLuna) {
    restoreLuna.addEventListener("click", () => void saveModelSettings({
      modelId: "gpt-5.6-luna",
      reasoningEffort: "high"
    }));
  }
  for (const kind of ["photon", "chatgpt"]) {
    const control = document.getElementById(kind + "-start");
    if (control) control.addEventListener("click", () => void start(kind));
  }
  for (const control of document.querySelectorAll("[data-auth-link]")) {
    control.addEventListener("click", openAuthentication);
  }
  for (const control of document.querySelectorAll("[data-copy-target]")) {
    control.addEventListener("click", copyAuthenticationCode);
  }
  void loadModelSettings();
  if (script && script.dataset.polling === "true") timer = window.setTimeout(refresh, 2000);
  window.addEventListener("pagehide", () => window.clearTimeout(timer), { once: true });
})();`;
}
