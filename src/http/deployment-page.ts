import {
  getCountries,
  getCountryCallingCode,
} from "libphonenumber-js/max";

import type { ChatGptSetupStatus } from "../agent/codex-app-server-auth.js";
import type { DeploymentIdentityStatus } from "../runtime/deployment-identity.js";
import type { PhotonSetupStatus } from "../transport/photon-setup.js";
import type { ServiceReadinessSnapshot } from "./readiness.js";

export interface DeploymentPageOptions {
  authMode: "chatgpt" | "api_key";
  runtimeMode: "foundation" | "agent";
  supermemoryConfigured: boolean;
}

function escapeHtml(value: string): string {
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

function photonStateLabel(status: PhotonSetupStatus): string {
  switch (status.state) {
    case "connected":
      return "✓ Connected";
    case "awaiting_authorization":
      return "Waiting for authentication";
    case "provisioning":
      return "Finishing setup";
    case "failed":
      return "Setup needs attention";
    case "not_connected":
      return "Not connected";
  }
}

function ownerStateLabel(status: DeploymentIdentityStatus): string {
  switch (status.state) {
    case "configured":
      return "✓ Saved";
    case "initializing":
      return "Loading";
    case "failed":
      return "Setup needs attention";
    case "not_configured":
      return "Not configured";
  }
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

function chatGptStateLabel(status: ChatGptSetupStatus): string {
  switch (status.state) {
    case "connected":
      return "✓ Connected";
    case "awaiting_authorization":
      return "Waiting for sign in";
    case "starting":
      return "Starting sign in";
    case "failed":
      return "Setup needs attention";
    case "not_connected":
      return "Not connected";
  }
}

function renderPhotonAction(status: PhotonSetupStatus): string {
  if (status.state === "connected") {
    return "";
  }
  if (status.state === "awaiting_authorization") {
    return `<div class="auth-flow">
      <p>Open Photon and enter this one-time code.</p>
      <code class="device-code">${escapeHtml(status.userCode)}</code>
      <a class="button" href="${escapeHtml(status.verificationUrl)}" target="_blank" rel="noreferrer" data-auth-link="photon">Open Photon</a>
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
      <code class="device-code">${escapeHtml(status.userCode)}</code>
      <a class="button" href="${escapeHtml(status.verificationUrl)}" target="_blank" rel="noreferrer" data-auth-link="chatgpt">Sign in with ChatGPT</a>
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

function renderFinalPage(
  phoneNumber: string | undefined,
  maskedOwnerPhoneNumber: string,
  authMode: DeploymentPageOptions["authMode"],
): string {
  const number =
    phoneNumber === undefined
      ? ""
      : `<div class="agent-number">
          <span>Your number:</span>
          <strong>${escapeHtml(phoneNumber)}</strong>
        </div>`;
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
      <p class="ready-message"><strong>Your agent is ready.</strong><br>Text it to get started.</p>
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

export function renderDeploymentPage(
  snapshot: ServiceReadinessSnapshot,
  options: DeploymentPageOptions,
  ownerStatus: DeploymentIdentityStatus = { state: "not_configured" },
  photonStatus: PhotonSetupStatus = { state: "not_connected" },
  chatGptStatus: ChatGptSetupStatus = { state: "not_connected" },
): string {
  const ownerConfigured = ownerStatus.state === "configured";
  const photonConnected = photonStatus.state === "connected";
  const chatGptConnected =
    options.authMode === "api_key"
      ? snapshot.components.codexAuth.state === "ok"
      : chatGptStatus.state === "connected" ||
        snapshot.components.codexAuth.state === "ok";
  const codexReady = snapshot.components.codexCapabilities.state === "ok";
  const authTitle = options.authMode === "chatgpt" ? "ChatGPT" : "OpenAI";
  const authStateLabel =
    chatGptConnected ? "✓ Connected" : chatGptStateLabel(chatGptStatus);
  const agentReady =
    options.runtimeMode === "agent" &&
    snapshot.ready &&
    ownerConfigured &&
    photonConnected &&
    chatGptConnected &&
    codexReady;
  const assignedPhoneNumber =
    photonStatus.state === "connected"
      ? photonStatus.assignedPhoneNumber
      : undefined;
  const polling =
    ownerStatus.state === "initializing" ||
    photonStatus.state === "awaiting_authorization" ||
    photonStatus.state === "provisioning" ||
    chatGptStatus.state === "starting" ||
    chatGptStatus.state === "awaiting_authorization" ||
    (photonConnected && chatGptConnected && !agentReady);

  const content = agentReady
    ? renderFinalPage(
        assignedPhoneNumber,
        ownerStatus.state === "configured"
          ? ownerStatus.maskedPhoneNumber
          : "",
        options.authMode,
      )
    : `<h1>iMessage Agent</h1>
    <p class="intro">Connect the services below. Message intake stays off until every step is ready.</p>
    <div class="stack">
      <section class="card" aria-labelledby="owner-title">
        <div class="card-heading">
          <h2 id="owner-title">Your phone number</h2>
          <div class="state ${ownerConfigured ? "ok" : ""}" aria-live="polite">${escapeHtml(ownerStateLabel(ownerStatus))}</div>
        </div>
        ${renderOwnerAction(ownerStatus)}
      </section>
      ${
        ownerConfigured
          ? `<section class="card" aria-labelledby="photon-title">
        <div class="card-heading">
          <h2 id="photon-title">Photon</h2>
          <div id="photon-state" class="state ${photonConnected ? "ok" : ""}" aria-live="polite">${escapeHtml(photonStateLabel(photonStatus))}</div>
        </div>
        ${renderPhotonAction(photonStatus)}
      </section>`
          : ""
      }
      ${
        photonConnected
          ? `<section class="card" aria-labelledby="chatgpt-title">
        <div class="card-heading">
          <h2 id="chatgpt-title">${authTitle}</h2>
          <div class="state ${chatGptConnected ? "ok" : ""}" aria-live="polite">${escapeHtml(authStateLabel)}</div>
        </div>
        ${chatGptConnected ? "" : renderChatGptAction(chatGptStatus, options)}
      </section>`
          : ""
      }
      ${
        photonConnected && chatGptConnected
          ? `<section class="card compact" aria-labelledby="codex-title">
        <div class="card-heading">
          <h2 id="codex-title">Codex</h2>
          <div class="state ${codexReady ? "ok" : ""}" aria-live="polite">${codexReady ? "✓ Ready" : "Getting ready"}</div>
        </div>
        ${
          codexReady
            ? ""
            : `<div class="codex-progress" role="progressbar" aria-label="Codex is getting ready">
          <span aria-hidden="true"></span>
        </div>`
        }
      </section>`
          : ""
      }
      ${
        options.authMode === "chatgpt" && chatGptConnected
          ? renderAdvancedSettings()
          : ""
      }
    </div>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>iMessage Agent</title>
  <link rel="preconnect" href="https://framerusercontent.com" crossorigin>
  <style>
    @font-face {
      font-family: "Photon PolySans";
      src: url("https://framerusercontent.com/assets/ITOtz0GJh0f4Y4Fu3osXqgXYuAw.woff2") format("woff2");
      font-display: swap;
      font-style: normal;
      font-weight: 300;
    }
    :root {
      color-scheme: light;
      --bg: #fbfbfa;
      --surface: #ffffff;
      --text: #111110;
      --muted: #70706d;
      --line: #e7e7e4;
      --soft: #f1f1ef;
      --accent: #111110;
      --accent-hover: #30302e;
      --danger: #9b3028;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-inline-size: 20rem;
      min-block-size: 100vh;
      min-block-size: 100svh;
      display: grid;
      grid-template-rows: auto 1fr auto;
      background: var(--bg);
      color: var(--text);
      font-family: "Photon PolySans", Arial, sans-serif;
      font-size: 1rem;
      font-variation-settings: "wght" 450;
      line-height: 1.5;
    }
    .skip-link { position: fixed; inset-block-start: 0.75rem; inset-inline-start: -100%; z-index: 10; padding: 0.65rem 0.9rem; border: 0.0625rem solid var(--line); border-radius: 0.35rem; background: var(--surface); color: var(--text); }
    .skip-link:focus { inset-inline-start: 0.75rem; }
    .topbar { display: flex; min-block-size: 4.75rem; align-items: center; justify-content: space-between; gap: 1rem; padding-inline: clamp(1.25rem, 4vw, 3.5rem); border-block-end: 0.0625rem solid var(--line); background: var(--surface); }
    .brand { display: inline-flex; min-block-size: 2.75rem; align-items: center; gap: 1rem; color: var(--text); }
    .photon-link { display: inline-flex; inline-size: 2.75rem; block-size: 2.75rem; align-items: center; justify-content: center; border-radius: 0.7rem; color: var(--text); text-decoration: none; }
    .photon-logo { display: block; inline-size: 2.75rem; block-size: 2.75rem; border-radius: 0.7rem; }
    .product-name { font-size: 1rem; font-variation-settings: "wght" 550; }
    .topbar-nav { display: flex; align-items: center; gap: clamp(0.75rem, 3vw, 1.75rem); }
    .topbar-link { display: inline-flex; min-block-size: 2.75rem; align-items: center; color: var(--text); font-size: 0.92rem; font-variation-settings: "wght" 600; text-decoration: none; }
    .topbar-link:hover, .topbar-link:focus-visible { text-decoration: underline; text-underline-offset: 0.3em; }
    .state { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .shell { inline-size: min(100% - 2.5rem, 58rem); margin-inline: auto; padding-block: clamp(2.25rem, 6vw, 3.5rem); }
    .shell > * { animation: enter 420ms cubic-bezier(0.22, 1, 0.36, 1) both; }
    .shell > :nth-child(2) { animation-delay: 50ms; }
    .shell > :nth-child(3) { animation-delay: 90ms; }
    .shell > :nth-child(4) { animation-delay: 130ms; }
    h1 { max-inline-size: 13ch; margin: 0 0 1rem; font-size: clamp(3rem, 9vw, 6rem); font-weight: 300; font-variation-settings: "wght" 650; line-height: 0.94; letter-spacing: -0.055em; }
    h2 { margin: 0; font-size: clamp(1.5rem, 4vw, 2rem); font-weight: 300; font-variation-settings: "wght" 600; line-height: 1; letter-spacing: -0.035em; }
    .intro { max-inline-size: 39rem; margin: 0 0 clamp(2.25rem, 5vw, 3.5rem); color: var(--muted); font-size: clamp(1.1rem, 3vw, 1.4rem); line-height: 1.45; }
    .stack { display: grid; border-block-start: 0.0625rem solid var(--line); }
    .card { padding-block: clamp(1.75rem, 5vw, 2.75rem); border-block-end: 0.0625rem solid var(--line); background: transparent; }
    .compact { padding-block: 1.75rem; }
    .card-heading { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
    .card-heading + :not(:empty) { margin-block-start: 1.75rem; }
    .state { color: var(--muted); font-size: 0.8rem; font-weight: 650; letter-spacing: 0.02em; text-align: end; }
    .state.ok, .ready-list { color: var(--text); }
    .auth-flow { display: grid; justify-items: start; gap: 1rem; }
    .auth-flow p, .progress, .owner-help, .owner-summary, .owner-format-help { max-inline-size: 38rem; margin: 0; color: var(--muted); }
    .owner-summary strong { color: var(--text); font-variation-settings: "wght" 650; }
    .owner-form { display: grid; max-inline-size: 28rem; gap: 0.9rem; }
    .owner-form label { font-size: 1rem; font-variation-settings: "wght" 600; }
    .country-fields { display: grid; gap: 0.55rem; }
    .country-fields[hidden] { display: none; }
    .owner-form select { inline-size: 100%; min-block-size: 3rem; padding: 0.7rem 2.25rem 0.7rem 0.85rem; border: 0.0625rem solid var(--line); border-radius: 0.4rem; background: var(--surface); color: var(--text); font: inherit; }
    .phone-control { display: grid; grid-template-columns: auto minmax(0, 1fr); inline-size: 100%; }
    .phone-prefix { display: inline-flex; min-block-size: 3rem; align-items: center; padding-inline: 0.85rem; border: 0.0625rem solid var(--line); border-inline-end: 0; border-start-start-radius: 0.4rem; border-end-start-radius: 0.4rem; background: var(--soft); color: var(--muted); font: 1.05rem ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .phone-prefix[hidden] { display: none; }
    .owner-form input { inline-size: 100%; min-inline-size: 0; min-block-size: 3rem; padding: 0.7rem 0.85rem; border: 0.0625rem solid var(--line); border-radius: 0 0.4rem 0.4rem 0; background: var(--surface); color: var(--text); font: 1.05rem ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .phone-prefix[hidden] + input { border-radius: 0.4rem; }
    .country-toggle { inline-size: fit-content; min-block-size: 2.75rem; padding: 0; border: 0; background: transparent; color: var(--text); font: inherit; font-size: 0.9rem; font-variation-settings: "wght" 600; text-decoration: underline; text-underline-offset: 0.25em; cursor: pointer; }
    .owner-form input:focus-visible, .owner-form select:focus-visible, .country-toggle:focus-visible, .owner-replace summary:focus-visible { position: relative; z-index: 1; outline: 0.2rem solid var(--text); outline-offset: 0.2rem; }
    .owner-form .error:empty { display: none; }
    .owner-replace { margin-block-start: 1rem; }
    .owner-replace summary { inline-size: fit-content; min-block-size: 2.75rem; cursor: pointer; font-variation-settings: "wght" 600; }
    .owner-replace[open] .owner-form { margin-block-start: 1rem; }
    .codex-progress { position: relative; inline-size: 100%; block-size: 0.35rem; margin-block-start: 1.35rem; overflow: hidden; border-radius: 999rem; background: var(--line); }
    .codex-progress span { display: block; inline-size: 34%; block-size: 100%; border-radius: inherit; background: var(--accent); animation: codex-progress 1.4s ease-in-out infinite; transform: translateX(-110%); }
    .device-code { display: block; padding: 0.85rem 1rem; border: 0.0625rem solid var(--line); border-radius: 0.4rem; background: var(--soft); font: 750 clamp(1.2rem, 6vw, 2rem) ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: 0.08em; }
    .button { display: inline-flex; min-block-size: 3rem; align-items: center; justify-content: center; padding: 0.72rem 1.15rem; border: 0.0625rem solid var(--accent); border-radius: 999rem; background: var(--accent); color: white; font: inherit; font-size: 1rem; font-variation-settings: "wght" 550; text-decoration: none; cursor: pointer; transition: transform 160ms ease, background-color 160ms ease; }
    .button:hover, .button:focus-visible { background: var(--accent-hover); transform: translateY(-0.1rem); }
    .button:focus-visible, a:focus-visible { outline: 0.2rem solid var(--text); outline-offset: 0.2rem; }
    .button[disabled] { cursor: wait; opacity: 0.65; }
    .error { color: var(--danger); }
    .error code { font-size: 0.8em; }
    .error + .button { margin-block-start: 0.75rem; }
    .ready-card { display: grid; gap: 1.5rem; margin-block-start: 2rem; padding-block: 2rem; border-block: 0.0625rem solid var(--line); }
    .ready-list { display: grid; gap: 0.7rem; margin: 0; padding: 0; list-style: none; font-size: 1.35rem; }
    .agent-number { display: grid; gap: 0.2rem; }
    .agent-number span { color: var(--muted); }
    .agent-number strong { font-size: clamp(2rem, 7vw, 3.5rem); font-weight: 400; letter-spacing: -0.035em; }
    .ready-message { margin: 0; font-size: 1.3rem; }
    .advanced-card { margin-block-start: 1.5rem; }
    .advanced-card summary { min-block-size: 2.75rem; cursor: pointer; font-size: 1.15rem; font-variation-settings: "wght" 600; }
    .advanced-card[open] summary { margin-block-end: 1.5rem; }
    .model-summary { display: grid; gap: 0.8rem; margin: 0 0 1.5rem; }
    .model-summary div { display: grid; grid-template-columns: minmax(8rem, 0.35fr) 1fr; gap: 1rem; }
    .model-summary dt { color: var(--muted); }
    .model-summary dd { margin: 0; }
    .model-settings-form { display: grid; max-inline-size: 32rem; gap: 0.65rem; }
    .model-settings-form label { margin-block-start: 0.35rem; font-variation-settings: "wght" 600; }
    .model-settings-form select { inline-size: 100%; min-block-size: 3rem; padding: 0.7rem 2.25rem 0.7rem 0.85rem; border: 0.0625rem solid var(--line); border-radius: 0.4rem; background: var(--surface); color: var(--text); font: inherit; }
    .model-actions { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-block-start: 0.75rem; }
    .secondary-button { background: var(--surface); color: var(--text); }
    .secondary-button:hover, .secondary-button:focus-visible { background: var(--soft); }
    #model-settings-status:empty, #model-fallback-explanation[hidden] { display: none; }
    .site-footer { border-block-start: 0.0625rem solid var(--line); background: var(--soft); }
    .footer-inner { display: flex; inline-size: min(100% - 2.5rem, 64rem); min-block-size: 5rem; margin-inline: auto; align-items: center; justify-content: space-between; gap: 1.5rem; padding-block: 1rem; }
    .footer-copy { margin: 0; color: var(--muted); }
    .footer-copy strong { color: var(--text); font-variation-settings: "wght" 600; }
    .footer-links { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 0.35rem 1.25rem; }
    .footer-links a { display: inline-flex; min-block-size: 2.75rem; align-items: center; color: var(--text); font-size: 0.9rem; font-variation-settings: "wght" 600; text-underline-offset: 0.25em; }
    .visually-hidden { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    @keyframes enter { from { opacity: 0; transform: translateY(0.6rem); } to { opacity: 1; transform: translateY(0); } }
    @keyframes codex-progress { 0% { transform: translateX(-110%); } 55% { transform: translateX(105%); } 100% { transform: translateX(300%); } }
    @media (max-width: 32rem) { .card-heading { align-items: flex-start; } .state { max-inline-size: 10rem; } .ready-shell { padding-block: 1.5rem; } .ready-shell h1 { font-size: 2.6rem; } .ready-card { gap: 1.1rem; margin-block-start: 1.25rem; padding-block: 1.25rem; } .ready-list { gap: 0.45rem; font-size: 1.15rem; } .ready-message { font-size: 1.1rem; } .footer-inner { align-items: flex-start; flex-direction: column; gap: 0.25rem; } .footer-links { justify-content: flex-start; } }
    @media (prefers-contrast: more) { :root { --muted: #3f3f3d; --line: #777772; } .card, .device-code { border-width: 0.125rem; } }
    @media (prefers-contrast: forced) { .codex-progress { border: 0.125rem solid CanvasText; } .codex-progress span { background: Highlight; } }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; } .codex-progress span { inline-size: 38%; animation: none !important; opacity: 0.55; transform: none; } }
  </style>
</head>
<body data-owner-state="${ownerStatus.state}" data-photon-state="${photonStatus.state}" data-chatgpt-state="${chatGptStatus.state}" data-ready="${String(agentReady)}">
  <a class="skip-link" href="#main-content">Skip to main content</a>
  <header class="topbar">
    <div class="brand">
      <a class="photon-link" href="https://photon.codes" target="_blank" rel="noreferrer" aria-label="Photon home">
        <img class="photon-logo" src="/agent/photon-logo.png" alt="" width="44" height="44">
      </a>
      <span class="product-name">iMessage Agent</span>
    </div>
    <nav class="topbar-nav" aria-label="Photon">
      <a class="topbar-link" href="https://photon.codes" target="_blank" rel="noreferrer">Build with Photon</a>
    </nav>
  </header>
  <main id="main-content" class="shell${agentReady ? " ready-shell" : ""}">${content}</main>
  <footer class="site-footer">
    <div class="footer-inner">
      <p class="footer-copy"><strong>Build with Photon.</strong> Ship messaging apps with Spectrum.</p>
      <nav class="footer-links" aria-label="Photon resources">
        <a href="https://photon.codes/docs/spectrum-ts/introduction" target="_blank" rel="noreferrer">View Docs</a>
        <a href="https://photon.codes/contact" target="_blank" rel="noreferrer">Talk to an Expert</a>
      </nav>
    </div>
  </footer>
  <script src="/agent/dashboard.js" defer data-polling="${String(polling)}"></script>
</body>
</html>`;
}

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
  function openAuthentication(event) {
    const control = event.currentTarget;
    const popup = window.open("", "agent-provider-auth", "popup=yes,width=560,height=760");
    if (!popup) return;
    try {
      popup.opener = null;
      popup.location.replace(control.href);
      authWindow = popup;
      event.preventDefault();
    } catch {
      popup.close();
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
  void loadModelSettings();
  if (script && script.dataset.polling === "true") timer = window.setTimeout(refresh, 2000);
  window.addEventListener("pagehide", () => window.clearTimeout(timer), { once: true });
})();`;
}
