import { randomUUID } from "node:crypto";

import type {
  LegacyPhotonInstallationCredentials,
  OwnerBindingRevisionPort,
  OwnerBindingSnapshot,
  PhotonInstallationCipher,
  PhotonInstallationFailureCode,
  PhotonInstallationProviderPort,
  PhotonInstallationRecord,
  PhotonInstallationRepositoryPort,
  PhotonInstallationStatus,
} from "./photon-installation-contracts.js";
import {
  abortableSleep,
  assertE164,
  assertIdentifier,
  assertOwnerSnapshot,
  assertProjectId,
  isAbortError,
  journalWith,
  PhotonInstallationLifecycleError,
  PhotonInstallationStaleOperationError,
  stateForResume,
  type PhotonInstallationOperationMode,
} from "./photon-installation-state.js";
import { PhotonInstallationWorkflow } from "./photon-installation-workflow.js";

export {
  PhotonInstallationLifecycleError,
  PhotonInstallationStaleOperationError,
} from "./photon-installation-state.js";

interface ActiveOperation {
  mode: PhotonInstallationOperationMode;
  operationId: string;
  controller: AbortController;
  promise: Promise<PhotonInstallationStatus>;
}

export class PhotonInstallationService {
  readonly #installationId: string;
  readonly #deploymentId: string;
  readonly #repository: PhotonInstallationRepositoryPort;
  readonly #ownerBinding: OwnerBindingRevisionPort;
  readonly #cipher: PhotonInstallationCipher;
  readonly #operationIdFactory: () => string;
  readonly #workflow: PhotonInstallationWorkflow;
  #active: ActiveOperation | undefined;
  #closed = false;
  #validatedConnectedOperationId: string | undefined;

