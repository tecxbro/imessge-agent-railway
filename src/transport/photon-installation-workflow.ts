import {
  photonInstallationProjectName,
  type LegacyPhotonInstallationCredentials,
  type OwnerBindingRevisionPort,
  type OwnerBindingSnapshot,
  type PhotonInstallationCipher,
  type PhotonInstallationFailureCode,
  type PhotonInstallationProviderPort,
  type PhotonInstallationRecord,
  type PhotonInstallationRepositoryPort,
} from "./photon-installation-contracts.js";
import {
  assertE164,
  assertOwnerSnapshot,
  assertPrivateText,
  assertProjectId,
  isAbortError,
  journalWith,
  PhotonInstallationLifecycleError,
  PhotonInstallationStaleOperationError,
  stepAtLeast,
  type PhotonInstallationJournalMutation,
} from "./photon-installation-state.js";

export class PhotonInstallationWorkflow {
  readonly #installationId: string;
  readonly #repository: PhotonInstallationRepositoryPort;
  readonly #ownerBinding: OwnerBindingRevisionPort;
  readonly #provider: PhotonInstallationProviderPort;
  readonly #cipher: PhotonInstallationCipher;
  readonly #projectNamePrefix: string;
  readonly #now: () => Date;
  readonly #sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;

  public constructor(options: {
    installationId: string;
    repository: PhotonInstallationRepositoryPort;
    ownerBinding: OwnerBindingRevisionPort;
    provider: PhotonInstallationProviderPort;
    cipher: PhotonInstallationCipher;
    projectNamePrefix: string;
    now: () => Date;
    sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  }) {
    this.#installationId = options.installationId;
    this.#repository = options.repository;
    this.#ownerBinding = options.ownerBinding;
    this.#provider = options.provider;
    this.#cipher = options.cipher;
    this.#projectNamePrefix = options.projectNamePrefix;
    this.#now = options.now;
    this.#sleep = options.sleep;
  }

