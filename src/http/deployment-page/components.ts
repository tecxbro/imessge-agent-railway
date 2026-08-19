import {
  getCountries,
  getCountryCallingCode,
} from "libphonenumber-js/max";

import type { ChatGptSetupStatus } from "../../agent/codex-app-server-auth.js";
import type { DeploymentIdentityStatus } from "../../runtime/deployment-identity.js";
import type { PhotonSetupStatus } from "../../transport/photon-setup.js";
import {
  ownerStateLabel,
  photonStateLabel,
  type DeploymentPageOptions,
  type DeploymentPageViewModel,
} from "./view-model.js";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const regionDisplayNames = new Intl.DisplayNames(["en"], { type: "region" });

function renderCountryOptions(): string {
  return getCountries()
    .filter((countryCode) => countryCode !== "US")
    .map((countryCode) => ({
      callingCode: getCountryCallingCode(countryCode),
      countryCode,
      name: regionDisplayNames.of(countryCode) ?? countryCode,
    }))
    .sort((left, right) => left.name.localeCompare(right.name, "en"))
    .map(
      ({ callingCode, countryCode, name }) =>
        `<option value="${countryCode}" data-calling-code="${callingCode}">${escapeHtml(name)} (+${callingCode})</option>`,
    )
    .join("");
}

function renderOwnerForm(configured: boolean): string {
  return `<form id="owner-form" class="owner-form" novalidate>
    <label for="owner-phone-number"${configured ? ' class="visually-hidden"' : ""}>${configured ? "New phone number" : "Your phone number"}</label>
    <div id="owner-international-fields" class="country-fields" hidden>
      <label for="owner-country">Country or region</label>
      <select id="owner-country" name="countryCode" aria-describedby="owner-format-help owner-error" disabled>
        <option value="">Select your country or region</option>
        ${renderCountryOptions()}
      </select>
    </div>
    <div class="phone-control">
      <span id="owner-phone-prefix" class="phone-prefix" aria-hidden="true">+1</span>
      <input
        id="owner-phone-number"
        name="phoneNumber"
        type="tel"
        inputmode="tel"
        autocomplete="tel"
        placeholder="(415) 555-0123"
        maxlength="64"
        aria-describedby="owner-help owner-format-help owner-error"
        required
      >
    </div>
    <p id="owner-format-help" class="owner-format-help">U.S. number — we’ll add +1.</p>
    <button id="owner-country-toggle" class="country-toggle" type="button" aria-expanded="false" aria-controls="owner-international-fields">Not in the U.S.?</button>
    <button class="button" type="submit">${configured ? "Save new number" : "Save and continue"}</button>
    <p id="owner-error" class="error" aria-live="polite"></p>
  </form>`;
}

function renderOwnerAction(status: DeploymentIdentityStatus): string {
  if (status.state === "initializing") {
    return `<p class="progress">Loading the saved deployment identity…</p>`;
  }
  if (status.state === "failed") {
    return `<p class="error">Owner setup is unavailable. <code>${escapeHtml(status.code)}</code></p>`;
  }
  if (status.state === "configured") {
    return `<p id="owner-help" class="owner-summary">Only <strong>${escapeHtml(status.maskedPhoneNumber)}</strong> can use this agent.</p>
      <details class="owner-replace">
        <summary>Change phone number</summary>
        ${renderOwnerForm(true)}
      </details>`;
  }
  return `<p id="owner-help" class="owner-help">This is the only phone number allowed to use your agent.</p>
    ${renderOwnerForm(false)}`;
}

function renderAuthenticationCode(
  provider: "photon" | "chatgpt",
  providerLabel: string,
  userCode: string,
): string {
  const codeId = `${provider}-device-code`;
  const statusId = `${provider}-copy-status`;
  return `<div class="device-code-row">
      <code id="${codeId}" class="device-code">${escapeHtml(userCode)}</code>
      <button
        type="button"
        class="button secondary-button copy-code-button"
        data-copy-target="${codeId}"
        data-copy-status="${statusId}"
        title="Copy ${escapeHtml(providerLabel)} authentication code"
      >Copy code</button>
    </div>
    <p id="${statusId}" class="copy-code-status" aria-live="polite"></p>`;
}

