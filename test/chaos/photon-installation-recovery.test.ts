import { describe, expect, it } from "vitest";

import { PhotonInstallationService } from "../../src/transport/photon-installation-service.js";
import type {
  CheckpointPhotonInstallationInput,
  ClaimPhotonInstallationOperationInput,
  CreatePhotonInstallationInput,
  PhotonInstallationProviderPort,
  PhotonInstallationRecord,
  PhotonInstallationRepositoryPort,
} from "../../src/transport/photon-installation-contracts.js";

const DEPLOYMENT_ID = "51000000-0000-4000-8000-000000000001";
const INSTALLATION_ID = "52000000-0000-4000-8000-000000000001";

class CrashCheckpointRepository
  implements PhotonInstallationRepositoryPort
{
  public record: PhotonInstallationRecord | undefined;
  public checkpointCount = 0;
  public crashAt: number | undefined;
  #crashed = false;

  public async load(): Promise<PhotonInstallationRecord | undefined> {
    return this.record === undefined ? undefined : structuredClone(this.record);
  }

  public async createInitial(input: CreatePhotonInstallationInput) {
    if (this.record !== undefined) {
      return undefined;
    }
    const now = new Date("2026-08-18T16:00:00.000Z");
    this.record = {
      ...input,
      state: "not_started",
      lastCompletedStep: "not_started",
      journalVersion: 0,
      createdAt: now,
      updatedAt: now,
    };
    return structuredClone(this.record);
  }

  public async claimOperation(input: ClaimPhotonInstallationOperationInput) {
    const current = this.record;
    if (
      current === undefined ||
      current.operationId !== input.expectedOperationId ||
      current.ownerRevision !== input.expectedOwnerRevision
    ) {
      return undefined;
    }
    const { safeFailureCode: _failure, ...withoutFailure } = current;
    this.record = {
      ...withoutFailure,
      operationId: input.nextOperationId,
      ownerRevision: input.nextOwnerRevision,
      state: input.nextState,
      journalVersion: current.journalVersion + 1,
    };
    return structuredClone(this.record);
  }

  public async checkpoint(input: CheckpointPhotonInstallationInput) {
    const current = this.record;
    if (
      current === undefined ||
      current.operationId !== input.operationId ||
      current.ownerRevision !== input.ownerRevision ||
      !input.expectedStates.includes(current.state)
    ) {
      return undefined;
    }
    this.record = {
      installationId: current.installationId,
      deploymentId: current.deploymentId,
      ownerRevision: current.ownerRevision,
      operationId: current.operationId,
      ...input.next,
      journalVersion: current.journalVersion + 1,
      createdAt: current.createdAt,
      updatedAt: new Date("2026-08-18T16:01:00.000Z"),
    };
    this.checkpointCount += 1;
    if (!this.#crashed && this.checkpointCount === this.crashAt) {
      this.#crashed = true;
      throw new DOMException("simulated process loss", "AbortError");
    }
    return structuredClone(this.record);
  }
}

class RecoveryProvider implements PhotonInstallationProviderPort {
  public requestCalls = 0;
  public createCalls = 0;
  public initialSecretCalls = 0;
  public registerCalls = 0;
  public rotateCalls = 0;

  public async requestDeviceAuthorization() {
    this.requestCalls += 1;
    return {
      deviceCode: "durable-device-code",
      userCode: "RECOVER",
      verificationUrl: "https://app.photon.codes/device",
      expiresAt: new Date("2026-08-18T18:00:00.000Z"),
      pollIntervalMs: 1,
    };
  }

  public async exchangeDeviceCode() {
    return { state: "authorized" as const, managementToken: "durable-token" };
  }

  public async validateManagementToken() {
    return true;
  }

  public async createProject() {
    this.createCalls += 1;
    return { photonProjectId: "durable-exact-project-id" };
  }

  public async provisionInitialProjectSecret() {
    this.initialSecretCalls += 1;
    return { spectrumProjectSecret: "durable-project-secret" };
  }

  public async registerOwner() {
    this.registerCalls += 1;
    return { assignedIMessageNumber: "+15555550777" };
  }

  public async validateProjectCredential() {
    return true;
  }

  public async rotateProjectSecret() {
    this.rotateCalls += 1;
    return { spectrumProjectSecret: "unexpected-rotation" };
  }
}

function operationIds() {
  let next = 0;
  return () => {
    next += 1;
    return `53000000-0000-4000-8000-${String(next).padStart(12, "0")}`;
  };
}

function service(
  repository: CrashCheckpointRepository,
  provider: RecoveryProvider,
  operationIdFactory: () => string,
) {
  return new PhotonInstallationService({
    installationId: INSTALLATION_ID,
    deploymentId: DEPLOYMENT_ID,
    repository,
    provider,
    ownerBinding: {
      read: async () => ({
        ownerRevision: 1,
        ownerPhoneNumber: "+15555550123",
      }),
    },
    cipher: {
      encrypt: (plaintext) => `cipher:${plaintext}`,
      decrypt: (ciphertext) => ciphertext.slice("cipher:".length),
    },
    operationIdFactory,
    now: () => new Date("2026-08-18T16:00:00.000Z"),
    sleep: async () => undefined,
  });
}

describe("Photon installation checkpoint recovery", () => {
  it.each([1, 2, 3, 4, 5, 6, 7])(
    "resumes after process loss following journal checkpoint %i",
    async (crashAt) => {
      const repository = new CrashCheckpointRepository();
      repository.crashAt = crashAt;
      const provider = new RecoveryProvider();
      const ids = operationIds();

      await service(repository, provider, ids).start();
      const recovered = await service(repository, provider, ids).resume();

      expect(recovered.state).toBe("connected");
      expect(repository.record).toMatchObject({
        state: "connected",
        photonProjectId: "durable-exact-project-id",
        lastCompletedStep: "credential_validated",
      });
      expect(provider.requestCalls).toBe(1);
      expect(provider.createCalls).toBe(1);
      expect(provider.initialSecretCalls).toBe(1);
      expect(provider.registerCalls).toBe(1);
      expect(provider.rotateCalls).toBe(0);
    },
  );
});
