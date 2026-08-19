import type { ChatGptSetupStatus } from "../../agent/codex-app-server-auth.js";
import type { DeploymentIdentityStatus } from "../../runtime/deployment-identity.js";
import type { PhotonSetupStatus } from "../../transport/photon-setup.js";
import type { ServiceReadinessSnapshot } from "../readiness.js";

export interface DeploymentPageOptions {
  authMode: "chatgpt" | "api_key";
  runtimeMode: "foundation" | "agent";
  supermemoryConfigured: boolean;
}

export interface DeploymentPageViewModel {
  agentReady: boolean;
  assignedPhoneNumber: string | undefined;
  authStateLabel: string;
  authTitle: "ChatGPT" | "OpenAI";
  chatGptConnected: boolean;
  codexReady: boolean;
  ownerConfigured: boolean;
  photonConnected: boolean;
  polling: boolean;
}

export function photonStateLabel(status: PhotonSetupStatus): string {
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

export function ownerStateLabel(status: DeploymentIdentityStatus): string {
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

export function chatGptStateLabel(status: ChatGptSetupStatus): string {
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

export function createDeploymentPageViewModel(
  snapshot: ServiceReadinessSnapshot,
  options: DeploymentPageOptions,
  ownerStatus: DeploymentIdentityStatus,
  photonStatus: PhotonSetupStatus,
  chatGptStatus: ChatGptSetupStatus,
): DeploymentPageViewModel {
  const ownerConfigured = ownerStatus.state === "configured";
  const photonConnected = photonStatus.state === "connected";
  const chatGptConnected =
    options.authMode === "api_key"
      ? snapshot.components.codexAuth.state === "ok"
      : chatGptStatus.state === "connected" ||
        snapshot.components.codexAuth.state === "ok";
  const codexReady = snapshot.components.codexCapabilities.state === "ok";
  const agentReady =
    options.runtimeMode === "agent" &&
    snapshot.ready &&
    ownerConfigured &&
    photonConnected &&
    chatGptConnected &&
    codexReady;

  return {
    agentReady,
    assignedPhoneNumber:
      photonStatus.state === "connected"
        ? photonStatus.assignedPhoneNumber
        : undefined,
    authStateLabel: chatGptConnected
      ? "✓ Connected"
      : chatGptStateLabel(chatGptStatus),
    authTitle: options.authMode === "chatgpt" ? "ChatGPT" : "OpenAI",
    chatGptConnected,
    codexReady,
    ownerConfigured,
    photonConnected,
    polling:
      ownerStatus.state === "initializing" ||
      photonStatus.state === "awaiting_authorization" ||
      photonStatus.state === "provisioning" ||
      chatGptStatus.state === "starting" ||
      chatGptStatus.state === "awaiting_authorization" ||
      (photonConnected && chatGptConnected && !agentReady),
  };
}