function renderPhotonAction(status: PhotonSetupStatus): string {
  if (status.state === "connected") {
    return "";
  }
  if (status.state === "awaiting_authorization") {
    return `<div class="auth-flow">
      <p>Open Photon and enter this one-time code.</p>
      ${renderAuthenticationCode("photon", "Photon", status.userCode)}
      <a
        class="button"
        href="${escapeHtml(status.verificationUrl)}"
        target="_blank"
        rel="noreferrer"
        data-auth-link="photon"
        data-auth-status="photon-auth-status"
        aria-describedby="photon-auth-status"
      >Open Photon</a>
      <p id="photon-auth-status" class="auth-link-status" aria-live="polite"></p>
    </div>`;
  }
  if (status.state === "provisioning") {
    return `<p class="progress">Creating your Photon project and assigning your iMessage number…</p>`;
  }
  const error =
    status.state === "failed"
      ? `<p class="error">Photon setup could not finish. <code>${escapeHtml(status.code)}</code></p>`
      : "";
  return `${error}<button id="photon-start" class="button" type="button">Authenticate with Photon</button>`;
}

function renderChatGptAction(
  status: ChatGptSetupStatus,
  options: DeploymentPageOptions,
): string {
  if (options.authMode === "api_key") {
    return `<p class="progress">This deployment uses a private OpenAI API key.</p>`;
  }
  if (status.state === "connected") {
    return "";
  }
  if (status.state === "awaiting_authorization") {
    return `<div class="auth-flow">
      <p>Open ChatGPT, sign in, and enter this one-time code.</p>
      ${renderAuthenticationCode("chatgpt", "ChatGPT", status.userCode)}
      <a
        class="button"
        href="${escapeHtml(status.verificationUrl)}"
        target="_blank"
        rel="noreferrer"
        data-auth-link="chatgpt"
        data-auth-status="chatgpt-auth-status"
        aria-describedby="chatgpt-auth-status"
      >Sign in with ChatGPT</a>
      <p id="chatgpt-auth-status" class="auth-link-status" aria-live="polite"></p>
    </div>`;
  }
  if (status.state === "starting") {
    return `<p class="progress">Starting secure ChatGPT sign in…</p>`;
  }
  const error =
    status.state === "failed"
      ? `<p class="error">ChatGPT setup could not finish. <code>${escapeHtml(status.code)}</code></p>`
      : "";
  return `${error}<button id="chatgpt-start" class="button" type="button">Connect ChatGPT</button>`;
}

function normalizeAssignedPhoneNumber(
  phoneNumber: string | undefined,
): string | undefined {
  if (phoneNumber === undefined) {
    return undefined;
  }
  const normalized = phoneNumber.replaceAll(/\s/g, "");
  return /^\+\d+$/.test(normalized) ? normalized : undefined;
}

function renderFinalPage(
  phoneNumber: string | undefined,
  maskedOwnerPhoneNumber: string,
  authMode: DeploymentPageOptions["authMode"],
): string {
  const visiblePhoneNumber = phoneNumber?.trim();
  const messagingPhoneNumber = normalizeAssignedPhoneNumber(phoneNumber);
  const number = visiblePhoneNumber
    ? `<div class="agent-start">
        <div class="agent-number">
          <span>Your number:</span>
          <strong>${escapeHtml(visiblePhoneNumber)}</strong>
        </div>
        ${
          messagingPhoneNumber === undefined
            ? ""
            : `<span class="agent-or">or</span>
        <a
          class="button text-agent-button"
          href="sms:${escapeHtml(messagingPhoneNumber)}"
          aria-label="Open Messages to text your iMessage agent"
        >Text agent</a>`
        }
      </div>`
    : "";
  return `<h1>Your iMessage Agent</h1>
    <section class="card ready-card" aria-labelledby="ready-title">
      <h2 id="ready-title" class="visually-hidden">Agent readiness</h2>
      <ul class="ready-list">
        <li>✓ Owner ${escapeHtml(maskedOwnerPhoneNumber)}</li>
        <li>✓ Photon connected</li>
        <li>✓ ${authMode === "chatgpt" ? "ChatGPT" : "OpenAI API key"} connected</li>
        <li>✓ Codex ready</li>
      </ul>
      ${number}
      <p class="ready-message"><strong>Your agent is ready.</strong><br>Send “hi” to get started.</p>
    </section>${authMode === "chatgpt" ? renderAdvancedSettings() : ""}`;
}

