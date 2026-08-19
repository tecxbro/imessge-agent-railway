import type { ThreadOptions } from "@openai/codex-sdk";
import { describe, expect, it } from "vitest";

import { QUEUE_NAMES, QUEUE_NAME_VALUES } from "../../src/queue/names.js";
import {
  QUEUE_PAYLOAD_SCHEMAS,
  parseQueuePayload,
} from "../../src/queue/payloads.js";
import {
  PERMISSION_PROFILES,
  PERMISSION_PROFILE_NAMES,
  resolvePermissionProfile,
} from "../../src/security/permissions.js";

const id = "00000000-0000-4000-8000-000000000001";

describe("queue contracts", () => {
  it("freezes the documented queue names", () => {
    expect(QUEUE_NAME_VALUES).toEqual([
      "inbound.flush",
      "turn.plan",
      "task.execute",
      "turn.synthesize",
      "outbound.send",
      "approval.request",
      "approval.execute",
      "memory.curate",
      "maintenance.retention",
      "maintenance.health",
    ]);
    expect(Object.keys(QUEUE_PAYLOAD_SCHEMAS).sort()).toEqual(
      [...QUEUE_NAME_VALUES].sort(),
    );
  });

  it("accepts ID/version payloads and rejects raw personal content", () => {
    expect(
      parseQueuePayload(QUEUE_NAMES.turnPlan, {
        chainId: id,
        expectedChainVersion: 1,
        expectedState: "queued",
      }),
    ).toEqual({
      chainId: id,
      expectedChainVersion: 1,
      expectedState: "queued",
    });

    expect(
      QUEUE_PAYLOAD_SCHEMAS[QUEUE_NAMES.inboundFlush].safeParse({
        spaceId: id,
        text: "private message body",
      }).success,
    ).toBe(false);
  });
});

describe("permission profile contracts", () => {
  it("freezes four bounded profiles without danger-full-access", () => {
    expect(PERMISSION_PROFILE_NAMES).toEqual([
      "read",
      "workspace-write",
      "network-read",
      "approval-required",
    ]);
    expect(JSON.stringify(PERMISSION_PROFILES)).not.toContain(
      "danger-full-access",
    );
  });

  it("maps model-independent permissions to current Codex option names", () => {
    const readProfile = resolvePermissionProfile("read");
    const sdkOptions: Pick<
      ThreadOptions,
      | "sandboxMode"
      | "networkAccessEnabled"
      | "webSearchMode"
      | "approvalPolicy"
    > = readProfile;

    expect(sdkOptions).toMatchObject({
      sandboxMode: "read-only",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      approvalPolicy: "never",
    });
    expect(readProfile).toEqual({
      sandboxMode: "read-only",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      approvalPolicy: "never",
      consequentialActions: "forbidden",
    });
    expect(resolvePermissionProfile("network-read")).toEqual({
      sandboxMode: "read-only",
      networkAccessEnabled: false,
      webSearchMode: "live",
      approvalPolicy: "never",
      consequentialActions: "forbidden",
    });
    expect(resolvePermissionProfile("approval-required").approvalPolicy).toBe(
      "never",
    );
    expect(resolvePermissionProfile("approval-required")).toMatchObject({
      sandboxMode: "read-only",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      consequentialActions: "propose-only",
    });
  });
});
