import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  renderDashboardScript,
  renderDeploymentPage,
  type DeploymentPageOptions,
} from "../../src/http/deployment-page.js";
import {
  READINESS_COMPONENTS,
  type ComponentReadiness,
  type ServiceReadinessSnapshot,
} from "../../src/http/readiness.js";

function snapshot(
  ready: boolean,
  overrides: Partial<
    Record<(typeof READINESS_COMPONENTS)[number], ComponentReadiness>
  > = {},
): ServiceReadinessSnapshot {
  const state: ComponentReadiness = { state: ready ? "ok" : "unknown" };
  return {
    status: ready ? "ready" : "not_ready",
    ready,
    shuttingDown: false,
    components: Object.fromEntries(
      READINESS_COMPONENTS.map((component) => [
        component,
        overrides[component] ?? state,
      ]),
    ) as ServiceReadinessSnapshot["components"],
    actions: [],
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const chatGptAgent: DeploymentPageOptions = {
  authMode: "chatgpt",
  runtimeMode: "agent",
  supermemoryConfigured: false,
};

describe("deployment page characterization snapshots", () => {
  it("preserves the initial setup document byte for byte", () => {
    expect(
      digest(
        renderDeploymentPage(snapshot(false), {
          ...chatGptAgent,
          runtimeMode: "foundation",
          supermemoryConfigured: true,
        }),
      ),
    ).toBe("ec87a6dece34666a121a7b6b1e4ea3763088ad73fec4daf0acb3ccf8986b3c8d");
  });

  it("preserves provider setup states and escaping byte for byte", () => {
    const pages = [
      renderDeploymentPage(
        snapshot(false),
        chatGptAgent,
        { state: "configured", maskedPhoneNumber: "••••<&\"'" },
        {
          state: "awaiting_authorization",
          userCode: "PH<&\"'",
          verificationUrl: "https://app.photon.codes/device?next=one&two=three",
          expiresAt: "2026-08-19T00:00:00.000Z",
        },
      ),
      renderDeploymentPage(
        snapshot(false),
        chatGptAgent,
        { state: "configured", maskedPhoneNumber: "••••4567" },
        { state: "connected", assignedPhoneNumber: "+14155550123" },
        {
          state: "awaiting_authorization",
          userCode: "CG<&\"'",
          verificationUrl: "https://auth.openai.com/codex/device?one=1&two=2",
        },
      ),
      renderDeploymentPage(
        snapshot(false, {
          codexAuth: { state: "ok" },
          codexCapabilities: { state: "starting" },
        }),
        chatGptAgent,
        { state: "configured", maskedPhoneNumber: "••••4567" },
        { state: "connected", assignedPhoneNumber: "+14155550123" },
        { state: "connected" },
      ),
    ];

    expect(digest(pages.join("\n---PAGE---\n"))).toBe(
      "93120906ff1c0789c5bc87823f1ca6445a98fc30ae6b465896a8f4780947bfa5",
    );
  });

  it("preserves ready ChatGPT and API-key documents byte for byte", () => {
    const ready = snapshot(true);
    const statuses = [
      { state: "configured", maskedPhoneNumber: "••••4567" },
      { state: "connected", assignedPhoneNumber: "+14155550123" },
      { state: "connected" },
    ] as const;
    const pages = [
      renderDeploymentPage(ready, chatGptAgent, ...statuses),
      renderDeploymentPage(
        ready,
        {
          authMode: "api_key",
          runtimeMode: "agent",
          supermemoryConfigured: true,
        },
        ...statuses,
      ),
    ];

    expect(digest(pages.join("\n---PAGE---\n"))).toBe(
      "77ebc71e6af50738ff20ebdbd1ce09ab4289b6f09fa1a857301d4c2faf0ff7e2",
    );
  });

  it("preserves the dashboard client script byte for byte", () => {
    expect(digest(renderDashboardScript())).toBe(
      "7d935e0047c8e1541da88d25fd7001938d60ee75b31b557bc2fb0f44c4c26862",
    );
  });
});
