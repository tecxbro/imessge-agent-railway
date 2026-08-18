import { type Server } from "node:http";

import express, {
  type ErrorRequestHandler,
  type Express,
  type Response,
} from "express";

import type { ChatGptSetupController } from "../agent/codex-app-server-auth.js";
import {
  modelSelectionSchema,
  type DeploymentModelSettings,
  type ModelSelection,
} from "../agent/model-selection.js";
import type { CodexModelOption } from "../agent/codex-account-capabilities.js";
import {
  OwnerPhoneNumberValidationError,
  type DeploymentIdentityController,
} from "../runtime/deployment-identity.js";
import { normalizeDashboardOwnerPhoneNumber } from "../runtime/phone-number.js";
import type { PhotonSetupController } from "../transport/photon-setup.js";
import {
  renderDashboardScript,
  renderDeploymentPage,
  type DeploymentPageOptions,
} from "./deployment-page.js";
import { PHOTON_LOGO_BASE64 } from "./photon-logo.js";
import {
  ReadinessRegistry,
  type SpectrumReadiness,
} from "./readiness.js";
import { requireSameOrigin } from "./same-origin.js";

export interface HealthApplicationOptions {
  readiness: ReadinessRegistry;
  spectrum?: SpectrumReadiness;
  deploymentPage?: DeploymentPageOptions;
  deploymentIdentity?: DeploymentIdentityController;
  photonSetup?: PhotonSetupController;
  chatgptSetup?: ChatGptSetupController;
  modelSettings?: ModelSettingsController;
}

export type ModelSettingsApiErrorCode =
  | "MODEL_SELECTION_STALE"
  | "MODEL_PAIR_UNAVAILABLE"
  | "MODEL_SETTINGS_UNAVAILABLE";

export class ModelSettingsApiError extends Error {
  public constructor(public readonly code: ModelSettingsApiErrorCode) {
    super(code);
    this.name = "ModelSettingsApiError";
  }
}

export interface ModelSettingsApiSnapshot extends DeploymentModelSettings {
  availableModels: readonly CodexModelOption[];
}

export interface ModelSettingsController {
  read(): Promise<ModelSettingsApiSnapshot>;
  update(selection: ModelSelection): Promise<ModelSettingsApiSnapshot>;
}

export interface HealthServer {
  readonly application: Express;
  readonly server: Server;
  close(): Promise<void>;
}

