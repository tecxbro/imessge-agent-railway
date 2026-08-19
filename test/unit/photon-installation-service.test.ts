import { describe, expect, it } from "vitest";

import {
  PhotonInstallationService,
} from "../../src/transport/photon-installation-service.js";
import type {
  CheckpointPhotonInstallationInput,
  ClaimPhotonInstallationOperationInput,
  CreatePhotonInstallationInput,
  OwnerBindingSnapshot,
  PhotonDeviceTokenExchange,
  PhotonInstallationCipher,
  PhotonInstallationProviderPort,
  PhotonInstallationRecord,
  PhotonInstallationRepositoryPort,
} from "../../src/transport/photon-installation-contracts.js";

const DEPLOYMENT_ID = "10000000-0000-4000-8000-000000000001";
const INSTALLATION_A = "20000000-0000-4000-8000-000000000001";
const INSTALLATION_B = "20000000-0000-4000-8000-000000000002";

function cloneRecord(record: PhotonInstallationRecord): PhotonInstallationRecord {
  return structuredClone(record);
}

class MemoryInstallationRepository
  implements PhotonInstallationRepositoryPort
{
  public record: PhotonInstallationRecord | undefined;

  public async load(): Promise<PhotonInstallationRecord | undefined> {
    return this.record === undefined ? undefined : cloneRecord(this.record);
  }

  public async createInitial(
    input: CreatePhotonInstallationInput,
  ): Promise<PhotonInstallationRecord | undefined> {
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
    return cloneRecord(this.record);
  }

  public async claimOperation(
    input: ClaimPhotonInstallationOperationInput,
  ): Promise<PhotonInstallationRecord | undefined> {
    const current = this.record;
    if (
      current === undefined ||
      current.installationId !== input.installationId ||
      current.operationId !== input.expectedOperationId ||
      current.ownerRevision !== input.expectedOwnerRevision
    ) {
      return undefined;
    }
    const { safeFailureCode: _safeFailureCode, ...withoutFailure } = current;
    const claimed: PhotonInstallationRecord = {
      ...withoutFailure,
      operationId: input.nextOperationId,
      ownerRevision: input.nextOwnerRevision,
      state: input.nextState,
      journalVersion: current.journalVersion + 1,
      updatedAt: new Date("2026-08-18T16:01:00.000Z"),
    };
    this.record = claimed;
    return cloneRecord(claimed);
  }

  public async checkpoint(
    input: CheckpointPhotonInstallationInput,
  ): Promise<PhotonInstallationRecord | undefined> {
    const current = this.record;
    if (
      current === undefined ||
      current.installationId !== input.installationId ||
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
      updatedAt: new Date("2026-08-18T16:02:00.000Z"),
    };
    return cloneRecord(this.record);
  }

  public invalidateForOwner(ownerRevision: number): void {
    if (this.record === undefined) {
      return;
    }
    this.record = {
      ...this.record,
      ownerRevision,
      operationId: "90000000-0000-4000-8000-000000000001",
      state:
        this.record.photonProjectId !== undefined &&
        this.record.spectrumSecretCiphertext !== undefined
          ? "needs_owner_rebind"
          : this.record.state,
      journalVersion: this.record.journalVersion + 1,
    };
  }

  public stealOperation(): void {
    if (this.record !== undefined) {
      this.record = {
        ...this.record,
        operationId: "90000000-0000-4000-8000-000000000002",
        journalVersion: this.record.journalVersion + 1,
      };
    }
  }
}

class MutableOwnerBinding {
  public snapshot: OwnerBindingSnapshot = {
    ownerRevision: 1,
    ownerPhoneNumber: "+15555550123",
  };

  public async read(): Promise<OwnerBindingSnapshot> {
    return { ...this.snapshot };
  }
}

const cipher: PhotonInstallationCipher = {
  encrypt: (plaintext) => `cipher:${plaintext}`,
  decrypt: (ciphertext) => {
    if (!ciphertext.startsWith("cipher:")) {
      throw new Error("Unexpected test ciphertext.");
    }
    return ciphertext.slice("cipher:".length);
  },
};

class FakePhotonProvider implements PhotonInstallationProviderPort {
  public requestCalls = 0;
  public exchangeCalls = 0;
  public createCalls = 0;
  public initialSecretCalls = 0;
  public registerCalls = 0;
  public validateCalls = 0;
  public rotateCalls = 0;
  public projectNames: string[] = [];
  public validCredential = true;
  public throwOnRotate = false;
  public onCreateProject: (() => void) | undefined;
  public onInitialSecret: (() => void) | undefined;
  public exchange: PhotonDeviceTokenExchange = {
    state: "authorized",
    managementToken: "management-token",
  };
  readonly #projects = new Map<string, string>();
  readonly #initialSecrets = new Map<string, string>();

