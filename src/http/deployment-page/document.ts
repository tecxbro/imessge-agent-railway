import type { ChatGptSetupStatus } from "../../agent/codex-app-server-auth.js";
import type { DeploymentIdentityStatus } from "../../runtime/deployment-identity.js";
import type { PhotonSetupStatus } from "../../transport/photon-setup.js";
import type { ServiceReadinessSnapshot } from "../readiness.js";
import { renderDeploymentPageContent } from "./components.js";
import { DEPLOYMENT_PAGE_STYLES } from "./styles.js";
import {
  createDeploymentPageViewModel,
  type DeploymentPageOptions,
} from "./view-model.js";

export function renderDeploymentPage(
  snapshot: ServiceReadinessSnapshot,
  options: DeploymentPageOptions,
  ownerStatus: DeploymentIdentityStatus = { state: "not_configured" },
  photonStatus: PhotonSetupStatus = { state: "not_connected" },
  chatGptStatus: ChatGptSetupStatus = { state: "not_connected" },
): string {
  const viewModel = createDeploymentPageViewModel(
    snapshot,
    options,
    ownerStatus,
    photonStatus,
    chatGptStatus,
  );
  const content = renderDeploymentPageContent(
    viewModel,
    options,
    ownerStatus,
    photonStatus,
    chatGptStatus,
  );

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>iMessage Agent</title>
  <link rel="preconnect" href="https://framerusercontent.com" crossorigin>
  <style>
${DEPLOYMENT_PAGE_STYLES}
  </style>
</head>
<body data-owner-state="${ownerStatus.state}" data-photon-state="${photonStatus.state}" data-chatgpt-state="${chatGptStatus.state}" data-ready="${String(viewModel.agentReady)}">
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
  <main id="main-content" class="shell${viewModel.agentReady ? " ready-shell" : ""}">${content}</main>
  <footer class="site-footer">
    <div class="footer-inner">
      <p class="footer-copy"><strong>Build with Photon.</strong> Ship messaging apps with Spectrum.</p>
      <nav class="footer-links" aria-label="Photon resources">
        <a href="https://photon.codes/docs/spectrum-ts/introduction" target="_blank" rel="noreferrer">View Docs</a>
        <a href="https://photon.codes/contact" target="_blank" rel="noreferrer">Talk to an Expert</a>
      </nav>
    </div>
  </footer>
  <script src="/agent/dashboard.js" defer data-polling="${String(viewModel.polling)}"></script>
</body>
</html>`;
}
