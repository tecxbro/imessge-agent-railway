import type {
  LegacyPhotonInstallationCredentials,
  OwnerBindingRevisionPort,
  PhotonInstallationCipher,
  PhotonInstallationRepositoryPort,
  PhotonInstallationStatus,
} from "./photon-installation-contracts.js";
import type { PhotonInstallationService } from "./photon-installation-service.js";
import type {
  PhotonSetupController,
  PhotonSetupCredentials,
  PhotonSetupStatus,
} from "./photon-setup.js";

type ConnectedListener = (
  credentials: PhotonSetupCredentials,
) => void | Promise<void>;
type StatusListener = (status: PhotonSetupStatus) => void | Promise<void>;

interface DurableBinding {
  service: Pick<
    PhotonInstallationService,
    "start" | "resume" | "status" | "close" | "importLegacyCredentials"
  >;
  repository: PhotonInstallationRepositoryPort;
  ownerBinding: OwnerBindingRevisionPort;
  cipher: PhotonInstallationCipher;
}

/** Synchronous dashboard facade over the durable asynchronous lifecycle. */
export class DurablePhotonSetupController implements PhotonSetupController {
  #binding: DurableBinding | undefined;
  #status: PhotonSetupStatus = { state: "not_connected" };
  #credentials: PhotonSetupCredentials | undefined;
  #activeAttempt: Promise<PhotonInstallationStatus> | undefined;
  #visibleAttempt: Promise<PhotonSetupStatus> | undefined;
  readonly #connectedListeners = new Set<ConnectedListener>();
  readonly #statusListeners = new Set<StatusListener>();

  public bind(binding: DurableBinding): void {
    if (this.#binding !== undefined) {
      throw new Error("Durable Photon setup is already bound.");
    }
    this.#binding = binding;
  }

  public status(): PhotonSetupStatus {
    return { ...this.#status };
  }

  public credentials(): PhotonSetupCredentials | undefined {
    return this.#credentials === undefined
      ? undefined
      : { ...this.#credentials };
  }

  public onConnected(listener: ConnectedListener): () => void {
    this.#connectedListeners.add(listener);
    return () => this.#connectedListeners.delete(listener);
  }

  public onStatusChanged(listener: StatusListener): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  public async start(): Promise<PhotonSetupStatus> {
    return await this.beginAttempt("start");
  }

  public async resume(): Promise<PhotonSetupStatus> {
    return await this.beginAttempt("resume");
  }

  public async refresh(): Promise<PhotonSetupStatus> {
    const binding = this.requiredBinding();
    return await this.apply(await binding.service.status());
  }

  public async importLegacyCredentials(
    credentials: LegacyPhotonInstallationCredentials,
  ): Promise<PhotonSetupStatus> {
    const binding = this.requiredBinding();
    return await this.apply(
      await binding.service.importLegacyCredentials(credentials),
    );
  }

  public async close(): Promise<void> {
    await this.#binding?.service.close();
    await this.#activeAttempt?.catch(() => undefined);
  }

  private async beginAttempt(
    mode: "start" | "resume",
  ): Promise<PhotonSetupStatus> {
    if (this.#visibleAttempt !== undefined) {
      return await this.#visibleAttempt;
    }
    const binding = this.requiredBinding();
    this.publish({ state: "provisioning" });
    const attempt =
      mode === "start" ? binding.service.start() : binding.service.resume();
    this.#activeAttempt = attempt;
    let resolveVisible!: (status: PhotonSetupStatus) => void;
    const visible = new Promise<PhotonSetupStatus>((resolve) => {
      resolveVisible = resolve;
    });
    this.#visibleAttempt = visible;

    void attempt
      .then(async (status) => {
        resolveVisible(await this.apply(status));
      })
      .catch(() => {
        resolveVisible(
          this.publish({ state: "failed", code: "PHOTON_SETUP_FAILED" }),
        );
      })
      .finally(() => {
        if (this.#activeAttempt === attempt) {
          this.#activeAttempt = undefined;
          this.#visibleAttempt = undefined;
        }
      });
    void this.publishDeviceAuthorizationCheckpoint(
      binding,
      attempt,
      resolveVisible,
    );
    return await visible;
  }

  private async publishDeviceAuthorizationCheckpoint(
    binding: DurableBinding,
    attempt: Promise<PhotonInstallationStatus>,
    resolveVisible: (status: PhotonSetupStatus) => void,
  ): Promise<void> {
    while (this.#activeAttempt === attempt) {
      try {
        const status = await binding.service.status();
        if (status.state === "awaiting_device_authorization") {
          resolveVisible(await this.apply(status));
          return;
        }
      } catch {
        // The owned workflow publishes the bounded terminal failure.
      }
      const completed = await Promise.race([
        attempt.then(
          () => true,
          () => true,
        ),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
      ]);
      if (completed) return;
    }
  }

  private requiredBinding(): DurableBinding {
    if (this.#binding === undefined) {
      throw new Error(
        "Photon installation storage is not ready. Wait for database startup and retry.",
      );
    }
    return this.#binding;
  }

  private async apply(
    status: PhotonInstallationStatus,
  ): Promise<PhotonSetupStatus> {
    if (status.state === "awaiting_device_authorization") {
      return this.publish({
        state: "awaiting_authorization",
        userCode: status.userCode,
        verificationUrl: status.verificationUrl,
        expiresAt: status.expiresAt,
      });
    }
    if (status.state === "connected") {
      const binding = this.requiredBinding();
      const record = await binding.repository.load(status.installationId);
      const owner = await binding.ownerBinding.read();
      if (
        record === undefined ||
        record.ownerRevision !== owner.ownerRevision ||
        record.managementTokenCiphertext === undefined ||
        record.spectrumSecretCiphertext === undefined ||
        record.assignedNumberCiphertext === undefined ||
        record.photonProjectId === undefined
      ) {
        this.#credentials = undefined;
        return this.publish({ state: "failed", code: "PHOTON_SETUP_FAILED" });
      }
      this.#credentials = {
        photonDeviceBearerToken: await binding.cipher.decrypt(
          record.managementTokenCiphertext,
        ),
        photonProjectId: record.photonProjectId,
        spectrumProjectSecret: await binding.cipher.decrypt(
          record.spectrumSecretCiphertext,
        ),
        ownerPhoneNumber: owner.ownerPhoneNumber,
        assignedIMessageNumber: await binding.cipher.decrypt(
          record.assignedNumberCiphertext,
        ),
      };
      const mapped = this.publish({
        state: "connected",
        assignedPhoneNumber: this.#credentials.assignedIMessageNumber,
      });
      for (const listener of this.#connectedListeners) {
        void Promise.resolve(listener({ ...this.#credentials })).catch(
          () => undefined,
        );
      }
      return mapped;
    }
    this.#credentials = undefined;
    if (status.state === "failed") {
      return this.publish({ state: "failed", code: "PHOTON_SETUP_FAILED" });
    }
    return this.publish({ state: "not_connected" });
  }

  private publish(status: PhotonSetupStatus): PhotonSetupStatus {
    this.#status = status;
    for (const listener of this.#statusListeners) {
      void Promise.resolve(listener({ ...status })).catch(() => undefined);
    }
    return this.status();
  }
}