function setPrivateResponseHeaders(response: Response): void {
  response.set({
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
}

function isExactObject(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return (
    keys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}

function sendInvalidRequest(response: Response): void {
  response.set("cache-control", "no-store");
  response.status(400).json({ error: "INVALID_REQUEST" });
}

function sendModelSettingsError(
  response: Response,
  error: ModelSettingsApiErrorCode,
): void {
  response.set("cache-control", "private, no-store");
  const status =
    error === "MODEL_SETTINGS_UNAVAILABLE"
      ? 503
      : error === "MODEL_PAIR_UNAVAILABLE" || error === "MODEL_SELECTION_STALE"
        ? 409
        : 500;
  response.status(status).json({ error });
}

function publicModelSettings(snapshot: ModelSettingsApiSnapshot) {
  return {
    planType: snapshot.planType,
    preferred: snapshot.preferred,
    effective: snapshot.effective,
    selectionState: snapshot.selectionState,
    availableModels: snapshot.availableModels.map((model) => ({
      id: model.id,
      displayName: model.displayName,
      supportedReasoningEfforts: model.supportedReasoningEfforts,
      defaultReasoningEffort: model.defaultReasoningEffort,
    })),
  };
}

const jsonErrorHandler: ErrorRequestHandler = (
  error,
  _request,
  response,
  next,
) => {
  const errorType =
    error !== null && typeof error === "object" && "type" in error
      ? error.type
      : undefined;
  if (errorType === "entity.too.large") {
    response.set("cache-control", "no-store");
    response.status(413).json({ error: "REQUEST_TOO_LARGE" });
    return;
  }
  if (error instanceof SyntaxError) {
    sendInvalidRequest(response);
    return;
  }
  next(error);
};

export function createHealthApplication(
  options: HealthApplicationOptions,
): Express {
  const application = express();
  application.disable("x-powered-by");
  application.use(
    express.json({
      limit: "2kb",
      strict: true,
    }),
  );
  const sameOrigin = requireSameOrigin();
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
    setPrivateResponseHeaders(response);
    const snapshot = options.readiness.snapshot(options.spectrum?.snapshot());
    response.set(
      "content-security-policy",
      "default-src 'none'; style-src 'unsafe-inline'; font-src https://framerusercontent.com; img-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
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
          options.deploymentIdentity?.status() ?? {
            state: "not_configured",
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

  application.get("/api/setup/owner/status", (_request, response) => {
    response.set("cache-control", "no-store");
    const status = options.deploymentIdentity?.status();
    if (status?.state === "configured") {
      response.status(200).json({
        state: status.state,
        maskedPhoneNumber: status.maskedPhoneNumber,
      });
      return;
    }
    if (status?.state === "not_configured") {
      response.status(200).json({ state: status.state });
      return;
    }
    response.status(503).json({
      error:
        status?.state === "failed"
          ? status.code
          : "OWNER_IDENTITY_UNAVAILABLE",
    });
  });

  application.post("/api/setup/owner", sameOrigin, async (request, response) => {
    response.set("cache-control", "no-store");
    const legacyRequest = isExactObject(request.body, ["phoneNumber"]);
    const dashboardRequest = isExactObject(request.body, [
      "countryCode",
      "phoneNumber",
    ]);
    if (!legacyRequest && !dashboardRequest) {
      sendInvalidRequest(response);
      return;
    }
    const submittedPhoneNumber = request.body["phoneNumber"];
    const submittedCountryCode = request.body["countryCode"];
    if (typeof submittedPhoneNumber !== "string") {
      response.status(400).json({ error: "OWNER_PHONE_NUMBER_INVALID" });
      return;
    }
    let dashboardCountryCode: string | undefined;
    if (dashboardRequest) {
      if (typeof submittedCountryCode !== "string") {
        response.status(400).json({ error: "OWNER_PHONE_NUMBER_INVALID" });
        return;
      }
      dashboardCountryCode = submittedCountryCode;
    }
    if (options.deploymentIdentity === undefined) {
      response.status(503).json({
        error: "OWNER_IDENTITY_STORAGE_FAILED",
      });
      return;
    }
    try {
      const phoneNumber = dashboardCountryCode !== undefined
        ? normalizeDashboardOwnerPhoneNumber({
            countryCode: dashboardCountryCode,
            phoneNumber: submittedPhoneNumber,
          })
        : submittedPhoneNumber;
      const status = await options.deploymentIdentity.configureOwner(
        phoneNumber,
      );
      if (status.state === "configured") {
        response.status(200).json({
          state: status.state,
          maskedPhoneNumber: status.maskedPhoneNumber,
        });
        return;
      }
      response.status(503).json({
        error: "OWNER_IDENTITY_STORAGE_FAILED",
      });
    } catch (error) {
      if (error instanceof OwnerPhoneNumberValidationError) {
        response.status(400).json({ error: error.code });
        return;
      }
      response.status(503).json({
        error: "OWNER_IDENTITY_STORAGE_FAILED",
      });
    }
  });

  application.post("/api/setup/photon/start", sameOrigin, async (request, response) => {
    response.set("cache-control", "no-store");
    if (!isExactObject(request.body, [])) {
      sendInvalidRequest(response);
      return;
    }
    if (options.photonSetup === undefined) {
      response.status(503).json({
        state: "failed",
        code: "PHOTON_SETUP_UNAVAILABLE",
      });
      return;
    }
    try {
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
    } catch {
      response.status(502).json({
        state: "failed",
        code: "PHOTON_SETUP_FAILED",
      });
    }
  });

  application.get("/api/setup/photon/status", (_request, response) => {
    response.set("cache-control", "no-store");
    response.status(200).json(
      options.photonSetup?.status() ?? { state: "not_connected" },
    );
  });

  application.post("/api/setup/chatgpt/start", sameOrigin, async (request, response) => {
    response.set("cache-control", "no-store");
    if (!isExactObject(request.body, [])) {
      sendInvalidRequest(response);
      return;
    }
    const snapshot = options.readiness.snapshot(options.spectrum?.snapshot());
    const photonConnected =
      options.photonSetup === undefined ||
      options.photonSetup.status().state === "connected";
    if (
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
    try {
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
    } catch {
      response.status(502).json({
        state: "failed",
        code: "CHATGPT_SETUP_UNAVAILABLE",
      });
    }
  });

  application.get("/api/setup/chatgpt/status", (_request, response) => {
    response.set("cache-control", "no-store");
    response.status(200).json(chatGptStatus());
  });

  application.get("/api/settings/model", async (_request, response) => {
    response.set("cache-control", "private, no-store");
    if (options.modelSettings === undefined) {
      sendModelSettingsError(response, "MODEL_SETTINGS_UNAVAILABLE");
      return;
    }
    try {
      response.status(200).json(publicModelSettings(await options.modelSettings.read()));
    } catch (error) {
      sendModelSettingsError(
        response,
        error instanceof ModelSettingsApiError
          ? error.code
          : "MODEL_SETTINGS_UNAVAILABLE",
      );
    }
  });

  application.put(
    "/api/settings/model",
    sameOrigin,
    async (request, response) => {
      response.set("cache-control", "private, no-store");
      if (
        !isExactObject(request.body, ["modelId", "reasoningEffort"]) ||
        !modelSelectionSchema.safeParse(request.body).success
      ) {
        response.status(400).json({ error: "INVALID_MODEL_SETTINGS" });
        return;
      }
      if (options.modelSettings === undefined) {
        sendModelSettingsError(response, "MODEL_SETTINGS_UNAVAILABLE");
        return;
      }
      try {
        const snapshot = await options.modelSettings.update(
          modelSelectionSchema.parse(request.body),
        );
        response.status(200).json(publicModelSettings(snapshot));
      } catch (error) {
        sendModelSettingsError(
          response,
          error instanceof ModelSettingsApiError
            ? error.code
            : "MODEL_SETTINGS_UNAVAILABLE",
        );
      }
    },
  );

  application.get("/healthz", (_request, response) => {
    response.set("cache-control", "no-store");
    response.status(200).json({ status: "ok" });
  });

  application.get("/readyz", (_request, response) => {
    const snapshot = options.readiness.snapshot(options.spectrum?.snapshot());
    response.set("cache-control", "no-store");
    response.status(snapshot.ready ? 200 : 503).json(snapshot);
  });

  application.use(jsonErrorHandler);
  return application;
}

export async function startHealthServer(input: {
  port: number;
  host?: string;
  readiness: ReadinessRegistry;
  spectrum?: SpectrumReadiness;
  deploymentPage?: DeploymentPageOptions;
  deploymentIdentity?: DeploymentIdentityController;
  photonSetup?: PhotonSetupController;
  chatgptSetup?: ChatGptSetupController;
  modelSettings?: ModelSettingsController;
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
