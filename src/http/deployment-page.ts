import type {
  ComponentReadiness,
  ReadinessComponent,
  ServiceReadinessSnapshot,
} from "./readiness.js";

export interface DeploymentPageOptions {
  authMode: "chatgpt" | "api_key";
  runtimeMode: "foundation" | "agent";
  supermemoryConfigured: boolean;
}

const COMPONENT_LABELS: Readonly<Record<ReadinessComponent, string>> = {
  configuration: "Configuration",
  database: "PostgreSQL",
  migrations: "Migrations",
  queue: "Durable queue",
  spectrum: "Spectrum",
  codexAuth: "Codex authentication",
  codexCapabilities: "Codex capabilities",
  disk: "Persistent disk",
  workspace: "Agent workspace",
  supermemory: "Supermemory",
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function stateTone(state: ComponentReadiness["state"]): string {
  if (state === "ok") {
    return "ok";
  }
  if (state === "disabled") {
    return "muted";
  }
  if (state === "starting") {
    return "working";
  }
  if (state === "degraded" || state === "missing" || state === "failed") {
    return "attention";
  }
  return "muted";
}

function stateLabel(state: ComponentReadiness["state"]): string {
  return state.replaceAll("_", " ");
}

function renderComponent(
  component: ReadinessComponent,
  readiness: ComponentReadiness,
): string {
  const detail = readiness.code === undefined
    ? ""
    : `<span class="component-code">${escapeHtml(readiness.code)}</span>`;
  return `<li class="component-row">
    <span>${COMPONENT_LABELS[component]}</span>
    <span class="component-state ${stateTone(readiness.state)}">
      <span class="state-dot" aria-hidden="true"></span>
      ${escapeHtml(stateLabel(readiness.state))}
      ${detail}
    </span>
  </li>`;
}

function renderActions(actions: readonly string[]): string {
  if (actions.length === 0) {
    return "";
  }

  return `<section class="panel" aria-labelledby="actions-title">
    <div class="eyebrow">Operator actions</div>
    <h2 id="actions-title">What still needs attention</h2>
    <ol class="actions">
      ${actions.map((action) => `<li>${escapeHtml(action)}</li>`).join("\n")}
    </ol>
  </section>`;
}

function renderAuthenticationStep(options: DeploymentPageOptions): string {
  if (options.authMode === "api_key") {
    return `<li>
      <strong>OpenAI API-key mode</strong>
      <span>Confirm <code>OPENAI_API_KEY</code> is set as a Railway service variable. The value is never shown here.</span>
    </li>`;
  }

  return `<li>
    <strong>Connect ChatGPT</strong>
    <span>Open a Railway SSH session with <code>railway ssh</code>, run <code>npm run codex:login</code>, complete the device-code flow, then run <code>npm run codex:status</code> and restart the service.</span>
  </li>`;
}

export function renderDeploymentPage(
  snapshot: ServiceReadinessSnapshot,
  options: DeploymentPageOptions,
): string {
  const foundationOnly = options.runtimeMode === "foundation";
  const trulyReady = snapshot.ready && !foundationOnly;
  const statusLabel = trulyReady
    ? "Agent ready"
    : foundationOnly
      ? "Integration required"
      : "Setup required";
  const title = trulyReady
    ? "Your private iMessage agent is ready."
    : foundationOnly
      ? "Infrastructure is live. The agent runtime is not connected yet."
      : "Infrastructure is live. Finish private setup.";
  const summary = trulyReady
    ? "Spectrum, Codex, PostgreSQL, and the durable pipeline report ready. Send a message only from an authorized owner handle."
    : foundationOnly
      ? "This deployment is running the foundation health process, not the composed message pipeline. Do not treat Railway service status as first-message acceptance."
      : "Complete the operator-only steps below. The service stays live while enrollment is incomplete, but message execution remains paused.";
  const components = Object.entries(snapshot.components) as Array<
    [ReadinessComponent, ComponentReadiness]
  >;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>iMessage Codex Agent — Deployment status</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f4f1e9;
      --surface: rgba(255, 255, 255, 0.82);
      --surface-strong: #ffffff;
      --text: #18231d;
      --muted: #58645d;
      --line: #cfd6cf;
      --accent: #176846;
      --accent-soft: #dceee5;
      --attention: #8a4d0f;
      --attention-soft: #fff0d7;
      --working: #285f91;
      --working-soft: #e0effc;
      --shadow: 0 1.5rem 4rem rgba(24, 35, 29, 0.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-inline-size: 20rem;
      background:
        radial-gradient(circle at 12% 8%, rgba(23, 104, 70, 0.15), transparent 28rem),
        linear-gradient(145deg, var(--bg), #ebe7dd);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 1rem;
      line-height: 1.6;
    }
    a { color: var(--accent); text-underline-offset: 0.2em; }
    a:focus-visible { outline: 0.2rem solid var(--accent); outline-offset: 0.2rem; }
    .skip-link {
      position: fixed;
      inset-block-start: 0.75rem;
      inset-inline-start: -100%;
      z-index: 10;
      padding: 0.65rem 0.9rem;
      border-radius: 0.5rem;
      background: var(--surface-strong);
      color: var(--text);
    }
    .skip-link:focus { inset-inline-start: 0.75rem; }
    .shell {
      inline-size: min(100% - 2rem, 70rem);
      margin-inline: auto;
      padding-block: clamp(1.5rem, 5vw, 5rem);
    }
    header { margin-block-end: 1.25rem; }
    .brand { font-weight: 750; letter-spacing: -0.02em; }
    .hero, .panel {
      border: 0.0625rem solid color-mix(in srgb, var(--line) 82%, transparent);
      border-radius: 1.25rem;
      background: var(--surface);
      box-shadow: var(--shadow);
      backdrop-filter: blur(1.25rem);
    }
    .hero { padding: clamp(1.5rem, 5vw, 4rem); }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      min-block-size: 2rem;
      padding-inline: 0.75rem;
      border-radius: 999px;
      background: ${trulyReady ? "var(--accent-soft)" : "var(--attention-soft)"};
      color: ${trulyReady ? "var(--accent)" : "var(--attention)"};
      font-size: 0.82rem;
      font-weight: 750;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    h1, h2 { line-height: 1.12; letter-spacing: -0.035em; }
    h1 { max-inline-size: 18ch; margin-block: 1rem 0.8rem; font-size: clamp(2rem, 7vw, 4.5rem); }
    h2 { margin-block: 0.4rem 1rem; font-size: clamp(1.35rem, 3vw, 2rem); }
    .lede { max-inline-size: 67ch; margin: 0; color: var(--muted); font-size: clamp(1.05rem, 2vw, 1.25rem); }
    .grid { display: grid; gap: 1rem; margin-block-start: 1rem; }
    .panel { padding: clamp(1.25rem, 3vw, 2rem); box-shadow: none; }
    .eyebrow { color: var(--accent); font-size: 0.78rem; font-weight: 800; letter-spacing: 0.09em; text-transform: uppercase; }
    .steps, .actions { margin: 0; padding-inline-start: 1.25rem; }
    .steps li, .actions li { padding-inline-start: 0.45rem; margin-block: 0.9rem; }
    .steps strong, .steps span { display: block; }
    .steps span { color: var(--muted); }
    code {
      border: 0.0625rem solid var(--line);
      border-radius: 0.35rem;
      padding: 0.12rem 0.35rem;
      background: var(--surface-strong);
      color: var(--text);
      font: 0.9em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      overflow-wrap: anywhere;
    }
    .components { list-style: none; margin: 0; padding: 0; }
    .component-row {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 1rem;
      padding-block: 0.75rem;
      border-block-end: 0.0625rem solid var(--line);
    }
    .component-row:last-child { border-block-end: 0; }
    .component-state { display: inline-flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 0.4rem; text-align: end; font-size: 0.88rem; font-weight: 700; text-transform: capitalize; }
    .state-dot { inline-size: 0.55rem; block-size: 0.55rem; border-radius: 50%; background: currentColor; }
    .ok { color: var(--accent); }
    .attention { color: var(--attention); }
    .working { color: var(--working); }
    .muted { color: var(--muted); }
    .component-code { inline-size: 100%; font: 0.72rem ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; text-transform: none; }
    .note { margin-block-start: 1rem; padding: 1rem; border-inline-start: 0.25rem solid var(--attention); background: var(--attention-soft); color: #5f360b; }
    footer { margin-block-start: 1.5rem; color: var(--muted); font-size: 0.9rem; }
    @media (min-width: 52rem) {
      .grid { grid-template-columns: minmax(0, 1fr) minmax(19rem, 0.8fr); }
      .wide { grid-column: 1 / -1; }
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #101512;
        --surface: rgba(25, 33, 28, 0.88);
        --surface-strong: #202923;
        --text: #f1f5f2;
        --muted: #b2beb6;
        --line: #3b493f;
        --accent: #75d8a8;
        --accent-soft: #173d2d;
        --attention: #f3ba70;
        --attention-soft: #493016;
        --working: #8bc8ff;
        --working-soft: #18354d;
        --shadow: 0 1.5rem 4rem rgba(0, 0, 0, 0.35);
      }
      .note { color: #ffe1b8; }
    }
    @media (prefers-contrast: more) {
      .hero, .panel, code { border-width: 0.125rem; }
      .component-row { border-block-end-width: 0.125rem; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; }
    }
    @media (prefers-contrast: forced) {
      .hero, .panel, code, .note { border: 0.125rem solid CanvasText; }
      .status { border: 0.125rem solid currentColor; }
    }
  </style>
</head>
<body>
  <a class="skip-link" href="#main-content">Skip to main content</a>
  <div class="shell">
    <header><div class="brand">iMessage Codex Agent</div></header>
    <main id="main-content">
      <section class="hero" aria-labelledby="page-title">
        <div class="status"><span class="state-dot" aria-hidden="true"></span>${statusLabel}</div>
        <h1 id="page-title">${title}</h1>
        <p class="lede">${summary}</p>
        <p class="note"><strong>This URL is an operator status page.</strong> It is not the iMessage conversation or a Photon phone-number enrollment link.</p>
      </section>
      <div class="grid">
        <section class="panel" aria-labelledby="setup-title">
          <div class="eyebrow">Private setup</div>
          <h2 id="setup-title">Finish the connection</h2>
          <ol class="steps">
            <li>
              <strong>Configure Photon Spectrum</strong>
              <span>Set the project ID, project secret, and authorized owner handles as Railway service variables before deployment.</span>
            </li>
            ${renderAuthenticationStep(options)}
            <li>
              <strong>Supermemory ${options.supermemoryConfigured ? "configured" : "not configured"}</strong>
              <span>${options.supermemoryConfigured ? "The key is present as a Railway service variable; its value is never displayed." : "Add SUPERMEMORY_API_KEY in Railway and restart, or intentionally leave semantic memory disabled."}</span>
            </li>
            <li>
              <strong>Require agent readiness</strong>
              <span>Open <a href="/readyz">the readiness endpoint</a>. Do not send a test message until it returns HTTP 200 with <code>ready: true</code>.</span>
            </li>
          </ol>
        </section>
        <section class="panel" aria-labelledby="components-title">
          <div class="eyebrow">Live state</div>
          <h2 id="components-title">Components</h2>
          <ul class="components">
            ${components.map(([component, state]) => renderComponent(component, state)).join("\n")}
          </ul>
        </section>
        <div class="wide">${renderActions(snapshot.actions)}</div>
      </div>
    </main>
    <footer>Secrets, provider errors, message content, phone numbers, and filesystem paths are intentionally excluded from this page.</footer>
  </div>
</body>
</html>`;
}
