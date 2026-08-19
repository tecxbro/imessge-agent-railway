import { z } from "zod";

import {
  cloneCapabilitiesSnapshot,
  type CapabilitiesListener,
  type CodexAccountCapabilitiesSnapshot,
  type CodexModelOption,
} from "./codex-account-capabilities.js";
import type { ModelSelection } from "./model-selection.js";
import { reasoningEffortSchema } from "../config/model-profiles.js";

export const MODEL_CAPABILITY_SOURCE_KINDS = ["chatgpt", "api_key"] as const;
export type ModelCapabilitySourceKind =
  (typeof MODEL_CAPABILITY_SOURCE_KINDS)[number];

export type FinalModelCapabilitySnapshot = Omit<
  CodexAccountCapabilitiesSnapshot,
  "state"
> & {
  state: "available" | "unavailable";
};

export interface ModelCapabilitySource {
  readonly kind: ModelCapabilitySourceKind;
  snapshot(): CodexAccountCapabilitiesSnapshot;
  refresh(): Promise<CodexAccountCapabilitiesSnapshot>;
  subscribe(listener: CapabilitiesListener): () => void;
}

export interface ChatGptCapabilityProvider {
  capabilities(): CodexAccountCapabilitiesSnapshot;
  refreshCapabilities(): Promise<CodexAccountCapabilitiesSnapshot>;
  onCapabilitiesChanged(listener: CapabilitiesListener): () => void;
}

const modelOptionSchema = z
  .object({
    id: z.string().trim().min(1).max(128).regex(/^[a-z0-9._-]+$/u),
    model: z.string().trim().min(1).max(128),
    displayName: z.string().trim().min(1).max(256),
    supportedReasoningEfforts: z
      .array(
        z
          .object({
            reasoningEffort: reasoningEffortSchema,
            description: z.string().trim().max(512),
          })
          .strict(),
      )
      .min(1)
      .max(32),
    defaultReasoningEffort: reasoningEffortSchema,
    isDefault: z.boolean(),
  })
  .strict()
  .superRefine((model, context) => {
    const efforts = model.supportedReasoningEfforts.map(
      ({ reasoningEffort }) => reasoningEffort,
    );
    if (new Set(efforts).size !== efforts.length) {
      context.addIssue({
        code: "custom",
        message: "A model capability cannot advertise duplicate efforts.",
      });
    }
    if (!efforts.includes(model.defaultReasoningEffort)) {
      context.addIssue({
        code: "custom",
        message: "The default effort must be advertised by the model.",
      });
    }
  });

export const normalizedModelCatalogSchema = z
  .array(modelOptionSchema)
  .max(1_000)
  .superRefine((models, context) => {
    const identifiers = models.map(({ id }) => id);
    if (new Set(identifiers).size !== identifiers.length) {
      context.addIssue({
        code: "custom",
        message: "A model capability catalog cannot contain duplicate IDs.",
      });
    }
  });

const planTypeSchema = z.string().trim().min(1).max(64).nullable();

export function normalizeFinalCapabilitySnapshot(
  snapshot: CodexAccountCapabilitiesSnapshot,
): FinalModelCapabilitySnapshot {
  if (snapshot.state === "refreshing") {
    throw new Error("Refreshing model capability snapshots are not final.");
  }
  if (snapshot.state === "unavailable") {
    return {
      state: "unavailable",
      planType: null,
      models: [],
      refreshedAt:
        snapshot.refreshedAt === null
          ? null
          : new Date(snapshot.refreshedAt.getTime()),
    };
  }

  const models = normalizedModelCatalogSchema.parse(snapshot.models);
  if (!(snapshot.refreshedAt instanceof Date)) {
    throw new Error(
      "An available model capability snapshot requires a refresh timestamp.",
    );
  }
  return {
    state: "available",
    planType: planTypeSchema.parse(snapshot.planType),
    models: models.map((model) => ({
      ...model,
      supportedReasoningEfforts: model.supportedReasoningEfforts.map(
        (effort) => ({ ...effort }),
      ),
    })),
    refreshedAt: new Date(snapshot.refreshedAt.getTime()),
  };
}

export class ChatGptModelCapabilitySource implements ModelCapabilitySource {
  public readonly kind = "chatgpt" as const;

  public constructor(private readonly provider: ChatGptCapabilityProvider) {}

  public snapshot(): CodexAccountCapabilitiesSnapshot {
    return cloneCapabilitiesSnapshot(this.provider.capabilities());
  }

  public async refresh(): Promise<CodexAccountCapabilitiesSnapshot> {
    return cloneCapabilitiesSnapshot(
      await this.provider.refreshCapabilities(),
    );
  }

  public subscribe(listener: CapabilitiesListener): () => void {
    return this.provider.onCapabilitiesChanged(listener);
  }
}

export interface ApiKeyModelCapabilitySourceOptions {
  selection: ModelSelection;
  displayName?: string;
  refreshedAt?: Date;
}

export class ApiKeyModelCapabilitySource implements ModelCapabilitySource {
  public readonly kind = "api_key" as const;
  readonly #snapshot: CodexAccountCapabilitiesSnapshot;

  public constructor(options: ApiKeyModelCapabilitySourceOptions) {
    const model: CodexModelOption = {
      id: options.selection.modelId,
      model: options.selection.modelId,
      displayName: options.displayName ?? options.selection.modelId,
      supportedReasoningEfforts: [
        {
          reasoningEffort: options.selection.reasoningEffort,
          description: "Configured API-key model pair",
        },
      ],
      defaultReasoningEffort: options.selection.reasoningEffort,
      isDefault: true,
    };
    this.#snapshot = normalizeFinalCapabilitySnapshot({
      state: "available",
      planType: null,
      models: [model],
      refreshedAt: options.refreshedAt ?? new Date(),
    });
  }

  public snapshot(): CodexAccountCapabilitiesSnapshot {
    return cloneCapabilitiesSnapshot(this.#snapshot);
  }

  public async refresh(): Promise<CodexAccountCapabilitiesSnapshot> {
    return this.snapshot();
  }

  public subscribe(_listener: CapabilitiesListener): () => void {
    return () => undefined;
  }
}
