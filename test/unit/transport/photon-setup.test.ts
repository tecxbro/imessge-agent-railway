import { describe, expect, it, vi } from "vitest";

import {
  PhotonInstallationHttpProvider,
  PhotonSetupService,
  type PhotonSetupCredentials,
} from "../../../src/transport/photon-setup.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function waitForTerminalStatus(service: PhotonSetupService) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const status = service.status();
    if (status.state === "connected" || status.state === "failed") {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Photon setup did not reach a terminal state.");
}

describe("Photon dashboard owner resolution", () => {
  it("does not start Photon before the owner identity is configured", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const service = new PhotonSetupService({
      ownerIdentity: {
        readOwnerPhoneNumber: async () => undefined,
      },
      credentialsStore: { save: vi.fn() },
      fetchImplementation,
    });

    await expect(service.start()).resolves.toEqual({
      state: "failed",
      code: "PHOTON_OWNER_PHONE_REQUIRED",
    });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("uses one dashboard-configured owner snapshot and keeps the assigned line separate", async () => {
    const ownerPhoneNumber = "+14155550123";
    const assignedIMessageNumber = "+16285550123";
    const readOwnerPhoneNumber = vi
      .fn<() => Promise<string | undefined>>()
      .mockResolvedValueOnce(ownerPhoneNumber)
      .mockResolvedValue("+14155550999");
    const saved: PhotonSetupCredentials[] = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/auth/device/code")) {
        return jsonResponse({
          device_code: "device-code",
          user_code: "ABCD-EFGH",
          verification_uri: "https://app.photon.codes/device",
          expires_in: 300,
          interval: 1,
        });
      }
      if (url.endsWith("/api/auth/device/token")) {
        return jsonResponse({ access_token: "photon-device-token" });
      }
      if (url.endsWith("/api/auth/get-session")) {
        return jsonResponse({ user: { id: "photon-user" } });
      }
      if (url.endsWith("/api/projects/")) {
        return jsonResponse([
          { id: "project-1", name: "iMessage Codex Agent" },
        ]);
      }
      if (
        url.endsWith("/api/projects") &&
        (init?.method ?? "GET") === "GET"
      ) {
        return jsonResponse([
          { id: "project-1", name: "iMessage Codex Agent" },
        ]);
      }
      if (url.endsWith("/api/projects/project-1/regenerate-secret")) {
        return jsonResponse({ projectSecret: "spectrum-project-secret" });
      }
      if (url.endsWith("/projects/project-1/users/")) {
        return jsonResponse({
          users: [
            {
              id: "spectrum-user",
              phoneNumber: ownerPhoneNumber,
              assignedPhoneNumber: assignedIMessageNumber,
            },
          ],
        });
      }
      return jsonResponse({ error: "unexpected request" }, 500);
    });
    const service = new PhotonSetupService({
      ownerIdentity: { readOwnerPhoneNumber },
      credentialsStore: {
        async save(credentials) {
          saved.push(credentials);
        },
      },
      fetchImplementation,
      sleep: async () => undefined,
    });

    await expect(service.start()).resolves.toMatchObject({
      state: "awaiting_authorization",
      userCode: "ABCD-EFGH",
    });
    await expect(waitForTerminalStatus(service)).resolves.toEqual({
      state: "connected",
      assignedPhoneNumber: assignedIMessageNumber,
    });

    expect(readOwnerPhoneNumber).toHaveBeenCalledOnce();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      ownerPhoneNumber,
      assignedIMessageNumber,
    });
    expect(saved[0]?.ownerPhoneNumber).not.toBe(
      saved[0]?.assignedIMessageNumber,
    );
    const userRequests = fetchImplementation.mock.calls.filter(([input]) =>
      String(input).endsWith("/projects/project-1/users/"),
    );
    expect(userRequests).toHaveLength(1);
  });
});

describe("durable Photon HTTP provider", () => {
  it("creates by stable installation id without selecting a project by name", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      jsonResponse({ data: { id: "project-created" } }),
    );
    const provider = new PhotonInstallationHttpProvider(fetchImplementation);

    await expect(
      provider.createProject({
        installationId: "00000000-0000-4000-8000-000000000010",
        operationId: "00000000-0000-4000-8000-000000000011",
        managementToken: "management-token",
        projectName:
          "iMessage Codex Agent - 00000000-0000-4000-8000-000000000010",
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ photonProjectId: "project-created" });

    expect(fetchImplementation).toHaveBeenCalledOnce();
    const [input, init] = fetchImplementation.mock.calls[0]!;
    expect(String(input)).toBe("https://app.photon.codes/api/projects");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("idempotency-key")).toBe(
      "00000000-0000-4000-8000-000000000010",
    );
  });

  it("uses distinct stable idempotency keys for initial issuance and explicit repair", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      jsonResponse({ projectSecret: "spectrum-secret" }),
    );
    const provider = new PhotonInstallationHttpProvider(fetchImplementation);
    const signal = new AbortController().signal;

    await provider.provisionInitialProjectSecret({
      installationId: "00000000-0000-4000-8000-000000000020",
      operationId: "00000000-0000-4000-8000-000000000021",
      managementToken: "management-token",
      photonProjectId: "project-1",
      signal,
    });
    await provider.rotateProjectSecret({
      operationId: "00000000-0000-4000-8000-000000000022",
      managementToken: "management-token",
      photonProjectId: "project-1",
      signal,
    });

    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(
      fetchImplementation.mock.calls.map(([, init]) =>
        new Headers(init?.headers).get("idempotency-key"),
      ),
    ).toEqual([
      "00000000-0000-4000-8000-000000000020",
      "00000000-0000-4000-8000-000000000022",
    ]);
  });

  it("rejects a token when the session JSON lacks a validated user", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith("/api/auth/get-session")
        ? jsonResponse({})
        : jsonResponse([]),
    );
    const provider = new PhotonInstallationHttpProvider(fetchImplementation);

    await expect(
      provider.validateManagementToken({
        managementToken: "management-token",
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(false);
  });
});
