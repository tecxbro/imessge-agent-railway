import { type Server } from "node:http";

import express, { type Express } from "express";

import type { ChatGptSetupController } from "../agent/codex-app-server-auth.js";
import type { PhotonSetupController } from "../transport/photon-setup.js";
import {
  ReadinessRegistry,
  type SpectrumReadiness,
} from "./readiness.js";
import {
  renderDashboardScript,
  renderDeploymentPage,
  type DeploymentPageOptions,
} from "./deployment-page.js";
import { PHOTON_LOGO_BASE64 } from "./photon-logo.js";

export interface HealthApplicationOptions {
  readiness: ReadinessRegistry;
  spectrum?: SpectrumReadiness;
  deploymentPage?: DeploymentPageOptions;
  photonSetup?: PhotonSetupController;
  chatgptSetup?: ChatGptSetupController;
}

export interface HealthServer {
  readonly application: Express;
  readonly server: Server;
  close(): Promise<void>;
}

export function createHealthApplication(
  options: HealthApplicationOptions,
): Express {
  const application = express();
  application.disable("x-powered-by");
  const chatGptStatus = () => {
    if (options.chatgptSetup !== undefined) {
      return options.chatgptSetup.status();
    }
    if (options.deploymentPage?.authMode === "api_key") {
      const snapshot = options.readiness.snapshot(options.spectrum?.snapshot());
      return snapshot.components.codexAuth.state === "ok"
        ? ({ state: "connected" } as const)
        : ({ state: "not_connected" } as const);
    }
    return { state: "not_connected" } as const;
  };

  application.get("/", (_request, response) => {
    response.set("cache-control", "no-store");
    response.redirect(302, "/agent/dashboard");
  });

  application.get("/agent/dashboard", (_request, response) => {
    const snapshot = options.readiness.snapshot(options.spectrum?.snapshot());
    response.set({
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; font-src https://framerusercontent.com; img-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    });
    response
      .status(200)
      .type("html")
      .send(
        renderDeploymentPage(
          snapshot,
          options.deploymentPage ?? {
            authMode: "chatgpt",
            runtimeMode: "foundation",
            supermemoryConfigured: false,
          },
          options.photonSetup?.status() ?? { state: "not_connected" },
          chatGptStatus(),
        ),
      );
  });

  application.get("/agent/dashboard.js", (_request, response) => {
    response.set({
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'",
      "x-content-type-options": "nosniff",
    });
    response.status(200).type("application/javascript").send(renderDashboardScript());
  });

  application.get("/agent/photon-logo.png", (_request, response) => {
    response.set({
      "cache-control": "public, max-age=31536000, immutable",
      "content-type": "image/png",
      "x-content-type-options": "nosniff",
    });
    response.status(200).send(Buffer.from(PHOTON_LOGO_BASE64, "base64"));
  });

  application.post("/api/setup/photon/start", async (_request, response) => {
    response.set("cache-control", "no-store");
    if (options.photonSetup === undefined) {
      response.status(503).json({
        state: "failed",
        code: "PHOTON_SETUP_UNAVAILABLE",
      });
      return;
    }
    const status = await options.photonSetup.start();
    response
      .status(
        status.state === "failed"
          ? 502
          : status.state === "connected"
            ? 200
            : 202,
      )
      .json(status);
  });

  application.get("/api/setup/photon/status", (_request, response) => {
    response.set("cache-control", "no-store");
    response.status(200).json(
      options.photonSetup?.status() ?? { state: "not_connected" },
    );
  });

  application.post("/api/setup/chatgpt/start", async (request, response) => {
    response.set("cache-control", "no-store");
    const snapshot = options.readiness.snapshot(options.spectrum?.snapshot());
    const photonConnected =
      options.photonSetup === undefined ||
      options.photonSetup.status().state === "connected";
    if (
      request.get("x-agent-setup") !== "dashboard" ||
      options.chatgptSetup === undefined ||
      snapshot.components.disk.state !== "ok" ||
      !photonConnected
    ) {
      response.status(503).json({
        state: "failed",
        code: "CHATGPT_SETUP_UNAVAILABLE",
      });
      return;
    }
    const status = await options.chatgptSetup.start();
    response
      .status(
        status.state === "failed"
          ? 502
          : status.state === "connected"
            ? 200
            : 202,
      )
      .json(status);
  });

  application.get("/api/setup/chatgpt/status", (_request, response) => {
    response.set("cache-control", "no-store");
    response.status(200).json(chatGptStatus());
  });

  application.get("/healthz", (_request, response) => {
    response.set("cache-control", "no-store");
    response.status(200).json({ status: "ok" });
  });

  application.get("/readyz", (_request, response) => {
    const snapshot = options.readiness.snapshot(options.spectrum?.snapshot());
    response.set("cache-control", "no-store");
    response.status(snapshot.ready ? 200 : 503).json(snapshot);
  });

  return application;
}

export async function startHealthServer(input: {
  port: number;
  host?: string;
  readiness: ReadinessRegistry;
  spectrum?: SpectrumReadiness;
  deploymentPage?: DeploymentPageOptions;
  photonSetup?: PhotonSetupController;
  chatgptSetup?: ChatGptSetupController;
}): Promise<HealthServer> {
  const application = createHealthApplication(input);
  const server = await new Promise<Server>((resolve, reject) => {
    const listener = application.listen(
      input.port,
      input.host ?? "0.0.0.0",
      () => resolve(listener),
    );
    listener.once("error", reject);
  });

  return {
    application,
    server,
    async close() {
      if (!server.listening) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
    },
  };
}
