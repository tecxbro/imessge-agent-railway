import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import { z } from "zod";

import {
  jsonValueSchema,
  normalizedApprovedActionSchema,
  proposedActionSchema,
  storedActionEnvelopeSchema,
  type ActionType,
  type JsonValue,
  type NormalizedApprovedAction,
  type ProposedAction,
} from "./action-schema.js";
import type { SenderRole } from "./authorize-sender.js";

const ACTION_HASH_DOMAIN = "imessage-agent-approved-action-v1";
export const DEFAULT_APPROVAL_TTL_MS = 10 * 60 * 1_000;

const uuidSchema = z.uuid();

export interface ApprovalScope {
  ownerId: string;
  spaceId: string;
  executionTaskId: string;
  chainId: string;
}

export interface ImmutableApprovalRequest {
  readonly id: string;
  readonly ownerId: string;
  readonly spaceId: string;
  readonly requestedByTaskId: string;
  readonly actionType: ActionType;
  readonly normalizedPayload: JsonValue;
  readonly actionHash: string;
  readonly humanSummary: string;
  readonly expiresAt: string;
  readonly status: "pending";
}

export interface StoredApprovalRecord {
  id: string;
  chainId: string;
  executionTaskId: string;
  ownerId: string;
  spaceId: string;
  actionType: string;
  normalizedPayloadCiphertext: string | null;
  actionHash: string;
  humanSummary: string;
  status: "pending" | "approved" | "rejected" | "expired" | "consumed";
  expiresAt: Date;
}

export interface CreateStoredApprovalInput extends ApprovalScope {
  id?: string;
  actionType: string;
  normalizedPayloadCiphertext: string;
  actionHash: string;
  humanSummary: string;
  expiresAt: Date;
}

export interface ApprovalActor {
  ownerId: string;
  identityId: string;
  role: SenderRole;
  canApprove: boolean;
}

export interface ApprovalRunnableTask {
  taskId: string;
  chainId: string;
  expectedChainVersion: number;
  expectedState: "queued";
}

export interface ApprovalChainProgression {
  chainId: string;
  expectedChainVersion: number;
  newlyRunnableTasks: readonly ApprovalRunnableTask[];
  shouldSynthesize: boolean;
}

export interface ApprovalResponseOutcome {
  changed: boolean;
  progression: ApprovalChainProgression | null;
}

export interface ApprovalExpiryOutcome {
  expiredCount: number;
  progressions: readonly ApprovalChainProgression[];
}

export interface ApprovalResponsePersistenceInput {
  approvalId: string;
  ownerId: string;
  spaceId: string;
  approvedByIdentityId?: string;
  status: "approved" | "rejected";
  now: Date;
}

export interface ConsumeApprovedActionPersistenceInput {
  approvalId: string;
  ownerId: string;
  spaceId: string;
  executionTaskId: string;
  expectedActionHash: string;
  expectedPayloadCiphertext: string;
  actionExecutionId: string;
  actionType: ActionType;
  now: Date;
}

export interface ApprovalPersistence {
  createPending(input: CreateStoredApprovalInput): Promise<string>;
  findBound(
    approvalId: string,
    ownerId: string,
    spaceId: string,
  ): Promise<StoredApprovalRecord | undefined>;
  listPending(
    ownerId: string,
    spaceId: string,
    now: Date,
  ): Promise<StoredApprovalRecord[]>;
  compareAndSetResponse(input: ApprovalResponsePersistenceInput): Promise<boolean>;
  compareAndSetResponseWithProgression?(
    input: ApprovalResponsePersistenceInput,
  ): Promise<ApprovalResponseOutcome>;
  consumeApprovedAction(
    input: ConsumeApprovedActionPersistenceInput,
  ): Promise<boolean>;
  expireStale(ownerId: string, spaceId: string, now: Date): Promise<number>;
  expireStaleWithProgression?(
    ownerId: string,
    spaceId: string,
    now: Date,
  ): Promise<ApprovalExpiryOutcome>;
}