function renderAdvancedSettings(): string {
  return `<details id="advanced-settings" class="card advanced-card">
    <summary>Advanced</summary>
    <dl class="model-summary">
      <div>
        <dt>ChatGPT plan</dt>
        <dd id="chatgpt-plan">Loading</dd>
      </div>
      <div id="preferred-model-row" hidden>
        <dt>Preferred</dt>
        <dd id="preferred-model">GPT-5.6 Luna · High</dd>
      </div>
      <div>
        <dt>Active model</dt>
        <dd id="active-model">Loading</dd>
      </div>
      <div>
        <dt>Reasoning</dt>
        <dd id="active-effort">Loading</dd>
      </div>
    </dl>
    <form id="model-settings-form" class="model-settings-form">
      <label for="model-select">Model</label>
      <select id="model-select" disabled></select>
      <label for="effort-select">Reasoning</label>
      <select id="effort-select" disabled></select>
      <div class="model-actions">
        <button class="button" type="submit" disabled>Save model</button>
        <button id="restore-luna-default" class="button secondary-button" type="button" disabled>Use Luna High</button>
      </div>
      <p id="model-fallback-explanation" class="progress" hidden></p>
      <p id="model-settings-status" class="progress" aria-live="polite"></p>
    </form>
  </details>`;
}

export function renderDeploymentPageContent(
  viewModel: DeploymentPageViewModel,
  options: DeploymentPageOptions,
  ownerStatus: DeploymentIdentityStatus,
  photonStatus: PhotonSetupStatus,
  chatGptStatus: ChatGptSetupStatus,
): string {
  if (viewModel.agentReady) {
    return renderFinalPage(
      viewModel.assignedPhoneNumber,
      ownerStatus.state === "configured" ? ownerStatus.maskedPhoneNumber : "",
      options.authMode,
    );
  }

  return `<h1>iMessage Agent</h1>
    <p class="intro">Connect the services below. Message intake stays off until every step is ready.</p>
    <div class="stack">
      <section class="card" aria-labelledby="owner-title">
        <div class="card-heading">
          <h2 id="owner-title">Your phone number</h2>
          <div class="state ${viewModel.ownerConfigured ? "ok" : ""}" aria-live="polite">${escapeHtml(ownerStateLabel(ownerStatus))}</div>
        </div>
        ${renderOwnerAction(ownerStatus)}
      </section>
      ${
        viewModel.ownerConfigured
          ? `<section class="card" aria-labelledby="photon-title">
        <div class="card-heading">
          <h2 id="photon-title">Photon</h2>
          <div id="photon-state" class="state ${viewModel.photonConnected ? "ok" : ""}" aria-live="polite">${escapeHtml(photonStateLabel(photonStatus))}</div>
        </div>
        ${renderPhotonAction(photonStatus)}
      </section>`
          : ""
      }
      ${
        viewModel.photonConnected
          ? `<section class="card" aria-labelledby="chatgpt-title">
        <div class="card-heading">
          <h2 id="chatgpt-title">${viewModel.authTitle}</h2>
          <div class="state ${viewModel.chatGptConnected ? "ok" : ""}" aria-live="polite">${escapeHtml(viewModel.authStateLabel)}</div>
        </div>
        ${viewModel.chatGptConnected ? "" : renderChatGptAction(chatGptStatus, options)}
      </section>`
          : ""
      }
      ${
        viewModel.photonConnected && viewModel.chatGptConnected
          ? `<section class="card compact" aria-labelledby="codex-title">
        <div class="card-heading">
          <h2 id="codex-title">Codex</h2>
          <div class="state ${viewModel.codexReady ? "ok" : ""}" aria-live="polite">${viewModel.codexReady ? "✓ Ready" : "Getting ready"}</div>
        </div>
        ${
          viewModel.codexReady
            ? ""
            : `<div class="codex-progress" role="progressbar" aria-label="Codex is getting ready">
          <span aria-hidden="true"></span>
        </div>`
        }
      </section>`
          : ""
      }
      ${
        options.authMode === "chatgpt" && viewModel.chatGptConnected
          ? renderAdvancedSettings()
          : ""
      }
    </div>`;
}