  public async requestDeviceAuthorization() {
    this.requestCalls += 1;
    return {
      deviceCode: "device-code",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://app.photon.codes/device",
      expiresAt: new Date("2026-08-18T18:00:00.000Z"),
      pollIntervalMs: 1,
    };
  }

  public async exchangeDeviceCode() {
    this.exchangeCalls += 1;
    return this.exchange;
  }

  public async validateManagementToken() {
    return true;
  }

  public async createProject(input: {
    installationId: string;
    projectName: string;
  }) {
    this.createCalls += 1;
    this.projectNames.push(input.projectName);
    this.onCreateProject?.();
    const projectId =
      this.#projects.get(input.installationId) ??
      `project-${input.installationId}`;
    this.#projects.set(input.installationId, projectId);
    return { photonProjectId: projectId };
  }

  public async provisionInitialProjectSecret(input: {
    installationId: string;
  }) {
    this.initialSecretCalls += 1;
    this.onInitialSecret?.();
    const spectrumProjectSecret =
      this.#initialSecrets.get(input.installationId) ??
      `secret-${input.installationId}`;
    this.#initialSecrets.set(input.installationId, spectrumProjectSecret);
    return { spectrumProjectSecret };
  }

  public async registerOwner() {
    this.registerCalls += 1;
    return { assignedIMessageNumber: "+15555550999" };
  }

  public async validateProjectCredential() {
    this.validateCalls += 1;
    return this.validCredential;
  }

  public async rotateProjectSecret() {
    this.rotateCalls += 1;
    if (this.throwOnRotate) {
      throw new Error("repair unavailable");
    }
    return { spectrumProjectSecret: "repaired-secret" };
  }
}

function operationIds() {
  let value = 0;
  return () => {
    value += 1;
    return `30000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
  };
}

function createService(input: {
  installationId?: string;
  repository?: MemoryInstallationRepository;
  owner?: MutableOwnerBinding;
  provider?: FakePhotonProvider;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  operationIdFactory?: () => string;
}) {
  const repository = input.repository ?? new MemoryInstallationRepository();
  const owner = input.owner ?? new MutableOwnerBinding();
  const provider = input.provider ?? new FakePhotonProvider();
  const service = new PhotonInstallationService({
    installationId: input.installationId ?? INSTALLATION_A,
    deploymentId: DEPLOYMENT_ID,
    repository,
    ownerBinding: owner,
    provider,
    cipher,
    projectNamePrefix: "Same Cosmetic Name",
    operationIdFactory: input.operationIdFactory ?? operationIds(),
    now: () => new Date("2026-08-18T16:00:00.000Z"),
    sleep: input.sleep ?? (async () => undefined),
  });
  return { service, repository, owner, provider };
}

async function waitForState(
  repository: MemoryInstallationRepository,
  state: PhotonInstallationRecord["state"],
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (repository.record?.state === state) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${state}.`);
}