export interface ApprovalPayloadCipher {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

function encryptionKeyBytes(key: string | Uint8Array): Buffer {
  if (key instanceof Uint8Array) {
    if (key.byteLength !== 32) {
      throw new Error("Approval encryption key must be exactly 32 bytes.");
    }
    return Buffer.from(key);
  }
  if (/^[a-f0-9]{64}$/iu.test(key)) {
    return Buffer.from(key, "hex");
  }
  const decoded = Buffer.from(key, "base64");
  if (decoded.byteLength !== 32) {
    throw new Error("Approval encryption key must be 32-byte hex or base64.");
  }
  return decoded;
}

export function createApprovalPayloadCipher(
  key: string | Uint8Array,
): ApprovalPayloadCipher {
  const keyBytes = encryptionKeyBytes(key);
  return {
    encrypt(plaintext) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", keyBytes, nonce);
      cipher.setAAD(Buffer.from(ACTION_HASH_DOMAIN, "utf8"));
      const encrypted = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ]);
      return [
        "v1",
        nonce.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
        encrypted.toString("base64url"),
      ].join(".");
    },
    decrypt(ciphertext) {
      const [version, nonceText, tagText, encryptedText, extra] =
        ciphertext.split(".");
      if (
        version !== "v1" ||
        nonceText === undefined ||
        tagText === undefined ||
        encryptedText === undefined ||
        extra !== undefined
      ) {
        throw new Error("Stored approval payload has an unsupported envelope.");
      }
      try {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          keyBytes,
          Buffer.from(nonceText, "base64url"),
        );
        decipher.setAAD(Buffer.from(ACTION_HASH_DOMAIN, "utf8"));
        decipher.setAuthTag(Buffer.from(tagText, "base64url"));
        return Buffer.concat([
          decipher.update(Buffer.from(encryptedText, "base64url")),
          decipher.final(),
        ]).toString("utf8");
      } catch (error) {
        throw new Error(
          "Stored approval payload failed authenticated decryption. Reject execution and inspect the approval record.",
          { cause: error },
        );
      }
    },
  };
}

function canonicalize(value: JsonValue): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Approval payload numbers must be finite.");
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key]!)}`)
    .join(",")}}`;
}

export function canonicalJson(value: JsonValue): string {
  return canonicalize(jsonValueSchema.parse(value));
}

function actionHashInput(
  scope: Pick<ApprovalScope, "ownerId" | "spaceId" | "executionTaskId">,
  envelope: z.infer<typeof storedActionEnvelopeSchema>,
): JsonValue {
  return {
    domain: ACTION_HASH_DOMAIN,
    ownerId: scope.ownerId,
    spaceId: scope.spaceId,
    executionTaskId: scope.executionTaskId,
    action: {
      actionType: envelope.actionType,
      target: envelope.target,
      payload: envelope.payload,
    },
  };
}

export function hashApprovedAction(
  scope: Pick<ApprovalScope, "ownerId" | "spaceId" | "executionTaskId">,
  action: Pick<ProposedAction, "actionType" | "target" | "normalizedPayload">,
): string {
  const parsedScope = {
    ownerId: uuidSchema.parse(scope.ownerId),
    spaceId: uuidSchema.parse(scope.spaceId),
    executionTaskId: uuidSchema.parse(scope.executionTaskId),
  };
  const envelope = storedActionEnvelopeSchema.parse({
    actionType: action.actionType,
    target: action.target,
    payload: action.normalizedPayload,
  });
  return createHash("sha256")
    .update(canonicalJson(actionHashInput(parsedScope, envelope)), "utf8")
    .digest("hex");
}

function hashesEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

const ACTION_EFFECTS: Record<ActionType, string> = {
  "filesystem.destructive": "Important filesystem data may be deleted or overwritten.",
  "external.send": "Content will be sent through an external account.",
  purchase: "A purchase, booking, transfer, or paid action may occur.",
  "authentication.change": "Authentication state or credentials will change.",
  "permission.change": "Access permissions will change.",
  "deployment.change": "A deployment or production configuration will change.",
  "secret.access": "Protected secret material will be accessed.",
  "network.broad": "Broad or sensitive network access will occur.",
  "dependency.install": "Executable dependencies will be installed persistently.",
  "other.consequential": "A consequential action with material effects will occur.",
};