  public async resume(
    initial: PhotonInstallationRecord,
    owner: OwnerBindingSnapshot,
    signal: AbortSignal,
  ): Promise<PhotonInstallationRecord> {
    if (initial.state === "needs_credential_repair") {
      return initial;
    }
    if (initial.state === "connected") {
      return await this.#validateExisting(initial, owner, signal);
    }

    let record = initial;
    if (record.state === "needs_owner_rebind") {
      record = await this.#checkpoint(record, {
        state: "owner_registering",
        assignedNumberCiphertext: null,
        lastCompletedStep: "project_credential_stored",
      });
      return await this.#registerAndValidate(record, owner, signal, true);
    }

    record = await this.#ensureManagementToken(record, owner, signal);
    record = await this.#ensureProject(record, owner, signal);
    record = await this.#ensureInitialProjectSecret(record, owner, signal);
    return await this.#registerAndValidate(record, owner, signal, false);
  }

  public async repair(
    record: PhotonInstallationRecord,
    owner: OwnerBindingSnapshot,
    signal: AbortSignal,
  ): Promise<PhotonInstallationRecord> {
    if (
      record.photonProjectId === undefined ||
      record.managementTokenCiphertext === undefined ||
      record.spectrumSecretCiphertext === undefined
    ) {
      throw new PhotonInstallationLifecycleError(
        "project_credential_failed",
      );
    }
    const managementToken = assertPrivateText(
      await this.#cipher.decrypt(record.managementTokenCiphertext),
      "Photon management token",
    );
    const photonProjectId = assertProjectId(record.photonProjectId);
    const tokenValid = await this.#providerCall(
      "management_token_invalid",
      owner,
      signal,
      async () =>
        await this.#provider.validateManagementToken({
          managementToken,
          signal,
        }),
    );
    if (!tokenValid) {
      throw new PhotonInstallationLifecycleError("management_token_invalid");
    }

    const rotated = await this.#providerCall(
      "project_credential_failed",
      owner,
      signal,
      async () =>
        await this.#provider.rotateProjectSecret({
          operationId: record.operationId,
          managementToken,
          photonProjectId,
          signal,
        }),
    );
    const newSecret = assertPrivateText(
      rotated.spectrumProjectSecret,
      "Spectrum project secret",
    );
    const registration = await this.#providerCall(
      "owner_registration_failed",
      owner,
      signal,
      async () =>
        await this.#provider.registerOwner({
          operationId: record.operationId,
          photonProjectId,
          spectrumProjectSecret: newSecret,
          ownerPhoneNumber: owner.ownerPhoneNumber,
          signal,
        }),
    );
    const assignedIMessageNumber = assertE164(
      registration.assignedIMessageNumber,
      "Photon assigned number",
    );
    const valid = await this.#providerCall(
      "credential_validation_failed",
      owner,
      signal,
      async () =>
        await this.#provider.validateProjectCredential({
          photonProjectId,
          spectrumProjectSecret: newSecret,
          ownerPhoneNumber: owner.ownerPhoneNumber,
          assignedIMessageNumber,
          signal,
        }),
    );
    if (!valid) {
      throw new PhotonInstallationLifecycleError(
        "credential_validation_failed",
      );
    }
    return await this.#checkpoint(record, {
      state: "connected",
      spectrumSecretCiphertext: await this.#cipher.encrypt(newSecret),
      assignedNumberCiphertext: await this.#cipher.encrypt(
        assignedIMessageNumber,
      ),
      lastCompletedStep: "credential_validated",
      safeFailureCode: null,
    });
  }

  public async importLegacy(
    record: PhotonInstallationRecord,
    owner: OwnerBindingSnapshot,
    credentials: LegacyPhotonInstallationCredentials,
    signal: AbortSignal,
  ): Promise<PhotonInstallationRecord> {
    if (
      record.lastCompletedStep !== "not_started" ||
      record.photonProjectId !== undefined ||
      record.managementTokenCiphertext !== undefined ||
      record.spectrumSecretCiphertext !== undefined
    ) {
      throw new PhotonInstallationLifecycleError(
        "legacy_credentials_rejected",
      );
    }
    if (
      assertE164(credentials.ownerPhoneNumber, "Legacy owner phone number") !==
      owner.ownerPhoneNumber
    ) {
      throw new PhotonInstallationLifecycleError(
        "legacy_credentials_rejected",
      );
    }
    const managementToken = assertPrivateText(
      credentials.photonDeviceBearerToken,
      "Legacy management token",
    );
    const photonProjectId = assertProjectId(credentials.photonProjectId);
    const spectrumProjectSecret = assertPrivateText(
      credentials.spectrumProjectSecret,
      "Legacy Spectrum secret",
    );
    const assignedIMessageNumber = assertE164(
      credentials.assignedIMessageNumber,
      "Legacy assigned number",
    );
    const tokenValid = await this.#providerCall(
      "legacy_credentials_rejected",
      owner,
      signal,
      async () =>
        await this.#provider.validateManagementToken({
          managementToken,
          signal,
        }),
    );
    const credentialValid = await this.#providerCall(
      "legacy_credentials_rejected",
      owner,
      signal,
      async () =>
        await this.#provider.validateProjectCredential({
          photonProjectId,
          spectrumProjectSecret,
          ownerPhoneNumber: owner.ownerPhoneNumber,
          assignedIMessageNumber,
          signal,
        }),
    );
    if (!tokenValid || !credentialValid) {
      throw new PhotonInstallationLifecycleError(
        "legacy_credentials_rejected",
      );
    }
    return await this.#checkpoint(record, {
      state: "connected",
      photonProjectId,
      managementTokenCiphertext: await this.#cipher.encrypt(managementToken),
      spectrumSecretCiphertext: await this.#cipher.encrypt(
        spectrumProjectSecret,
      ),
      assignedNumberCiphertext: await this.#cipher.encrypt(
        assignedIMessageNumber,
      ),
      lastCompletedStep: "legacy_credentials_imported",
      safeFailureCode: null,
    });
  }

  async #ensureManagementToken(
    initial: PhotonInstallationRecord,
    owner: OwnerBindingSnapshot,
    signal: AbortSignal,
  ): Promise<PhotonInstallationRecord> {
    let record = initial;
    if (record.managementTokenCiphertext === undefined) {
      if (
        record.deviceCodeCiphertext === undefined ||
        record.authorizationExpiresAt === undefined
      ) {
        const authorization = await this.#providerCall(
          "device_authorization_failed",
          owner,
          signal,
          async () =>
            await this.#provider.requestDeviceAuthorization({
              operationId: record.operationId,
              signal,
            }),
        );
        const verificationUrl = new URL(authorization.verificationUrl);
        if (
          verificationUrl.protocol !== "https:" ||
          verificationUrl.hostname !== "app.photon.codes" ||
          authorization.expiresAt.getTime() <= this.#now().getTime() ||
          !Number.isSafeInteger(authorization.pollIntervalMs) ||
          authorization.pollIntervalMs < 1 ||
          authorization.pollIntervalMs > 300_000
        ) {
          throw new PhotonInstallationLifecycleError(
            "device_authorization_failed",
          );
        }
        record = await this.#checkpoint(record, {
          state: "awaiting_device_authorization",
          deviceCodeCiphertext: await this.#cipher.encrypt(
            assertPrivateText(authorization.deviceCode, "Photon device code"),
          ),
          deviceUserCode: assertPrivateText(
            authorization.userCode,
            "Photon user code",
          ),
          verificationUrl: authorization.verificationUrl,
          authorizationExpiresAt: authorization.expiresAt,
          pollIntervalMs: authorization.pollIntervalMs,
          lastCompletedStep: "device_authorization_requested",
          safeFailureCode: null,
        });
      }

      const deviceCode = await this.#cipher.decrypt(
        record.deviceCodeCiphertext!,
      );
      let pollIntervalMs = record.pollIntervalMs ?? 5_000;
      for (;;) {
        if (
          record.authorizationExpiresAt === undefined ||
          this.#now().getTime() >= record.authorizationExpiresAt.getTime()
        ) {
          throw new PhotonInstallationLifecycleError(
            "authorization_expired",
          );
        }
        await this.#sleep(pollIntervalMs, signal);
        const exchange = await this.#providerCall(
          "device_authorization_failed",
          owner,
          signal,
          async () =>
            await this.#provider.exchangeDeviceCode({
              deviceCode,
              operationId: record.operationId,
              signal,
            }),
        );
        if (exchange.state === "pending") {
          continue;
        }
        if (exchange.state === "slow_down") {
          pollIntervalMs = Math.min(
            exchange.retryAfterMs ?? pollIntervalMs + 5_000,
            300_000,
          );
          record = await this.#checkpoint(record, { pollIntervalMs });
          continue;
        }
        if (exchange.state === "denied") {
          throw new PhotonInstallationLifecycleError("authorization_denied");
        }
        if (exchange.state === "expired") {
          throw new PhotonInstallationLifecycleError("authorization_expired");
        }
        record = await this.#checkpoint(record, {
          state: "token_acquired",
          managementTokenCiphertext: await this.#cipher.encrypt(
            assertPrivateText(
              exchange.managementToken,
              "Photon management token",
            ),
          ),
          deviceCodeCiphertext: null,
          deviceUserCode: null,
          verificationUrl: null,
          pollIntervalMs: null,
          lastCompletedStep: "token_acquired",
        });
        break;
      }
    }

    const managementToken = assertPrivateText(
      await this.#cipher.decrypt(record.managementTokenCiphertext!),
      "Photon management token",
    );
    const valid = await this.#providerCall(
      "management_token_invalid",
      owner,
      signal,
      async () =>
        await this.#provider.validateManagementToken({
          managementToken,
          signal,
        }),
    );
    if (!valid) {
      throw new PhotonInstallationLifecycleError("management_token_invalid");
    }
    return record;
  }

  async #ensureProject(
    record: PhotonInstallationRecord,
    owner: OwnerBindingSnapshot,
    signal: AbortSignal,
  ): Promise<PhotonInstallationRecord> {
    if (record.photonProjectId !== undefined) {
      return record;
    }
    const managementToken = assertPrivateText(
      await this.#cipher.decrypt(record.managementTokenCiphertext!),
      "Photon management token",
    );
    const project = await this.#providerCall(
      "project_creation_failed",
      owner,
      signal,
      async () =>
        await this.#provider.createProject({
          installationId: this.#installationId,
          operationId: record.operationId,
          managementToken,
          projectName: photonInstallationProjectName(
            this.#installationId,
            this.#projectNamePrefix,
          ),
          signal,
        }),
    );
    return await this.#checkpoint(record, {
      state: "project_claimed",
      photonProjectId: assertProjectId(project.photonProjectId),
      lastCompletedStep: "project_claimed",
    });
  }

  async #ensureInitialProjectSecret(
    record: PhotonInstallationRecord,
    owner: OwnerBindingSnapshot,
    signal: AbortSignal,
  ): Promise<PhotonInstallationRecord> {
    if (record.spectrumSecretCiphertext !== undefined) {
      return record;
    }
    const photonProjectId = assertProjectId(record.photonProjectId!);
    const managementToken = assertPrivateText(
      await this.#cipher.decrypt(record.managementTokenCiphertext!),
      "Photon management token",
    );
    const credential = await this.#providerCall(
      "project_credential_failed",
      owner,
      signal,
      async () =>
        await this.#provider.provisionInitialProjectSecret({
          installationId: this.#installationId,
          operationId: record.operationId,
          managementToken,
          photonProjectId,
          signal,
        }),
    );
    return await this.#checkpoint(record, {
      state: "project_claimed",
      spectrumSecretCiphertext: await this.#cipher.encrypt(
        assertPrivateText(
          credential.spectrumProjectSecret,
          "Spectrum project secret",
        ),
      ),
      lastCompletedStep: "project_credential_stored",
    });
  }

  async #registerAndValidate(
    initial: PhotonInstallationRecord,
    owner: OwnerBindingSnapshot,
    signal: AbortSignal,
    forceRegistration: boolean,
  ): Promise<PhotonInstallationRecord> {
    let record = initial;
    if (record.state !== "owner_registering") {
      record = await this.#checkpoint(record, {
        state: "owner_registering",
      });
    }
    if (
      forceRegistration ||
      record.assignedNumberCiphertext === undefined ||
      !stepAtLeast(record.lastCompletedStep, "owner_registered")
    ) {
      const photonProjectId = assertProjectId(record.photonProjectId!);
      const spectrumProjectSecret = assertPrivateText(
        await this.#cipher.decrypt(record.spectrumSecretCiphertext!),
        "Spectrum project secret",
      );
      const registration = await this.#providerCall(
        "owner_registration_failed",
        owner,
        signal,
        async () =>
          await this.#provider.registerOwner({
            operationId: record.operationId,
            photonProjectId,
            spectrumProjectSecret,
            ownerPhoneNumber: owner.ownerPhoneNumber,
            signal,
          }),
      );
      record = await this.#checkpoint(record, {
        state: "owner_registering",
        assignedNumberCiphertext: await this.#cipher.encrypt(
          assertE164(
            registration.assignedIMessageNumber,
            "Photon assigned number",
          ),
        ),
        lastCompletedStep: "owner_registered",
      });
    }
    return await this.#validateExisting(record, owner, signal);
  }

  async #validateExisting(
    record: PhotonInstallationRecord,
    owner: OwnerBindingSnapshot,
    signal: AbortSignal,
  ): Promise<PhotonInstallationRecord> {
    if (
      record.ownerRevision !== owner.ownerRevision ||
      record.photonProjectId === undefined ||
      record.spectrumSecretCiphertext === undefined ||
      record.assignedNumberCiphertext === undefined
    ) {
      return await this.#checkpoint(record, {
        state:
          record.ownerRevision === owner.ownerRevision
            ? "needs_credential_repair"
            : "needs_owner_rebind",
        safeFailureCode: "credential_validation_failed",
      });
    }
    let photonProjectId: string;
    let spectrumProjectSecret: string;
    let assignedIMessageNumber: string;
    try {
      photonProjectId = assertProjectId(record.photonProjectId);
      spectrumProjectSecret = assertPrivateText(
        await this.#cipher.decrypt(record.spectrumSecretCiphertext),
        "Spectrum project secret",
      );
      assignedIMessageNumber = assertE164(
        await this.#cipher.decrypt(record.assignedNumberCiphertext),
        "Photon assigned number",
      );
    } catch {
      return await this.#checkpoint(record, {
        state: "needs_credential_repair",
        safeFailureCode: "credential_validation_failed",
      });
    }
    const valid = await this.#providerCall(
      "credential_validation_failed",
      owner,
      signal,
      async () =>
        await this.#provider.validateProjectCredential({
          photonProjectId,
          spectrumProjectSecret,
          ownerPhoneNumber: owner.ownerPhoneNumber,
          assignedIMessageNumber,
          signal,
        }),
    );
    if (!valid) {
      return await this.#checkpoint(record, {
        state: "needs_credential_repair",
        safeFailureCode: "credential_validation_failed",
      });
    }
    return await this.#checkpoint(record, {
      state: "connected",
      lastCompletedStep: "credential_validated",
      safeFailureCode: null,
    });
  }

  async #providerCall<Result>(
    failureCode: PhotonInstallationFailureCode,
    owner: OwnerBindingSnapshot,
    signal: AbortSignal,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    try {
      await this.#assertCurrentOwner(owner, signal);
      let result: Result;
      try {
        result = await operation();
      } catch (error) {
        await this.#assertCurrentOwner(owner, signal);
        throw error;
      }
      await this.#assertCurrentOwner(owner, signal);
      return result;
    } catch (error) {
      if (
        isAbortError(error) ||
        error instanceof PhotonInstallationLifecycleError
      ) {
        throw error;
      }
      throw new PhotonInstallationLifecycleError(failureCode, {
        cause: error,
      });
    }
  }

  async #assertCurrentOwner(
    expected: OwnerBindingSnapshot,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) {
      throw new DOMException("Operation aborted.", "AbortError");
    }
    const current = await this.#ownerBinding.read();
    assertOwnerSnapshot(current);
    if (
      current.ownerRevision !== expected.ownerRevision ||
      current.ownerPhoneNumber !== expected.ownerPhoneNumber
    ) {
      throw new PhotonInstallationLifecycleError("owner_revision_changed");
    }
  }

  async #checkpoint(
    record: PhotonInstallationRecord,
    mutation: PhotonInstallationJournalMutation,
  ): Promise<PhotonInstallationRecord> {
    const updated = await this.#repository.checkpoint({
      installationId: record.installationId,
      operationId: record.operationId,
      ownerRevision: record.ownerRevision,
      expectedStates: [record.state],
      next: journalWith(record, mutation),
    });
    if (updated === undefined) {
      throw new PhotonInstallationStaleOperationError();
    }
    return updated;
  }
}