describe("PhotonInstallationService", () => {
  it("isolates identical cosmetic names with installation-specific project names", async () => {
    const provider = new FakePhotonProvider();
    const first = createService({ installationId: INSTALLATION_A, provider });
    const second = createService({ installationId: INSTALLATION_B, provider });

    await first.service.start();
    await second.service.start();

    expect(provider.projectNames).toEqual([
      `Same Cosmetic Name - ${INSTALLATION_A}`,
      `Same Cosmetic Name - ${INSTALLATION_B}`,
    ]);
    expect(first.repository.record?.photonProjectId).not.toBe(
      second.repository.record?.photonProjectId,
    );
  });

  it("rejects an owner change during a Photon call before credentials commit", async () => {
    const fixture = createService({});
    fixture.provider.onCreateProject = () => {
      fixture.owner.snapshot = {
        ownerRevision: 2,
        ownerPhoneNumber: "+15555550124",
      };
      fixture.repository.invalidateForOwner(2);
    };

    const status = await fixture.service.start();

    expect(status).toEqual({
      state: "failed",
      installationId: INSTALLATION_A,
      code: "owner_revision_changed",
    });
    expect(fixture.repository.record?.photonProjectId).toBeUndefined();
    expect(fixture.repository.record?.spectrumSecretCiphertext).toBeUndefined();
  });

  it("awaits shutdown cancellation without marking the resumable checkpoint failed", async () => {
    const sleep = async (_milliseconds: number, signal: AbortSignal) =>
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    const fixture = createService({ sleep });
    const running = fixture.service.start();
    await waitForState(
      fixture.repository,
      "awaiting_device_authorization",
    );

    await fixture.service.close();
    const status = await running;

    expect(status.state).toBe("awaiting_device_authorization");
    expect(fixture.provider.exchangeCalls).toBe(0);
    await expect(fixture.service.start()).rejects.toThrow("closed");
  });

  it("awaits explicit cancellation and journals a safe terminal failure", async () => {
    const sleep = async (_milliseconds: number, signal: AbortSignal) =>
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    const fixture = createService({ sleep });
    const running = fixture.service.start();
    await waitForState(
      fixture.repository,
      "awaiting_device_authorization",
    );

    const cancelled = await fixture.service.cancel();
    await running;

    expect(cancelled).toEqual({
      state: "failed",
      installationId: INSTALLATION_A,
      code: "operation_cancelled",
    });
    expect(fixture.repository.record?.safeFailureCode).toBe(
      "operation_cancelled",
    );
  });

  it("coalesces concurrent start calls into one owned operation", async () => {
    const ids = operationIds();
    const fixture = createService({ operationIdFactory: ids });

    const first = fixture.service.start();
    const second = fixture.service.start();
    const [firstStatus, secondStatus] = await Promise.all([first, second]);

    expect(firstStatus).toEqual(secondStatus);
    expect(firstStatus.state).toBe("connected");
    expect(fixture.provider.requestCalls).toBe(1);
    expect(fixture.provider.createCalls).toBe(1);
  });

  it("rejects a stale operation at the project-secret checkpoint", async () => {
    const fixture = createService({});
    fixture.provider.onInitialSecret = () => fixture.repository.stealOperation();

    const status = await fixture.service.start();

    expect(status.state).toBe("project_claimed");
    expect(fixture.repository.record?.spectrumSecretCiphertext).toBeUndefined();
  });

  it("reconnects using the exact stored credential without secret rotation", async () => {
    const fixture = createService({});
    await fixture.service.start();
    const restarted = createService({
      repository: fixture.repository,
      owner: fixture.owner,
      provider: fixture.provider,
    });

    expect(await restarted.service.status()).toEqual({
      state: "needs_credential_repair",
      installationId: INSTALLATION_A,
    });
    const status = await restarted.service.resume();

    expect(status.state).toBe("connected");
    expect(fixture.provider.initialSecretCalls).toBe(1);
    expect(fixture.provider.rotateCalls).toBe(0);
  });

  it("rebinds a new owner with the stored project credential and no rotation", async () => {
    const fixture = createService({});
    await fixture.service.start();
    fixture.owner.snapshot = {
      ownerRevision: 2,
      ownerPhoneNumber: "+15555550124",
    };
    fixture.repository.invalidateForOwner(2);
    const restarted = createService({
      repository: fixture.repository,
      owner: fixture.owner,
      provider: fixture.provider,
    });

    const status = await restarted.service.resume();

    expect(status.state).toBe("connected");
    expect(fixture.provider.registerCalls).toBe(2);
    expect(fixture.provider.initialSecretCalls).toBe(1);
    expect(fixture.provider.rotateCalls).toBe(0);
  });

  it("keeps the old valid credential when an explicit repair fails", async () => {
    const fixture = createService({});
    await fixture.service.start();
    const oldCiphertext =
      fixture.repository.record?.spectrumSecretCiphertext;
    fixture.provider.throwOnRotate = true;

    const status = await fixture.service.repairCredentials();

    expect(status).toEqual({
      state: "failed",
      installationId: INSTALLATION_A,
      code: "project_credential_failed",
    });
    expect(fixture.provider.rotateCalls).toBe(1);
    expect(fixture.repository.record?.spectrumSecretCiphertext).toBe(
      oldCiphertext,
    );
    expect(fixture.provider.validCredential).toBe(true);
  });

  it("imports legacy credentials only after owner and exact credential validation", async () => {
    const fixture = createService({});

    const status = await fixture.service.importLegacyCredentials({
      photonDeviceBearerToken: "legacy-token",
      photonProjectId: "legacy-project-id",
      spectrumProjectSecret: "legacy-project-secret",
      ownerPhoneNumber: "+15555550123",
      assignedIMessageNumber: "+15555550888",
    });

    expect(status).toEqual({
      state: "connected",
      installationId: INSTALLATION_A,
      photonProjectId: "legacy-project-id",
      assignedPhoneNumber: "+15555550888",
    });
    expect(fixture.provider.createCalls).toBe(0);
    expect(fixture.provider.rotateCalls).toBe(0);
  });

  it("never overwrites an existing durable installation during legacy import", async () => {
    const fixture = createService({});
    await fixture.service.start();
    const before = structuredClone(fixture.repository.record);

    const status = await fixture.service.importLegacyCredentials({
      photonDeviceBearerToken: "other-token",
      photonProjectId: "other-project-id",
      spectrumProjectSecret: "other-project-secret",
      ownerPhoneNumber: "+15555550123",
      assignedIMessageNumber: "+15555550888",
    });

    expect(status).toEqual({
      state: "failed",
      installationId: INSTALLATION_A,
      code: "legacy_credentials_rejected",
    });
    expect(fixture.repository.record).toEqual(before);
  });
});