function confirmationSummary(action: ProposedAction): string {
  return `${action.actionType} on ${JSON.stringify(action.target)}. ${ACTION_EFFECTS[action.actionType]}`;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

export interface EncryptedStoredActionBinding {
  ownerId: string;
  spaceId: string;
  executionTaskId: string;
  actionType: string;
  actionHash: string;
  normalizedPayloadCiphertext: string;
}

/**
 * Authenticates, parses, and re-hashes an encrypted stored action. Callers get
 * only the normalized provider input and never model commentary.
 */
export function decryptStoredApprovedAction(
  binding: EncryptedStoredActionBinding,
  cipher: ApprovalPayloadCipher,
): Readonly<NormalizedApprovedAction> | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(cipher.decrypt(binding.normalizedPayloadCiphertext)) as unknown;
  } catch {
    return undefined;
  }
  const envelope = storedActionEnvelopeSchema.safeParse(raw);
  if (!envelope.success || envelope.data.actionType !== binding.actionType) {
    return undefined;
  }
  const action = normalizedApprovedActionSchema.parse({
    actionType: envelope.data.actionType,
    target: envelope.data.target,
    normalizedPayload: envelope.data.payload,
  });
  const recomputedHash = hashApprovedAction(binding, action);
  if (!hashesEqual(recomputedHash, binding.actionHash)) {
    return undefined;
  }
  return deepFreeze(structuredClone(action));
}

export interface ConsumedApprovedAction {
  approvalId: string;
  actionExecutionId: string;
  executionTaskId: string;
  action: Readonly<NormalizedApprovedAction>;
}

export class ApprovalService {
  public constructor(
    private readonly persistence: ApprovalPersistence,
    private readonly cipher: ApprovalPayloadCipher,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async create(
    scope: ApprovalScope,
    proposed: unknown,
    ttlMs = DEFAULT_APPROVAL_TTL_MS,
  ): Promise<ImmutableApprovalRequest> {
    const parsedScope = {
      chainId: uuidSchema.parse(scope.chainId),
      ownerId: uuidSchema.parse(scope.ownerId),
      spaceId: uuidSchema.parse(scope.spaceId),
      executionTaskId: uuidSchema.parse(scope.executionTaskId),
    };
    if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 24 * 60 * 60 * 1_000) {
      throw new Error("Approval expiry must be between 1 ms and 24 hours.");
    }
    const action = proposedActionSchema.parse(proposed);
    const envelope = storedActionEnvelopeSchema.parse({
      actionType: action.actionType,
      target: action.target,
      payload: action.normalizedPayload,
    });
    const plaintext = canonicalJson(envelope);
    const actionHash = hashApprovedAction(parsedScope, action);
    const now = this.now();
    const expiresAt = new Date(now.getTime() + ttlMs);
    const id = randomUUID();
    const humanSummary = confirmationSummary(action);
    const ciphertext = this.cipher.encrypt(plaintext);
    const storedId = await this.persistence.createPending({
      id,
      ...parsedScope,
      actionType: action.actionType,
      normalizedPayloadCiphertext: ciphertext,
      actionHash,
      humanSummary,
      expiresAt,
    });

    let requestId: string = id;
    let requestAction: Readonly<NormalizedApprovedAction> = action;
    let requestSummary = humanSummary;
    let requestExpiresAt = expiresAt;
    if (storedId !== id) {
      const existing = await this.persistence.findBound(
        storedId,
        parsedScope.ownerId,
        parsedScope.spaceId,
      );
      if (
        existing === undefined ||
        existing.chainId !== parsedScope.chainId ||
        existing.executionTaskId !== parsedScope.executionTaskId ||
        existing.status !== "pending" ||
        existing.expiresAt.getTime() <= now.getTime() ||
        existing.normalizedPayloadCiphertext === null ||
        !hashesEqual(existing.actionHash, actionHash)
      ) {
        throw new Error(
          "Approval idempotency lookup returned a non-pending or differently bound request.",
        );
      }
      const storedAction = decryptStoredApprovedAction(
        {
          ownerId: existing.ownerId,
          spaceId: existing.spaceId,
          executionTaskId: existing.executionTaskId,
          actionType: existing.actionType,
          actionHash: existing.actionHash,
          normalizedPayloadCiphertext: existing.normalizedPayloadCiphertext,
        },
        this.cipher,
      );
      if (storedAction === undefined) {
        throw new Error(
          "The idempotent approval record failed exact encrypted action validation.",
        );
      }
      requestId = existing.id;
      requestAction = storedAction;
      requestSummary = existing.humanSummary;
      requestExpiresAt = existing.expiresAt;
    }

    return deepFreeze({
      id: requestId,
      ownerId: parsedScope.ownerId,
      spaceId: parsedScope.spaceId,
      requestedByTaskId: parsedScope.executionTaskId,
      actionType: requestAction.actionType,
      normalizedPayload: structuredClone(requestAction.normalizedPayload),
      actionHash,
      humanSummary: requestSummary,
      expiresAt: requestExpiresAt.toISOString(),
      status: "pending" as const,
    });
  }

