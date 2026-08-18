import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  createDeploymentIdentityController,
  initializeDeploymentIdentityController,
  OwnerPhoneNumberValidationError,
  selectLegacyOwnerPhoneNumber,
  type DeploymentIdentityRepository,
} from "../../src/runtime/deployment-identity.js";

function repository(
  initialPhoneNumber?: string,
): DeploymentIdentityRepository & {
  phoneNumber: string | undefined;
  writes: string[];
} {
  return {
    phoneNumber: initialPhoneNumber,
    writes: [],
    async replaceOwnerPhoneNumber(phoneNumber) {
      this.writes.push(phoneNumber);
      this.phoneNumber = phoneNumber;
    },
    async readOwnerPhoneNumber() {
      return this.phoneNumber;
    },
  };
}

describe("dashboard-managed deployment identity", () => {
  it("initializes without an owner and returns only masked status after configuration", async () => {
    const controller = createDeploymentIdentityController();
    const storage = repository();
    controller.bindRepository(storage);

    await expect(controller.initialize()).resolves.toEqual({
      state: "not_configured",
    });
    await expect(
      controller.configureOwner("  +14155550123  "),
    ).resolves.toEqual({
      state: "configured",
      maskedPhoneNumber: "••••••0123",
    });
    expect(storage.writes).toEqual(["+14155550123"]);
    expect(controller.status()).not.toHaveProperty("phoneNumber");
    await expect(controller.readOwnerPhoneNumber()).resolves.toBe(
      "+14155550123",
    );
  });

  it("rejects invalid E.164 values before persistence", async () => {
    const controller = createDeploymentIdentityController();
    const storage = repository();
    controller.bindRepository(storage);

    await expect(controller.configureOwner("415-555-0123")).rejects.toBeInstanceOf(
      OwnerPhoneNumberValidationError,
    );
    expect(storage.writes).toEqual([]);
  });

  it("serializes concurrent owner replacements", async () => {
    const controller = createDeploymentIdentityController();
    let activeWrites = 0;
    let maximumActiveWrites = 0;
    const writes: string[] = [];
    let phoneNumber: string | undefined;
    controller.bindRepository({
      async replaceOwnerPhoneNumber(value) {
        activeWrites += 1;
        maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
        await new Promise((resolve) => setTimeout(resolve, 5));
        writes.push(value);
        phoneNumber = value;
        activeWrites -= 1;
      },
      async readOwnerPhoneNumber() {
        return phoneNumber;
      },
    });

    await Promise.all([
      controller.configureOwner("+14155550123"),
      controller.configureOwner("+14155550124"),
    ]);

    expect(maximumActiveWrites).toBe(1);
    expect(writes).toEqual(["+14155550123", "+14155550124"]);
    await expect(controller.readOwnerPhoneNumber()).resolves.toBe(
      "+14155550124",
    );
  });

  it("emits configured only after persistence and supports listener cleanup", async () => {
    const controller = createDeploymentIdentityController();
    const events: string[] = [];
    controller.bindRepository({
      async replaceOwnerPhoneNumber() {
        events.push("persisted");
      },
      async readOwnerPhoneNumber() {
        return undefined;
      },
    });
    const dispose = controller.onConfigured(() => {
      events.push("configured");
    });

    await controller.configureOwner("+14155550123");
    dispose();
    await controller.configureOwner("+14155550124");

    expect(events).toEqual(["persisted", "configured", "persisted"]);
  });

  it("fails closed when identity storage cannot be read or written", async () => {
    const controller = createDeploymentIdentityController();
    controller.bindRepository({
      async replaceOwnerPhoneNumber() {
        throw new Error("database unavailable for +14155550123");
      },
      async readOwnerPhoneNumber() {
        throw new Error("corrupt plaintext");
      },
    });

    await expect(controller.initialize()).resolves.toEqual({
      state: "failed",
      code: "OWNER_IDENTITY_STORAGE_FAILED",
    });
    await expect(controller.configureOwner("+14155550123")).resolves.toEqual({
      state: "failed",
      code: "OWNER_IDENTITY_STORAGE_FAILED",
    });
    expect(JSON.stringify(controller.status())).not.toContain("+14155550123");
  });

  it("uses deterministic legacy precedence and requires an unambiguous phone handle", () => {
    expect(
      selectLegacyOwnerPhoneNumber({
        ownerPhoneNumber: "+14155550101",
        renderOwnerPhoneNumber: "+14155550102",
        ownerHandles: ["+14155550103"],
      }),
    ).toEqual({ state: "ready", phoneNumber: "+14155550101" });
    expect(
      selectLegacyOwnerPhoneNumber({
        renderOwnerPhoneNumber: "+14155550102",
        ownerHandles: ["+14155550103"],
      }),
    ).toEqual({ state: "ready", phoneNumber: "+14155550102" });
    expect(
      selectLegacyOwnerPhoneNumber({
        ownerHandles: ["+14155550103"],
      }),
    ).toEqual({ state: "ready", phoneNumber: "+14155550103" });
    expect(
      selectLegacyOwnerPhoneNumber({
        ownerHandles: ["+14155550103", "+14155550104"],
      }),
    ).toEqual({ state: "migration_required" });
    expect(
      selectLegacyOwnerPhoneNumber({
        ownerHandles: ["owner@example.com"],
      }),
    ).toEqual({ state: "migration_required" });
  });

  it("imports a legacy owner once and gives an active database identity precedence", async () => {
    const storage = repository();
    const first = createDeploymentIdentityController();
    const initial = await initializeDeploymentIdentityController({
      controller: first,
      repository: storage,
      legacyOwner: { state: "ready", phoneNumber: "+14155550123" },
    });
    expect(initial).toMatchObject({
      status: { state: "configured", maskedPhoneNumber: "••••••0123" },
      importedLegacyOwner: true,
    });

    const second = createDeploymentIdentityController();
    const restarted = await initializeDeploymentIdentityController({
      controller: second,
      repository: storage,
      legacyOwner: { state: "ready", phoneNumber: "+14155550999" },
    });
    expect(restarted).toMatchObject({
      status: { state: "configured", maskedPhoneNumber: "••••••0123" },
      importedLegacyOwner: false,
    });
    expect(storage.writes).toEqual(["+14155550123"]);
  });

  it("does not use stored Photon owner metadata as authorization input", async () => {
    const source = await readFile(
      new URL("../../src/runtime/production-bootstrap.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toMatch(
      /storedPhotonSetup\.ownerPhoneNumber[^\n]*(replaceOwnerPhoneNumber|configureOwner)/u,
    );
    expect(source).toContain(
      "environment.OWNER_PHONE_NUMBER_E164_EXAMPLE_PLUS19495550123",
    );
    expect(source).toContain("renderOwnerPhoneNumber:");
    expect(source).toContain("ownerHandles: environment.AGENT_OWNER_HANDLES");
  });
});
