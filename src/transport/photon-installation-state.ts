import {
  PHOTON_INSTALLATION_STEPS,
  type OwnerBindingSnapshot,
  type PhotonInstallationFailureCode,
  type PhotonInstallationJournal,
  type PhotonInstallationRecord,
  type PhotonInstallationState,
} from "./photon-installation-contracts.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const E164 = /^\+[1-9]\d{7,14}$/u;
const MAX_PRIVATE_TEXT = 16_384;

export type PhotonInstallationOperationMode =
  | "start"
  | "resume"
  | "repair"
  | "legacy_import";

export type PhotonInstallationJournalMutation = {
  [Key in keyof PhotonInstallationJournal]?:
    | PhotonInstallationJournal[Key]
    | null;
};

export class PhotonInstallationLifecycleError extends Error {
  public constructor(
    public readonly code: PhotonInstallationFailureCode,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "PhotonInstallationLifecycleError";
  }
}

export class PhotonInstallationStaleOperationError extends Error {
  public constructor() {
    super("Photon installation journal rejected a stale operation.");
    this.name = "PhotonInstallationStaleOperationError";
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

export function assertIdentifier(value: string, field: string): void {
  if (!UUID.test(value)) {
    throw new Error(`${field} must be a UUID.`);
  }
}

export function assertPrivateText(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > MAX_PRIVATE_TEXT) {
    throw new Error(`${field} is invalid.`);
  }
  return normalized;
}

export function assertProjectId(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 256) {
    throw new Error("Photon project ID is invalid.");
  }
  return normalized;
}

export function assertE164(value: string, field: string): string {
  if (!E164.test(value)) {
    throw new Error(`${field} must be normalized E.164.`);
  }
  return value;
}

export function assertOwnerSnapshot(snapshot: OwnerBindingSnapshot): void {
  if (!Number.isSafeInteger(snapshot.ownerRevision) || snapshot.ownerRevision < 0) {
    throw new Error("Owner revision is invalid.");
  }
  assertE164(snapshot.ownerPhoneNumber, "Owner phone number");
}

export function stepAtLeast(
  current: PhotonInstallationRecord["lastCompletedStep"],
  expected: PhotonInstallationRecord["lastCompletedStep"],
): boolean {
  return (
    PHOTON_INSTALLATION_STEPS.indexOf(current) >=
    PHOTON_INSTALLATION_STEPS.indexOf(expected)
  );
}

function selectedValue<Key extends keyof PhotonInstallationJournal>(
  key: Key,
  recordValue: PhotonInstallationJournal[Key] | undefined,
  mutation: PhotonInstallationJournalMutation,
): PhotonInstallationJournal[Key] | undefined {
  if (!(key in mutation)) {
    return recordValue;
  }
  const next = mutation[key];
  return next === null ? undefined : next;
}

export function journalWith(
  record: PhotonInstallationRecord,
  mutation: PhotonInstallationJournalMutation,
): PhotonInstallationJournal {
  const photonProjectId = selectedValue(
    "photonProjectId",
    record.photonProjectId,
    mutation,
  );
  const managementTokenCiphertext = selectedValue(
    "managementTokenCiphertext",
    record.managementTokenCiphertext,
    mutation,
  );
  const spectrumSecretCiphertext = selectedValue(
    "spectrumSecretCiphertext",
    record.spectrumSecretCiphertext,
    mutation,
  );
  const assignedNumberCiphertext = selectedValue(
    "assignedNumberCiphertext",
    record.assignedNumberCiphertext,
    mutation,
  );
  const deviceCodeCiphertext = selectedValue(
    "deviceCodeCiphertext",
    record.deviceCodeCiphertext,
    mutation,
  );
  const deviceUserCode = selectedValue(
    "deviceUserCode",
    record.deviceUserCode,
    mutation,
  );
  const verificationUrl = selectedValue(
    "verificationUrl",
    record.verificationUrl,
    mutation,
  );
  const authorizationExpiresAt = selectedValue(
    "authorizationExpiresAt",
    record.authorizationExpiresAt,
    mutation,
  );
  const pollIntervalMs = selectedValue(
    "pollIntervalMs",
    record.pollIntervalMs,
    mutation,
  );
  const safeFailureCode = selectedValue(
    "safeFailureCode",
    record.safeFailureCode,
    mutation,
  );

  return {
    state: mutation.state ?? record.state,
    ...(photonProjectId === undefined ? {} : { photonProjectId }),
    ...(managementTokenCiphertext === undefined
      ? {}
      : { managementTokenCiphertext }),
    ...(spectrumSecretCiphertext === undefined
      ? {}
      : { spectrumSecretCiphertext }),
    ...(assignedNumberCiphertext === undefined
      ? {}
      : { assignedNumberCiphertext }),
    ...(deviceCodeCiphertext === undefined
      ? {}
      : { deviceCodeCiphertext }),
    ...(deviceUserCode === undefined ? {} : { deviceUserCode }),
    ...(verificationUrl === undefined ? {} : { verificationUrl }),
    ...(authorizationExpiresAt === undefined
      ? {}
      : { authorizationExpiresAt }),
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
    lastCompletedStep:
      mutation.lastCompletedStep ?? record.lastCompletedStep,
    ...(safeFailureCode === undefined ? {} : { safeFailureCode }),
  };
}

export function stateForResume(
  record: PhotonInstallationRecord,
  owner: OwnerBindingSnapshot,
  mode: PhotonInstallationOperationMode,
): PhotonInstallationState {
  if (mode === "repair") {
    return "needs_credential_repair";
  }
  if (
    record.ownerRevision !== owner.ownerRevision &&
    record.photonProjectId !== undefined &&
    record.spectrumSecretCiphertext !== undefined
  ) {
    return "needs_owner_rebind";
  }
  if (
    record.state === "needs_credential_repair" ||
    record.state === "needs_owner_rebind" ||
    record.state === "connected"
  ) {
    return record.state;
  }
  if (
    record.photonProjectId !== undefined &&
    record.spectrumSecretCiphertext !== undefined
  ) {
    return "owner_registering";
  }
  if (record.photonProjectId !== undefined) {
    return "project_claimed";
  }
  if (record.managementTokenCiphertext !== undefined) {
    return "token_acquired";
  }
  if (
    record.deviceCodeCiphertext !== undefined &&
    record.authorizationExpiresAt !== undefined
  ) {
    return "awaiting_device_authorization";
  }
  return "not_started";
}

export function abortableSleep(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Operation aborted.", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Operation aborted.", "AbortError"));
      },
      { once: true },
    );
  });
}