  public async listPending(
    actor: ApprovalActor,
    spaceId: string,
  ): Promise<StoredApprovalRecord[]> {
    this.requireOwnerActor(actor);
    const now = this.now();
    await this.persistence.expireStale(actor.ownerId, spaceId, now);
    return this.persistence.listPending(actor.ownerId, spaceId, now);
  }

  public async respond(
    actor: ApprovalActor,
    spaceId: string,
    approvalId: string,
    status: "approved" | "rejected",
  ): Promise<boolean> {
    return (await this.respondWithProgression(actor, spaceId, approvalId, status))
      .changed;
  }

  public async respondWithProgression(
    actor: ApprovalActor,
    spaceId: string,
    approvalId: string,
    status: "approved" | "rejected",
  ): Promise<ApprovalResponseOutcome> {
    this.requireOwnerActor(actor);
    uuidSchema.parse(spaceId);
    uuidSchema.parse(approvalId);
    const input: ApprovalResponsePersistenceInput = {
      approvalId,
      ownerId: actor.ownerId,
      spaceId,
      approvedByIdentityId: actor.identityId,
      status,
      now: this.now(),
    };
    if (this.persistence.compareAndSetResponseWithProgression !== undefined) {
      return this.persistence.compareAndSetResponseWithProgression(input);
    }
    return {
      changed: await this.persistence.compareAndSetResponse(input),
      progression: null,
    };
  }

  public async expireWithProgression(
    ownerId: string,
    spaceId: string,
  ): Promise<ApprovalExpiryOutcome> {
    uuidSchema.parse(ownerId);
    uuidSchema.parse(spaceId);
    const now = this.now();
    if (this.persistence.expireStaleWithProgression !== undefined) {
      return this.persistence.expireStaleWithProgression(ownerId, spaceId, now);
    }
    return {
      expiredCount: await this.persistence.expireStale(ownerId, spaceId, now),
      progressions: [],
    };
  }

  /**
   * Decrypts, validates, and re-hashes the stored payload; atomically consumes
   * that exact ciphertext and returns it as the only permissible executor input.
   */
  public async consume(
    approvalId: string,
    ownerId: string,
    spaceId: string,
    expectedExecutionTaskId?: string,
  ): Promise<ConsumedApprovedAction | undefined> {
    const now = this.now();
    const record = await this.persistence.findBound(
      uuidSchema.parse(approvalId),
      uuidSchema.parse(ownerId),
      uuidSchema.parse(spaceId),
    );
    if (
      record === undefined ||
      record.status !== "approved" ||
      record.expiresAt.getTime() <= now.getTime() ||
      record.normalizedPayloadCiphertext === null ||
      (expectedExecutionTaskId !== undefined &&
        record.executionTaskId !== uuidSchema.parse(expectedExecutionTaskId))
    ) {
      await this.persistence.expireStale(ownerId, spaceId, now);
      return undefined;
    }

    const action = decryptStoredApprovedAction(
      {
        ownerId: record.ownerId,
        spaceId: record.spaceId,
        executionTaskId: record.executionTaskId,
        actionType: record.actionType,
        actionHash: record.actionHash,
        normalizedPayloadCiphertext: record.normalizedPayloadCiphertext,
      },
      this.cipher,
    );
    if (action === undefined) {
      return undefined;
    }
    const actionExecutionId = randomUUID();
    const consumed = await this.persistence.consumeApprovedAction({
      approvalId: record.id,
      ownerId: record.ownerId,
      spaceId: record.spaceId,
      executionTaskId: record.executionTaskId,
      expectedActionHash: record.actionHash,
      expectedPayloadCiphertext: record.normalizedPayloadCiphertext,
      actionExecutionId,
      actionType: action.actionType,
      now,
    });
    if (!consumed) {
      return undefined;
    }
    return deepFreeze({
      approvalId: record.id,
      actionExecutionId,
      executionTaskId: record.executionTaskId,
      action,
    });
  }

  private requireOwnerActor(actor: ApprovalActor): void {
    uuidSchema.parse(actor.ownerId);
    uuidSchema.parse(actor.identityId);
    if (actor.role !== "owner" || !actor.canApprove) {
      throw new Error("Only an active deterministic owner identity may respond to approvals.");
    }
  }
}
