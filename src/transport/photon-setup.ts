import { Buffer } from "node:buffer";

import { z } from "zod";

import type { DeploymentIdentityController } from "../runtime/deployment-identity.js";

const PHOTON_DASHBOARD_HOST = "https://app.photon.codes";
const PHOTON_SPECTRUM_HOST = "https://spectrum.photon.codes";
const PHOTON_CLIENT_ID = "photon-cli";
const PHOTON_SCOPE = "openid profile email";
const PHOTON_PROJECT_NAME = "iMessage Codex Agent";
const DEVICE_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const DEFAULT_DEVICE_EXPIRY_SECONDS = 1_800;

const boundedText = z.string().trim().min(1).max(16_384);
const e164PhoneNumber = z.string().regex(/^\+[1-9]\d{7,14}$/u);
const jsonObject = z.record(z.string(), z.unknown());
const photonVerificationUrl = z
  .url()
  .max(2_048)
  .refine((value) => {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname === "app.photon.codes";
  });

const deviceCodeSchema = z.object({
  device_code: boundedText,
  user_code: z.string().trim().min(1).max(64),
  verification_uri: photonVerificationUrl,
  verification_uri_complete: photonVerificationUrl.optional(),
  expires_in: z.number().int().positive().max(86_400).optional(),
  interval: z.number().int().positive().max(300).optional(),
});

const setupCredentialSchema = z.object({
  photonDeviceBearerToken: boundedText,
  photonProjectId: z.string().trim().min(1).max(256),
  spectrumProjectSecret: boundedText,
  ownerPhoneNumber: e164PhoneNumber,
  assignedIMessageNumber: e164PhoneNumber,
});

export const PHOTON_SETUP_ERROR_CODES = [
  "PHOTON_SETUP_UNAVAILABLE",
  "PHOTON_OWNER_PHONE_REQUIRED",
  "PHOTON_DEVICE_LOGIN_REJECTED",
  "PHOTON_DEVICE_LOGIN_EXPIRED",
  "PHOTON_TOKEN_INVALID",
  "PHOTON_PROJECT_SETUP_FAILED",
  "PHOTON_USER_SETUP_FAILED",
  "PHOTON_ASSIGNED_NUMBER_MISSING",
  "PHOTON_CREDENTIAL_SAVE_FAILED",
  "PHOTON_SETUP_FAILED",
] as const;

export type PhotonSetupErrorCode =
  (typeof PHOTON_SETUP_ERROR_CODES)[number];

export type PhotonSetupStatus =
  | { state: "not_connected" }
  | {
      state: "awaiting_authorization";
      userCode: string;
      verificationUrl: string;
      expiresAt: string;
    }
  | { state: "provisioning" }
  | {
      state: "connected";
      assignedPhoneNumber?: string;
    }
  | { state: "failed"; code: PhotonSetupErrorCode };

export interface PhotonSetupController {
  start(): Promise<PhotonSetupStatus>;
  status(): PhotonSetupStatus;
  onConnected?(listener: ConnectedListener): () => void;
}

export interface PhotonSetupCredentials {
  photonDeviceBearerToken: string;
  photonProjectId: string;
  spectrumProjectSecret: string;
  ownerPhoneNumber: string;
  assignedIMessageNumber: string;
}

export interface PhotonSetupCredentialsStore {
  save(credentials: PhotonSetupCredentials): Promise<void>;
}

type ConnectedListener = (
  credentials: PhotonSetupCredentials,
) => void | Promise<void>;

export class PhotonSetupError extends Error {
  public constructor(public readonly code: PhotonSetupErrorCode) {
    super(code);
    this.name = "PhotonSetupError";
  }
}