  public constructor(options: {
    installationId: string;
    deploymentId: string;
    repository: PhotonInstallationRepositoryPort;
    ownerBinding: OwnerBindingRevisionPort;
    provider: PhotonInstallationProviderPort;
    cipher: PhotonInstallationCipher;
    operationIdFactory?: () => string;
    projectNamePrefix?: string;
    now?: () => Date;
    sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  }) {
    assertIdentifier(options.installationId, "Installation ID");
    assertIdentifier(options.deploymentId, "Deployment ID");
    this.#installationId = options.installationId;
    this.#deploymentId = options.deploymentId;
    this.#repository = options.repository;
    this.#ownerBinding = options.ownerBinding;
    this.#cipher = options.cipher;
    this.#operationIdFactory = options.operationIdFactory ?? randomUUID;
    this.#workflow = new PhotonInstallationWorkflow({
      installationId: options.installationId,
      repository: options.repository,
      ownerBinding: options.ownerBinding,
      provider: options.provider,
      cipher: options.cipher,
      projectNamePrefix: options.projectNamePrefix ?? "iMessage Codex Agent",
      now: options.now ?? (() => new Date()),
      sleep: options.sleep ?? abortableSleep,
    });
  }

  public async status(): Promise<PhotonInstallationStatus> {
    const record = await this.#repository.load(this.#installationId);
    return record === undefined
      ? { state: "not_started", installationId: this.#installationId }
      : await this.#statusFromRecord(record);
  }

  public async start(): Promise<PhotonInstallationStatus> {
    return await this.#runOwned("start");
  }

  public async resume(): Promise<PhotonInstallationStatus> {
    return await this.#runOwned("resume");
  }

  public async repairCredentials(): Promise<PhotonInstallationStatus> {
    return await this.#runOwned("repair");
  }

  public async importLegacyCredentials(
    credentials: LegacyPhotonInstallationCredentials,
  ): Promise<PhotonInstallationStatus> {
    return await this.#runOwned("legacy_import", credentials);
  }

  public async cancel(): Promise<PhotonInstallationStatus> {
    const active = this.#active;
    if (active !== undefined) {
      active.controller.abort();
      await active.promise;
      const record = await this.#repository.load(this.#installationId);
      if (
        record !== undefined &&
        record.operationId === active.operationId
      ) {
        const cancelled = await this.#repository.checkpoint({
          installationId: record.installationId,
          operationId: record.operationId,
          ownerRevision: record.ownerRevision,
          expectedStates: [record.state],
          next: journalWith(record, {
            state: "failed",
            safeFailureCode: "operation_cancelled",
          }),
        });
        if (cancelled !== undefined) {
          return await this.#statusFromRecord(cancelled);
        }
      }
    }
    return await this.status();
  }

  public async close(): Promise<void> {
    this.#closed = true;
    const active = this.#active;
    if (active !== undefined) {
      active.controller.abort();
      await active.promise;
    }
  }

  async #runOwned(
    mode: PhotonInstallationOperationMode,
    legacyCredentials?: LegacyPhotonInstallationCredentials,
  ): Promise<PhotonInstallationStatus> {
    if (this.#closed) {
      throw new Error("Photon installation service is closed.");
    }
    const active = this.#active;
    if (active !== undefined) {
      if (
        (active.mode === "start" || active.mode === "resume") &&
        (mode === "start" || mode === "resume")
      ) {
        return await active.promise;
      }
      await active.promise;
      return await this.#runOwned(mode, legacyCredentials);
    }

    const operationId = this.#operationIdFactory();
    assertIdentifier(operationId, "Operation ID");
    const controller = new AbortController();
    const promise = this.#execute(
      mode,
      operationId,
      controller.signal,
      legacyCredentials,
    ).finally(() => {
      if (this.#active?.operationId === operationId) {
        this.#active = undefined;
      }
    });
    this.#active = { mode, operationId, controller, promise };
    return await promise;
  }

  async #execute(
    mode: PhotonInstallationOperationMode,
    operationId: string,
    signal: AbortSignal,
    legacyCredentials?: LegacyPhotonInstallationCredentials,
  ): Promise<PhotonInstallationStatus> {
    try {
      const owner = await this.#ownerBinding.read();
      assertOwnerSnapshot(owner);
      if (mode === "legacy_import") {
        const existing = await this.#repository.load(this.#installationId);
        if (
          existing !== undefined &&
          (existing.lastCompletedStep !== "not_started" ||
            existing.photonProjectId !== undefined ||
            existing.managementTokenCiphertext !== undefined ||
            existing.spectrumSecretCiphertext !== undefined)
        ) {
          return {
            state: "failed",
            installationId: this.#installationId,
            code: "legacy_credentials_rejected",
          };
        }
      }
      const record = await this.#claimRecord(mode, operationId, owner);
      let completed: PhotonInstallationRecord;
      if (mode === "legacy_import") {
        if (legacyCredentials === undefined) {
          throw new PhotonInstallationLifecycleError(
            "legacy_credentials_rejected",
          );
        }
        completed = await this.#workflow.importLegacy(
          record,
          owner,
          legacyCredentials,
          signal,
        );
      } else if (mode === "repair") {
        completed = await this.#workflow.repair(record, owner, signal);
      } else {
        completed = await this.#workflow.resume(record, owner, signal);
      }
      this.#validatedConnectedOperationId =
        completed.state === "connected"
          ? completed.operationId
          : undefined;
      return await this.#statusFromRecord(completed);
    } catch (error) {
      if (isAbortError(error)) {
        return await this.status();
      }
      if (error instanceof PhotonInstallationStaleOperationError) {
        const record = await this.#repository.load(this.#installationId);
        return record === undefined
          ? {
              state: "failed",
              installationId: this.#installationId,
              code: "operation_conflict",
            }
          : await this.#statusFromRecord(record);
      }
      const code =
        error instanceof PhotonInstallationLifecycleError
          ? error.code
          : "provider_unavailable";
      return await this.#recordFailure(operationId, code);
    }
  }

  async #claimRecord(
    mode: PhotonInstallationOperationMode,
    operationId: string,
    owner: OwnerBindingSnapshot,
  ): Promise<PhotonInstallationRecord> {
    let current = await this.#repository.load(this.#installationId);
    if (current === undefined) {
      current = await this.#repository.createInitial({
        installationId: this.#installationId,
        deploymentId: this.#deploymentId,
        ownerRevision: owner.ownerRevision,
        operationId,
      });
      if (current !== undefined) {
        return current;
      }
      current = await this.#repository.load(this.#installationId);
    }
    if (current === undefined || current.deploymentId !== this.#deploymentId) {
      throw new PhotonInstallationStaleOperationError();
    }
    const claimed = await this.#repository.claimOperation({
      installationId: current.installationId,
      expectedOperationId: current.operationId,
      expectedOwnerRevision: current.ownerRevision,
      nextOperationId: operationId,
      nextOwnerRevision: owner.ownerRevision,
      nextState: stateForResume(current, owner, mode),
    });
    if (claimed === undefined) {
      throw new PhotonInstallationStaleOperationError();
    }
    return claimed;
  }

  async #recordFailure(
    operationId: string,
    code: PhotonInstallationFailureCode,
  ): Promise<PhotonInstallationStatus> {
    const record = await this.#repository.load(this.#installationId);
    if (record === undefined || record.operationId !== operationId) {
      return {
        state: "failed",
        installationId: this.#installationId,
        code,
      };
    }
    const failed = await this.#repository.checkpoint({
      installationId: record.installationId,
      operationId: record.operationId,
      ownerRevision: record.ownerRevision,
      expectedStates: [record.state],
      next: journalWith(record, {
        state: "failed",
        safeFailureCode: code,
      }),
    });
    return failed === undefined
      ? {
          state: "failed",
          installationId: this.#installationId,
          code: "operation_conflict",
        }
      : await this.#statusFromRecord(failed);
  }

  async #statusFromRecord(
    record: PhotonInstallationRecord,
  ): Promise<PhotonInstallationStatus> {
    if (record.state === "awaiting_device_authorization") {
      if (
        record.deviceUserCode === undefined ||
        record.verificationUrl === undefined ||
        record.authorizationExpiresAt === undefined
      ) {
        return {
          state: "failed",
          installationId: record.installationId,
          code: "device_authorization_failed",
        };
      }
      return {
        state: record.state,
        installationId: record.installationId,
        userCode: record.deviceUserCode,
        verificationUrl: record.verificationUrl,
        expiresAt: record.authorizationExpiresAt.toISOString(),
      };
    }
    if (record.state === "connected") {
      if (
        this.#validatedConnectedOperationId !== record.operationId ||
        record.photonProjectId === undefined ||
        record.assignedNumberCiphertext === undefined
      ) {
        return {
          state: "needs_credential_repair",
          installationId: record.installationId,
        };
      }
      const currentOwner = await this.#ownerBinding.read();
      if (currentOwner.ownerRevision !== record.ownerRevision) {
        return {
          state: "needs_owner_rebind",
          installationId: record.installationId,
        };
      }
      let photonProjectId: string;
      let assignedPhoneNumber: string;
      try {
        photonProjectId = assertProjectId(record.photonProjectId);
        assignedPhoneNumber = assertE164(
          await this.#cipher.decrypt(record.assignedNumberCiphertext),
          "Photon assigned number",
        );
      } catch {
        return {
          state: "needs_credential_repair",
          installationId: record.installationId,
        };
      }
      return {
        state: record.state,
        installationId: record.installationId,
        photonProjectId,
        assignedPhoneNumber,
      };
    }
    if (record.state === "failed") {
      return {
        state: record.state,
        installationId: record.installationId,
        code: record.safeFailureCode ?? "provider_unavailable",
      };
    }
    return {
      state: record.state,
      installationId: record.installationId,
    };
  }
}

/** Production-facing name retained alongside the shorter domain name. */
export { PhotonInstallationService as DurablePhotonInstallationService };
