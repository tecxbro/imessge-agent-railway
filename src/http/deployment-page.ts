import type { ChatGptSetupStatus } from "../agent/codex-app-server-auth.js";
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
        <li>✓ Photon connected</li>
        <li>✓ ${authMode === "chatgpt" ? "ChatGPT" : "OpenAI API key"} connected</li>
        <li>✓ Codex ready</li>
      </ul>
      ${number}
      <p class="ready-message"><strong>Your agent is ready.</strong><br>Text it to get started.</p>
    </section>`;
}

export function renderDeploymentPage(
  snapshot: ServiceReadinessSnapshot,
  options: DeploymentPageOptions,
  photonStatus: PhotonSetupStatus = { state: "not_connected" },
  chatGptStatus: ChatGptSetupStatus = { state: "not_connected" },
): string {
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
    photonConnected &&
    chatGptConnected &&
    codexReady;
  const assignedPhoneNumber =
    photonStatus.state === "connected"
      ? photonStatus.assignedPhoneNumber
      : undefined;
  const polling =
    photonStatus.state === "awaiting_authorization" ||
    photonStatus.state === "provisioning" ||
    chatGptStatus.state === "starting" ||
    chatGptStatus.state === "awaiting_authorization" ||
    (photonConnected && chatGptConnected && !agentReady);

  const content = agentReady
    ? renderFinalPage(assignedPhoneNumber, options.authMode)
    : `<p class="eyebrow">Private agent / setup</p>
    <h1>iMessage Agent</h1>
    <p class="intro">Connect the services below. Message intake stays off until every step is ready.</p>
    <div class="stack">
      <section class="card" aria-labelledby="photon-title">
        <div class="card-heading">
          <h2 id="photon-title">Photon</h2>
          <div id="photon-state" class="state ${photonConnected ? "ok" : ""}" aria-live="polite">${escapeHtml(photonStateLabel(photonStatus))}</div>
        </div>
        ${renderPhotonAction(photonStatus)}
      </section>
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
    .topbar-state, .eyebrow, .state { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .topbar-state, .eyebrow { color: var(--muted); font-size: 0.72rem; font-weight: 650; letter-spacing: 0.2em; text-transform: uppercase; }
    .shell { inline-size: min(100% - 2.5rem, 58rem); margin-inline: auto; padding-block: clamp(2.25rem, 6vw, 3.5rem); }
    .shell > * { animation: enter 420ms cubic-bezier(0.22, 1, 0.36, 1) both; }
    .shell > :nth-child(2) { animation-delay: 50ms; }
    .shell > :nth-child(3) { animation-delay: 90ms; }
    .shell > :nth-child(4) { animation-delay: 130ms; }
    h1 { max-inline-size: 13ch; margin: 0 0 1rem; font-size: clamp(3rem, 9vw, 6rem); font-weight: 300; font-variation-settings: "wght" 650; line-height: 0.94; letter-spacing: -0.055em; }
    h2 { margin: 0; font-size: clamp(1.5rem, 4vw, 2rem); font-weight: 300; font-variation-settings: "wght" 600; line-height: 1; letter-spacing: -0.035em; }
    .eyebrow { margin: 0 0 1.2rem; }
    .intro { max-inline-size: 39rem; margin: 0 0 clamp(2.25rem, 5vw, 3.5rem); color: var(--muted); font-size: clamp(1.1rem, 3vw, 1.4rem); line-height: 1.45; }
    .stack { display: grid; border-block-start: 0.0625rem solid var(--line); }
    .card { padding-block: clamp(1.75rem, 5vw, 2.75rem); border-block-end: 0.0625rem solid var(--line); background: transparent; }
    .compact { padding-block: 1.75rem; }
    .card-heading { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
    .card-heading + :not(:empty) { margin-block-start: 1.75rem; }
    .state { color: var(--muted); font-size: 0.8rem; font-weight: 650; letter-spacing: 0.02em; text-align: end; }
    .state.ok, .ready-list { color: var(--text); }
    .auth-flow { display: grid; justify-items: start; gap: 1rem; }
    .auth-flow p, .progress { max-inline-size: 38rem; margin: 0; color: var(--muted); }
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
    .site-footer { border-block-start: 0.0625rem solid var(--line); background: var(--soft); }
    .footer-inner { display: flex; inline-size: min(100% - 2.5rem, 64rem); min-block-size: 5rem; margin-inline: auto; align-items: center; justify-content: space-between; gap: 1.5rem; padding-block: 1rem; }
    .footer-copy { margin: 0; color: var(--muted); }
    .footer-copy strong { color: var(--text); font-variation-settings: "wght" 600; }
    .footer-links { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 0.35rem 1.25rem; }
    .footer-links a { display: inline-flex; min-block-size: 2.75rem; align-items: center; color: var(--text); font-size: 0.9rem; font-variation-settings: "wght" 600; text-underline-offset: 0.25em; }
    .visually-hidden { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    @keyframes enter { from { opacity: 0; transform: translateY(0.6rem); } to { opacity: 1; transform: translateY(0); } }
    @keyframes codex-progress { 0% { transform: translateX(-110%); } 55% { transform: translateX(105%); } 100% { transform: translateX(300%); } }
    @media (max-width: 32rem) { .topbar-state { display: none; } .card-heading { align-items: flex-start; } .state { max-inline-size: 10rem; } .ready-shell { padding-block: 1.5rem; } .ready-shell h1 { font-size: 2.6rem; } .ready-card { gap: 1.1rem; margin-block-start: 1.25rem; padding-block: 1.25rem; } .ready-list { gap: 0.45rem; font-size: 1.15rem; } .ready-message { font-size: 1.1rem; } .footer-inner { align-items: flex-start; flex-direction: column; gap: 0.25rem; } .footer-links { justify-content: flex-start; } }
    @media (prefers-contrast: more) { :root { --muted: #3f3f3d; --line: #777772; } .card, .device-code { border-width: 0.125rem; } }
    @media (prefers-contrast: forced) { .codex-progress { border: 0.125rem solid CanvasText; } .codex-progress span { background: Highlight; } }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; } .codex-progress span { inline-size: 38%; animation: none !important; opacity: 0.55; transform: none; } }
  </style>
</head>
<body data-photon-state="${photonStatus.state}" data-chatgpt-state="${chatGptStatus.state}" data-ready="${String(agentReady)}">
  <a class="skip-link" href="#main-content">Skip to main content</a>
  <header class="topbar">
    <div class="brand">
      <a class="photon-link" href="https://photon.codes" target="_blank" rel="noreferrer" aria-label="Photon home">
        <img class="photon-logo" src="/agent/photon-logo.png" alt="" width="44" height="44">
      </a>
      <span class="product-name">iMessage Agent</span>
    </div>
    <nav class="topbar-nav" aria-label="Photon">
      <span class="topbar-state">Private setup</span>
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
        headers: { "x-agent-setup": "dashboard" }
      });
    } finally {
      reload();
    }
  }
  async function refresh() {
    try {
      const [photonResponse, chatgptResponse, readinessResponse] = await Promise.all([
        fetch("/api/setup/photon/status", { cache: "no-store" }),
        fetch("/api/setup/chatgpt/status", { cache: "no-store" }),
        fetch("/readyz", { cache: "no-store" })
      ]);
      const photon = await photonResponse.json();
      const chatgpt = await chatgptResponse.json();
      const readiness = await readinessResponse.json();
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
  for (const kind of ["photon", "chatgpt"]) {
    const control = document.getElementById(kind + "-start");
    if (control) control.addEventListener("click", () => void start(kind));
  }
  for (const control of document.querySelectorAll("[data-auth-link]")) {
    control.addEventListener("click", openAuthentication);
  }
  if (script && script.dataset.polling === "true") timer = window.setTimeout(refresh, 2000);
  window.addEventListener("pagehide", () => window.clearTimeout(timer), { once: true });
})();`;
}