interface PhotonSetupServiceOptions {
  ownerIdentity: Pick<
    DeploymentIdentityController,
    "readOwnerPhoneNumber"
  >;
  credentialsStore: PhotonSetupCredentialsStore;
  storedCredentials?: {
    assignedIMessageNumber: string;
  };
  legacyCredentialsPresent?: boolean;
  fetchImplementation?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function safeObject(value: unknown): Record<string, unknown> {
  return jsonObject.parse(value);
}

function stringField(
  object: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = object[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function unwrapObjectList(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.map((entry) => safeObject(entry));
  }
  const outer = safeObject(value);
  for (const key of ["data", "projects", "users", "items"] as const) {
    const inner = outer[key];
    if (Array.isArray(inner)) {
      return inner.map((entry) => safeObject(entry));
    }
    if (typeof inner === "object" && inner !== null) {
      const nested = safeObject(inner);
      for (const nestedKey of ["projects", "users", "items"] as const) {
        const entries = nested[nestedKey];
        if (Array.isArray(entries)) {
          return entries.map((entry) => safeObject(entry));
        }
      }
    }
  }
  return [];
}

function normalizePhoneNumber(value: string): string {
  return value.replace(/[^\d+]/gu, "");
}

function tokenCandidates(
  body: Readonly<Record<string, unknown>>,
  headers: Headers,
): string[] {
  const candidates: Array<string | undefined> = [
    stringField(body, "access_token"),
    stringField(body, "accessToken"),
  ];
  const session = body["session"];
  if (typeof session === "object" && session !== null) {
    candidates.push(stringField(safeObject(session), "access_token"));
  }
  const data = body["data"];
  if (typeof data === "object" && data !== null) {
    const parsedData = safeObject(data);
    candidates.push(
      stringField(parsedData, "access_token"),
      stringField(parsedData, "accessToken"),
    );
  }
  candidates.push(headers.get("set-auth-token") ?? undefined);

  return [
    ...new Set(
      candidates.flatMap((candidate) => {
        if (candidate === undefined) {
          return [];
        }
        const withoutPrefix = candidate.replace(/^Bearer\s+/iu, "").trim();
        return withoutPrefix.length === 0 ? [] : [withoutPrefix];
      }),
    ),
  ];
}

export class PhotonSetupService implements PhotonSetupController {
  readonly #ownerIdentity: Pick<
    DeploymentIdentityController,
    "readOwnerPhoneNumber"
  >;
  readonly #credentialsStore: PhotonSetupCredentialsStore;
  readonly #fetch: typeof fetch;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #connectedListeners = new Set<ConnectedListener>();
  #status: PhotonSetupStatus;
  #starting: Promise<PhotonSetupStatus> | undefined;

  public constructor(options: PhotonSetupServiceOptions) {
    this.#ownerIdentity = options.ownerIdentity;
    this.#credentialsStore = options.credentialsStore;
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#status = options.storedCredentials === undefined
      ? options.legacyCredentialsPresent === true
        ? { state: "connected" }
        : { state: "not_connected" }
      : {
          state: "connected",
          assignedPhoneNumber:
            options.storedCredentials.assignedIMessageNumber,
        };
  }

  public status(): PhotonSetupStatus {
    return { ...this.#status };
  }

  public onConnected(listener: ConnectedListener): () => void {
    this.#connectedListeners.add(listener);
    return () => this.#connectedListeners.delete(listener);
  }

  public async start(): Promise<PhotonSetupStatus> {
    if (
      this.#status.state === "connected" ||
      this.#status.state === "awaiting_authorization" ||
      this.#status.state === "provisioning"
    ) {
      return this.status();
    }
    const ownerPhoneNumber =
      await this.#ownerIdentity.readOwnerPhoneNumber();
    if (ownerPhoneNumber === undefined) {
      this.#status = {
        state: "failed",
        code: "PHOTON_OWNER_PHONE_REQUIRED",
      };
      return this.status();
    }
    if (this.#starting !== undefined) {
      return await this.#starting;
    }

    this.#starting = this.#beginDeviceLogin(ownerPhoneNumber);
    try {
      return await this.#starting;
    } finally {
      this.#starting = undefined;
    }
  }

  async #beginDeviceLogin(
    ownerPhoneNumber: string,
  ): Promise<PhotonSetupStatus> {
    try {
      const response = await this.#fetch(
        `${PHOTON_DASHBOARD_HOST}/api/auth/device/code`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            client_id: PHOTON_CLIENT_ID,
            scope: PHOTON_SCOPE,
          }),
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!response.ok) {
        throw new PhotonSetupError("PHOTON_DEVICE_LOGIN_REJECTED");
      }
      const code = deviceCodeSchema.parse(await response.json());
      const expiresIn =
        code.expires_in ?? DEFAULT_DEVICE_EXPIRY_SECONDS;
      this.#status = {
        state: "awaiting_authorization",
        userCode: code.user_code,
        verificationUrl:
          code.verification_uri_complete ?? code.verification_uri,
        expiresAt: new Date(Date.now() + expiresIn * 1_000).toISOString(),
      };
      void this.#completeSetup(code, ownerPhoneNumber).catch((error: unknown) => {
        this.#status = {
          state: "failed",
          code:
            error instanceof PhotonSetupError
              ? error.code
              : "PHOTON_SETUP_FAILED",
        };
      });
      return this.status();
    } catch (error) {
      const code =
        error instanceof PhotonSetupError
          ? error.code
          : "PHOTON_DEVICE_LOGIN_REJECTED";
      this.#status = { state: "failed", code };
      return this.status();
    }
  }

  async #completeSetup(
    code: z.infer<typeof deviceCodeSchema>,
    ownerPhoneNumber: string,
  ): Promise<void> {
    const token = await this.#pollForToken(code);
    this.#status = { state: "provisioning" };
    await this.#validateToken(token);

    let project: Record<string, unknown> | undefined;
    try {
      const projects = await this.#listProjects(token);
      project = projects.find(
        (candidate) =>
          stringField(candidate, "name")?.toLocaleLowerCase() ===
          PHOTON_PROJECT_NAME.toLocaleLowerCase(),
      );
      project ??= await this.#createProject(token);
    } catch {
      throw new PhotonSetupError("PHOTON_PROJECT_SETUP_FAILED");
    }

    const projectId = stringField(project, "id");
    if (projectId === undefined) {
      throw new PhotonSetupError("PHOTON_PROJECT_SETUP_FAILED");
    }

    let projectSecret: string;
    try {
      projectSecret = await this.#regenerateProjectSecret(token, projectId);
    } catch {
      throw new PhotonSetupError("PHOTON_PROJECT_SETUP_FAILED");
    }

    let assignedPhoneNumber: string;
    try {
      assignedPhoneNumber = await this.#registerOwnerAndReadAssignedNumber(
        projectId,
        projectSecret,
        ownerPhoneNumber,
      );
    } catch (error) {
      if (
        error instanceof PhotonSetupError &&
        error.code === "PHOTON_ASSIGNED_NUMBER_MISSING"
      ) {
        throw error;
      }
      throw new PhotonSetupError("PHOTON_USER_SETUP_FAILED");
    }

    const credentials = setupCredentialSchema.parse({
      photonDeviceBearerToken: token,
      photonProjectId: projectId,
      spectrumProjectSecret: projectSecret,
      ownerPhoneNumber,
      assignedIMessageNumber: assignedPhoneNumber,
    });
    try {
      await this.#credentialsStore.save(credentials);
    } catch {
      throw new PhotonSetupError("PHOTON_CREDENTIAL_SAVE_FAILED");
    }

    this.#status = {
      state: "connected",
      assignedPhoneNumber: credentials.assignedIMessageNumber,
    };
    for (const listener of this.#connectedListeners) {
      void Promise.resolve(listener(credentials)).catch(() => undefined);
    }
  }

  async #pollForToken(
    code: z.infer<typeof deviceCodeSchema>,
  ): Promise<string> {
    const deadline =
      Date.now() +
      (code.expires_in ?? DEFAULT_DEVICE_EXPIRY_SECONDS) * 1_000;
    let intervalSeconds =
      code.interval ?? DEFAULT_POLL_INTERVAL_SECONDS;

    while (Date.now() < deadline) {
      await this.#sleep(intervalSeconds * 1_000);
      const response = await this.#fetch(
        `${PHOTON_DASHBOARD_HOST}/api/auth/device/token`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            grant_type: DEVICE_GRANT_TYPE,
            device_code: code.device_code,
            client_id: PHOTON_CLIENT_ID,
          }),
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (response.status === 200) {
        const candidates = tokenCandidates(
          safeObject(await response.json()),
          response.headers,
        );
        for (const candidate of candidates) {
          try {
            await this.#validateToken(candidate);
            return candidate;
          } catch {
            // Photon has returned several token shapes over time. Validate
            // every candidate before treating the device grant as complete.
          }
        }
        throw new PhotonSetupError("PHOTON_TOKEN_INVALID");
      }
      if (response.status === 429) {
        intervalSeconds += 10;
        continue;
      }
      if (response.status === 400) {
        const body = safeObject(await response.json());
        const error =
          stringField(body, "error") ?? stringField(body, "message");
        if (error === "authorization_pending") {
          continue;
        }
        if (error === "slow_down") {
          intervalSeconds += 5;
          continue;
        }
        if (error === "expired_token") {
          throw new PhotonSetupError("PHOTON_DEVICE_LOGIN_EXPIRED");
        }
        if (error === "access_denied") {
          throw new PhotonSetupError("PHOTON_DEVICE_LOGIN_REJECTED");
        }
      }
      throw new PhotonSetupError("PHOTON_DEVICE_LOGIN_REJECTED");
    }
    throw new PhotonSetupError("PHOTON_DEVICE_LOGIN_EXPIRED");
  }

  async #validateToken(token: string): Promise<void> {
    const headers = { authorization: `Bearer ${token}` };
    const sessionResponse = await this.#fetch(
      `${PHOTON_DASHBOARD_HOST}/api/auth/get-session`,
      { headers, signal: AbortSignal.timeout(30_000) },
    );
    if (!sessionResponse.ok) {
      throw new PhotonSetupError("PHOTON_TOKEN_INVALID");
    }
    const session = safeObject(await sessionResponse.json());
    if (typeof session["user"] !== "object" || session["user"] === null) {
      throw new PhotonSetupError("PHOTON_TOKEN_INVALID");
    }

    const projectsResponse = await this.#fetch(
      `${PHOTON_DASHBOARD_HOST}/api/projects/`,
      { headers, signal: AbortSignal.timeout(30_000) },
    );
    if (!projectsResponse.ok) {
      throw new PhotonSetupError("PHOTON_TOKEN_INVALID");
    }
    unwrapObjectList(await projectsResponse.json());
  }

  async #listProjects(token: string): Promise<Array<Record<string, unknown>>> {
    const response = await this.#fetch(
      `${PHOTON_DASHBOARD_HOST}/api/projects`,
      {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      throw new PhotonSetupError("PHOTON_PROJECT_SETUP_FAILED");
    }
    return unwrapObjectList(await response.json());
  }

  async #createProject(token: string): Promise<Record<string, unknown>> {
    const response = await this.#fetch(
      `${PHOTON_DASHBOARD_HOST}/api/projects`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: PHOTON_PROJECT_NAME,
          location: "United States",
          template: false,
          observability: false,
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      throw new PhotonSetupError("PHOTON_PROJECT_SETUP_FAILED");
    }
    const body = safeObject(await response.json());
    const data = body["data"];
    return typeof data === "object" && data !== null
      ? safeObject(data)
      : body;
  }

  async #regenerateProjectSecret(
    token: string,
    projectId: string,
  ): Promise<string> {
    const response = await this.#fetch(
      `${PHOTON_DASHBOARD_HOST}/api/projects/${encodeURIComponent(projectId)}/regenerate-secret`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      throw new PhotonSetupError("PHOTON_PROJECT_SETUP_FAILED");
    }
    const secret = stringField(
      safeObject(await response.json()),
      "projectSecret",
    );
    if (secret === undefined) {
      throw new PhotonSetupError("PHOTON_PROJECT_SETUP_FAILED");
    }
    return secret;
  }

  async #registerOwnerAndReadAssignedNumber(
    projectId: string,
    projectSecret: string,
    ownerPhoneNumber: string,
  ): Promise<string> {
    const authorization = `Basic ${Buffer.from(
      `${projectId}:${projectSecret}`,
      "utf8",
    ).toString("base64")}`;
    let user = (await this.#listSpectrumUsers(projectId, authorization)).find(
      (candidate) =>
        normalizePhoneNumber(stringField(candidate, "phoneNumber") ?? "") ===
        normalizePhoneNumber(ownerPhoneNumber),
    );

    if (user === undefined) {
      const response = await this.#fetch(
        `${PHOTON_SPECTRUM_HOST}/projects/${encodeURIComponent(projectId)}/users/`,
        {
          method: "POST",
          headers: {
            authorization,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            type: "shared",
            phoneNumber: ownerPhoneNumber,
          }),
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!response.ok) {
        throw new PhotonSetupError("PHOTON_USER_SETUP_FAILED");
      }
      const body = safeObject(await response.json());
      const candidate = body["user"] ?? body["data"] ?? body;
      user = safeObject(candidate);
    }

    for (let attempt = 0; attempt < 7; attempt += 1) {
      const assigned = stringField(user, "assignedPhoneNumber");
      if (assigned !== undefined) {
        return e164PhoneNumber.parse(assigned);
      }
      await this.#sleep(2_000);
      user = (await this.#listSpectrumUsers(projectId, authorization)).find(
        (candidate) =>
          normalizePhoneNumber(
            stringField(candidate, "phoneNumber") ?? "",
          ) === normalizePhoneNumber(ownerPhoneNumber),
      );
      if (user === undefined) {
        throw new PhotonSetupError("PHOTON_USER_SETUP_FAILED");
      }
    }
    throw new PhotonSetupError("PHOTON_ASSIGNED_NUMBER_MISSING");
  }

  async #listSpectrumUsers(
    projectId: string,
    authorization: string,
  ): Promise<Array<Record<string, unknown>>> {
    const response = await this.#fetch(
      `${PHOTON_SPECTRUM_HOST}/projects/${encodeURIComponent(projectId)}/users/`,
      {
        headers: { authorization },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      throw new PhotonSetupError("PHOTON_USER_SETUP_FAILED");
    }
    return unwrapObjectList(await response.json());
  }
}
