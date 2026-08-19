export const PHOTON_INSTALLATION_STATES = [
  "not_started",
  "awaiting_device_authorization",
  "token_acquired",
  "project_claimed",
  "owner_registering",
  "connected",
  "needs_owner_rebind",
  "needs_credential_repair",
  "failed",
] as const;

export type PhotonInstallationState =
  (typeof PHOTON_INSTALLATION_STATES)[number];

export const PHOTON_INSTALLATION_STEPS = [
  "not_started",
  "device_authorization_requested",
  "token_acquired",
  "project_claimed",
  "project_credential_stored",
  "owner_registered",
  "credential_validated",
  "legacy_credentials_imported",
] as const;

export type PhotonInstallationStep =
  (typeof PHOTON_INSTALLATION_STEPS)[number];

export const PHOTON_INSTALLATION_FAILURE_CODES = [
  "authorization_denied",
  "authorization_expired",
  "credential_validation_failed",
  "device_authorization_failed",
  "legacy_credentials_rejected",
  "management_token_invalid",
  "operation_cancelled",
  "operation_conflict",
  "owner_registration_failed",
  "owner_revision_changed",
  "project_creation_failed",
  "project_credential_failed",
  "provider_unavailable",
] as const;

export type PhotonInstallationFailureCode =
  (typeof PHOTON_INSTALLATION_FAILURE_CODES)[number];

export interface PhotonInstallationRecord {
  installationId: string;
  deploymentId: string;
  ownerRevision: number;
  operationId: string;
  state: PhotonInstallationState;
  photonProjectId?: string;
  managementTokenCiphertext?: string;
  spectrumSecretCiphertext?: string;
  assignedNumberCiphertext?: string;
  deviceCodeCiphertext?: string;
  deviceUserCode?: string;
  verificationUrl?: string;
  authorizationExpiresAt?: Date;
  pollIntervalMs?: number;
  lastCompletedStep: PhotonInstallationStep;
  safeFailureCode?: PhotonInstallationFailureCode;
  journalVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

export type PhotonInstallationJournal = Omit<
  PhotonInstallationRecord,
  | "installationId"
  | "deploymentId"
  | "ownerRevision"
  | "operationId"
  | "journalVersion"
  | "createdAt"
  | "updatedAt"
>;

export interface CreatePhotonInstallationInput {
  installationId: string;
  deploymentId: string;
  ownerRevision: number;
  operationId: string;
}

export interface ClaimPhotonInstallationOperationInput {
  installationId: string;
  expectedOperationId: string;
  expectedOwnerRevision: number;
  nextOperationId: string;
  nextOwnerRevision: number;
  nextState: PhotonInstallationState;
}

export interface CheckpointPhotonInstallationInput {
  installationId: string;
  operationId: string;
  ownerRevision: number;
  expectedStates: readonly PhotonInstallationState[];
  next: PhotonInstallationJournal;
}

export interface PhotonInstallationRepositoryPort {
  load(installationId: string): Promise<PhotonInstallationRecord | undefined>;
  createInitial(
    input: CreatePhotonInstallationInput,
  ): Promise<PhotonInstallationRecord | undefined>;
  claimOperation(
    input: ClaimPhotonInstallationOperationInput,
  ): Promise<PhotonInstallationRecord | undefined>;
  checkpoint(
    input: CheckpointPhotonInstallationInput,
  ): Promise<PhotonInstallationRecord | undefined>;
}

export interface OwnerBindingSnapshot {
  ownerRevision: number;
  ownerPhoneNumber: string;
}

export interface OwnerBindingRevisionPort {
  read(): Promise<OwnerBindingSnapshot>;
}

export interface PhotonInstallationCipher {
  encrypt(plaintext: string): Promise<string> | string;
  decrypt(ciphertext: string): Promise<string> | string;
}

export interface PhotonDeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: Date;
  pollIntervalMs: number;
}

export type PhotonDeviceTokenExchange =
  | { state: "pending" }
  | { state: "slow_down"; retryAfterMs?: number }
  | { state: "authorized"; managementToken: string }
  | { state: "denied" }
  | { state: "expired" };

export interface PhotonInstallationProviderPort {
  requestDeviceAuthorization(input: {
    operationId: string;
    signal: AbortSignal;
  }): Promise<PhotonDeviceAuthorization>;
  exchangeDeviceCode(input: {
    deviceCode: string;
    operationId: string;
    signal: AbortSignal;
  }): Promise<PhotonDeviceTokenExchange>;
  validateManagementToken(input: {
    managementToken: string;
    signal: AbortSignal;
  }): Promise<boolean>;
  createProject(input: {
    installationId: string;
    operationId: string;
    managementToken: string;
    projectName: string;
    signal: AbortSignal;
  }): Promise<{ photonProjectId: string }>;
  /**
   * Issues the first credential for a newly stored project ID. The production
   * adapter must make retries idempotent by installationId and must never map
   * this method to an unconditional reconnect-time secret rotation.
   */
  provisionInitialProjectSecret(input: {
    installationId: string;
    operationId: string;
    managementToken: string;
    photonProjectId: string;
    signal: AbortSignal;
  }): Promise<{ spectrumProjectSecret: string }>;
  registerOwner(input: {
    operationId: string;
    photonProjectId: string;
    spectrumProjectSecret: string;
    ownerPhoneNumber: string;
    signal: AbortSignal;
  }): Promise<{ assignedIMessageNumber: string }>;
  validateProjectCredential(input: {
    photonProjectId: string;
    spectrumProjectSecret: string;
    ownerPhoneNumber: string;
    assignedIMessageNumber: string;
    signal: AbortSignal;
  }): Promise<boolean>;
  rotateProjectSecret(input: {
    operationId: string;
    managementToken: string;
    photonProjectId: string;
    signal: AbortSignal;
  }): Promise<{ spectrumProjectSecret: string }>;
}

export interface LegacyPhotonInstallationCredentials {
  photonDeviceBearerToken: string;
  photonProjectId: string;
  spectrumProjectSecret: string;
  ownerPhoneNumber: string;
  assignedIMessageNumber: string;
}

export type PhotonInstallationStatus =
  | {
      state:
        | "not_started"
        | "token_acquired"
        | "project_claimed"
        | "owner_registering"
        | "needs_owner_rebind"
        | "needs_credential_repair";
      installationId: string;
    }
  | {
      state: "awaiting_device_authorization";
      installationId: string;
      userCode: string;
      verificationUrl: string;
      expiresAt: string;
    }
  | {
      state: "connected";
      installationId: string;
      photonProjectId: string;
      assignedPhoneNumber: string;
    }
  | {
      state: "failed";
      installationId: string;
      code: PhotonInstallationFailureCode;
    };

export function photonInstallationProjectName(
  installationId: string,
  prefix = "iMessage Codex Agent",
): string {
  const normalizedPrefix = prefix.trim();
  if (normalizedPrefix.length === 0 || normalizedPrefix.length > 80) {
    throw new Error("Photon project name prefix must contain 1 to 80 characters.");
  }
  return `${normalizedPrefix} - ${installationId}`;
}
