import { describe, expect, it, vi } from "vitest";

import type {
  PhotonInstallationRecord,
  PhotonInstallationRepositoryPort,
  PhotonInstallationStatus,
} from "../../src/transport/photon-installation-contracts.js";
import { DurablePhotonSetupController } from "../../src/transport/durable-photon-setup.js";

const installationId = "00000000-0000-4000-8000-000000000010";

describe("durable Photon dashboard facade", () => {
  it("returns the durable device-code checkpoint while one attempt keeps polling", async () => {
    let resolveCompletion!: (status: PhotonInstallationStatus) => void;
    const completion = new Promise<PhotonInstallationStatus>((resolve) => {
      resolveCompletion = resolve;
    });
    let durableStatus: PhotonInstallationStatus = {
      state: "not_started",
      installationId,
    };
    const start = vi.fn(async () => {
      durableStatus = {
        state: "awaiting_device_authorization",
        installationId,
        userCode: "ABCD-EFGH",
        verificationUrl: "https://app.photon.codes/device",
        expiresAt: "2026-08-18T12:30:00.000Z",
      };
      return await completion;
    });
    const connectedRecord: PhotonInstallationRecord = {
      installationId,
      deploymentId: installationId,
      ownerRevision: 1,
      operationId: "00000000-0000-4000-8000-000000000011",
      state: "connected",
      photonProjectId: "project-1",
      managementTokenCiphertext: "management-ciphertext",
      spectrumSecretCiphertext: "secret-ciphertext",
      assignedNumberCiphertext: "assigned-ciphertext",
      lastCompletedStep: "credential_validated",
      journalVersion: 1,
      createdAt: new Date("2026-08-18T12:00:00Z"),
      updatedAt: new Date("2026-08-18T12:00:00Z"),
    };
    const repository: PhotonInstallationRepositoryPort = {
      load: async () => connectedRecord,
      createInitial: async () => undefined,
      claimOperation: async () => undefined,
      checkpoint: async () => undefined,
    };
    const controller = new DurablePhotonSetupController();
    controller.bind({
      service: {
        start,
        resume: start,
        status: async () => durableStatus,
        close: async () => undefined,
        importLegacyCredentials: async () => durableStatus,
      },
      repository,
      ownerBinding: {
        read: async () => ({
          ownerRevision: 1,
          ownerPhoneNumber: "+14155550123",
        }),
      },
      cipher: {
        decrypt: async (ciphertext) =>
          ciphertext === "assigned-ciphertext"
            ? "+16285550123"
            : ciphertext === "management-ciphertext"
              ? "management-token"
              : "spectrum-secret",
        encrypt: async (plaintext) => plaintext,
      },
    });

    await expect(Promise.all([controller.start(), controller.start()])).resolves.toEqual([
      {
        state: "awaiting_authorization",
        userCode: "ABCD-EFGH",
        verificationUrl: "https://app.photon.codes/device",
        expiresAt: "2026-08-18T12:30:00.000Z",
      },
      {
        state: "awaiting_authorization",
        userCode: "ABCD-EFGH",
        verificationUrl: "https://app.photon.codes/device",
        expiresAt: "2026-08-18T12:30:00.000Z",
      },
    ]);
    expect(start).toHaveBeenCalledOnce();

    durableStatus = {
      state: "connected",
      installationId,
      photonProjectId: "project-1",
      assignedPhoneNumber: "+16285550123",
    };
    resolveCompletion(durableStatus);
    await vi.waitFor(() =>
      expect(controller.status()).toEqual({
        state: "connected",
        assignedPhoneNumber: "+16285550123",
      }),
    );
  });
});
