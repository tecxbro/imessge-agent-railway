import { describe, expect, it, vi } from "vitest";

import {
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
