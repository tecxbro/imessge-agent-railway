import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { CodexModelOption } from "../../agent/codex-account-capabilities.js";
import {
  MODEL_CAPABILITY_SOURCE_KINDS,
  normalizedModelCatalogSchema,
} from "../../agent/model-capability-source.js";
import {
  MODEL_SETTINGS_ERROR_CODES,
  type ModelSettingsErrorCode,
} from "../../agent/model-settings-errors.js";
import type {
  ModelSettingsProbeState,
  ModelSettingsReconciliationRecord,
  PersistModelSettingsReconciliationInput,
} from "../../agent/model-settings-service.js";
import {
  modelSelectionSchema,
  modelSelectionStateSchema,
  modelSupportsSelection,
  resolveEffectiveModelSelection,
  type DeploymentModelSettings,
  type ModelSelection,
} from "../../agent/model-selection.js";
import { deployments } from "../schema.js";
import { modelSettingsReconciliation } from "../schema-fragments/model-settings-reconciliation.js";
import type { Database, DatabaseTransaction } from "../client.js";

const planTypeSchema = z.string().trim().min(1).max(64).nullable();
const catalogHashSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const sourceKindSchema = z.enum(MODEL_CAPABILITY_SOURCE_KINDS);
const sourceStateSchema = z.enum(["available", "unavailable"]);
const probeStateSchema = z.enum([
  "not_probed",
  "supported",
  "unsupported",
  "failed",
]);
const modelSettingsErrorCodeSchema = z.enum(MODEL_SETTINGS_ERROR_CODES);

export class ModelPreferenceUnavailableError extends Error {
  public constructor() {
    super("MODEL_PREFERENCE_UNAVAILABLE");
    this.name = "ModelPreferenceUnavailableError";
  }
}

export class ModelSettingsRepository {
  public constructor(
    private readonly database: Database,
    private readonly deploymentId: string,
  ) {}

  public async read(): Promise<DeploymentModelSettings> {
    const [row] = await this.database
      .select({
        planType: deployments.chatgptPlanType,
        preferredModelId: deployments.preferredModelId,
        preferredReasoningEffort: deployments.preferredReasoningEffort,
        effectiveModelId: deployments.effectiveModelId,
        effectiveReasoningEffort: deployments.effectiveReasoningEffort,
        selectionState: deployments.modelSelectionState,
        refreshedAt: deployments.modelCatalogRefreshedAt,
      })
      .from(deployments)
      .where(eq(deployments.id, this.deploymentId))
      .limit(1);
    if (row === undefined) {
      throw new Error(
        "The deployment model settings are unavailable. Initialize the deployment row before reading them.",
      );
    }
    const preferred = modelSelectionSchema.parse({
      modelId: row.preferredModelId,
      reasoningEffort: row.preferredReasoningEffort,
    });
    const effective =
      row.effectiveModelId === null || row.effectiveReasoningEffort === null
        ? null
        : modelSelectionSchema.parse({
            modelId: row.effectiveModelId,
            reasoningEffort: row.effectiveReasoningEffort,
          });
    return {
      planType: planTypeSchema.parse(row.planType),
      preferred,
      effective,
      selectionState: modelSelectionStateSchema.parse(row.selectionState),
      modelCatalogRefreshedAt: row.refreshedAt,
    };
  }

  public async syncAccountCapabilities(input: {
    planType: string | null;
    models: readonly CodexModelOption[];
    refreshedAt: Date;
  }): Promise<DeploymentModelSettings> {
    const planType = planTypeSchema.parse(input.planType);
    await this.database.transaction(async (transaction) => {
      const preferred = await this.lockedPreferred(transaction);
      const effective = resolveEffectiveModelSelection(preferred, input.models);
      await transaction
        .update(deployments)
        .set({
          chatgptPlanType: planType,
          effectiveModelId: effective?.modelId ?? null,
          effectiveReasoningEffort: effective?.reasoningEffort ?? null,
          modelSelectionState: effective?.source ?? "unavailable",
          modelCatalogRefreshedAt: input.refreshedAt,
          updatedAt: new Date(),
        })
        .where(eq(deployments.id, this.deploymentId));
    });
    return await this.read();
  }

  public async updatePreference(input: {
    modelId: string;
    reasoningEffort: ModelSelection["reasoningEffort"];
    currentCatalog: readonly CodexModelOption[];
  }): Promise<DeploymentModelSettings> {
    const preferred = modelSelectionSchema.parse({
      modelId: input.modelId,
      reasoningEffort: input.reasoningEffort,
    });
    const model = input.currentCatalog.find(
      (candidate) => candidate.id === preferred.modelId,
    );
    if (model === undefined || !modelSupportsSelection(model, preferred)) {
      throw new ModelPreferenceUnavailableError();
    }
    const updated = await this.database
      .update(deployments)
      .set({
        preferredModelId: preferred.modelId,
        preferredReasoningEffort: preferred.reasoningEffort,
        effectiveModelId: preferred.modelId,
        effectiveReasoningEffort: preferred.reasoningEffort,
        modelSelectionState: "preferred",
        updatedAt: new Date(),
      })
      .where(eq(deployments.id, this.deploymentId))
      .returning({ id: deployments.id });
    if (updated.length !== 1) {
      throw new Error(
        "The deployment model preference could not be saved. Initialize the deployment row and retry.",
      );
    }
    return await this.read();
  }

  /** API-key mode has no ChatGPT catalog, so activate only an already-probed pair. */
  public async activateProbedPreference(
    selection: ModelSelection,
  ): Promise<DeploymentModelSettings> {
    const parsed = modelSelectionSchema.parse(selection);
    const current = await this.read();
    if (
      current.preferred.modelId !== parsed.modelId ||
      current.preferred.reasoningEffort !== parsed.reasoningEffort
    ) {
      throw new Error(
        "The probed API-key model pair no longer matches the stored preference.",
      );
    }
    await this.database
      .update(deployments)
      .set({
        effectiveModelId: parsed.modelId,
        effectiveReasoningEffort: parsed.reasoningEffort,
        modelSelectionState: "preferred",
        updatedAt: new Date(),
      })
      .where(eq(deployments.id, this.deploymentId));
    return await this.read();
  }

  public async readReconciliation(): Promise<
    ModelSettingsReconciliationRecord | undefined
  > {
    const [row] = await this.database
      .select()
      .from(modelSettingsReconciliation)
      .where(
        eq(modelSettingsReconciliation.deploymentId, this.deploymentId),
      )
      .limit(1);
    if (row === undefined) {
      return undefined;
    }
    const effective = parseOptionalSelection(
      row.effectiveModelId,
      row.effectiveReasoningEffort,
      "effective",
    );
    const probedSelection = parseOptionalSelection(
      row.probedModelId,
      row.probedReasoningEffort,
      "probed",
    );
    const selectionState = modelSelectionStateSchema.parse(row.selectionState);
    if (selectionState === "pending") {
      throw new Error(
        "Persisted model reconciliation cannot use the pending selection state.",
      );
    }
    return {
      sourceKind: sourceKindSchema.parse(row.sourceKind),
      sourceState: sourceStateSchema.parse(row.sourceState),
      planType: planTypeSchema.parse(row.planType),
      catalog: normalizedModelCatalogSchema.parse(row.catalogJson),
      catalogHash: catalogHashSchema.parse(row.catalogHash),
      effective,
      selectionState,
      probeState: probeStateSchema.parse(row.probeState),
      probedCatalogHash:
        row.probedCatalogHash === null
          ? null
          : catalogHashSchema.parse(row.probedCatalogHash),
      probedSelection,
      sourceRefreshedAt: row.sourceRefreshedAt,
      probedAt: row.probedAt,
      lastErrorCode:
        row.lastErrorCode === null
          ? null
          : modelSettingsErrorCodeSchema.parse(row.lastErrorCode),
    };
  }

  public async persistReconciliation(
    input: PersistModelSettingsReconciliationInput,
  ): Promise<DeploymentModelSettings> {
    const preferred = modelSelectionSchema.parse(input.preferred);
    const reconciliation = parseReconciliation(input.reconciliation);
    await this.database.transaction(async (transaction) => {
      await this.lockedPreferred(transaction);
      const updated = await transaction
        .update(deployments)
        .set({
          ...(input.replacePreference
            ? {
                preferredModelId: preferred.modelId,
                preferredReasoningEffort: preferred.reasoningEffort,
              }
            : {}),
          chatgptPlanType: reconciliation.planType,
          effectiveModelId: reconciliation.effective?.modelId ?? null,
          effectiveReasoningEffort:
            reconciliation.effective?.reasoningEffort ?? null,
          modelSelectionState: reconciliation.selectionState,
          modelCatalogRefreshedAt: reconciliation.sourceRefreshedAt,
          updatedAt: new Date(),
        })
        .where(eq(deployments.id, this.deploymentId))
        .returning({ id: deployments.id });
      if (updated.length !== 1) {
        throw new Error(
          "The deployment model reconciliation could not be persisted. Initialize the deployment row and retry.",
        );
      }

      const now = new Date();
      await transaction
        .insert(modelSettingsReconciliation)
        .values({
          deploymentId: this.deploymentId,
          sourceKind: reconciliation.sourceKind,
          sourceState: reconciliation.sourceState,
          planType: reconciliation.planType,
          catalogJson: reconciliation.catalog,
          catalogHash: reconciliation.catalogHash,
          effectiveModelId: reconciliation.effective?.modelId ?? null,
          effectiveReasoningEffort:
            reconciliation.effective?.reasoningEffort ?? null,
          selectionState: reconciliation.selectionState,
          probeState: reconciliation.probeState,
          probedCatalogHash: reconciliation.probedCatalogHash,
          probedModelId: reconciliation.probedSelection?.modelId ?? null,
          probedReasoningEffort:
            reconciliation.probedSelection?.reasoningEffort ?? null,
          sourceRefreshedAt: reconciliation.sourceRefreshedAt,
          probedAt: reconciliation.probedAt,
          lastErrorCode: reconciliation.lastErrorCode,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: modelSettingsReconciliation.deploymentId,
          set: {
            sourceKind: reconciliation.sourceKind,
            sourceState: reconciliation.sourceState,
            planType: reconciliation.planType,
            catalogJson: reconciliation.catalog,
            catalogHash: reconciliation.catalogHash,
            effectiveModelId: reconciliation.effective?.modelId ?? null,
            effectiveReasoningEffort:
              reconciliation.effective?.reasoningEffort ?? null,
            selectionState: reconciliation.selectionState,
            probeState: reconciliation.probeState,
            probedCatalogHash: reconciliation.probedCatalogHash,
            probedModelId: reconciliation.probedSelection?.modelId ?? null,
            probedReasoningEffort:
              reconciliation.probedSelection?.reasoningEffort ?? null,
            sourceRefreshedAt: reconciliation.sourceRefreshedAt,
            probedAt: reconciliation.probedAt,
            lastErrorCode: reconciliation.lastErrorCode,
            updatedAt: now,
          },
        });
    });
    return await this.read();
  }

  async lockedPreferred(
    transaction: DatabaseTransaction,
  ): Promise<ModelSelection> {
    await transaction.execute(
      sql`select id from ${deployments} where ${deployments.id} = ${this.deploymentId} for update`,
    );
    const [row] = await transaction
      .select({
        modelId: deployments.preferredModelId,
        reasoningEffort: deployments.preferredReasoningEffort,
      })
      .from(deployments)
      .where(eq(deployments.id, this.deploymentId))
      .limit(1);
    if (row === undefined) {
      throw new Error(
        "The deployment model settings are unavailable. Initialize the deployment row before syncing capabilities.",
      );
    }
    return modelSelectionSchema.parse(row);
  }
}

function parseOptionalSelection(
  modelId: string | null,
  reasoningEffort: string | null,
  label: string,
): ModelSelection | null {
  if (modelId === null && reasoningEffort === null) {
    return null;
  }
  if (modelId === null || reasoningEffort === null) {
    throw new Error(`The persisted ${label} model pair is incomplete.`);
  }
  return modelSelectionSchema.parse({ modelId, reasoningEffort });
}

function parseReconciliation(
  input: ModelSettingsReconciliationRecord,
): ModelSettingsReconciliationRecord {
  const selectionState = modelSelectionStateSchema.parse(input.selectionState);
  if (selectionState === "pending") {
    throw new Error(
      "A final model reconciliation cannot use the pending selection state.",
    );
  }
  const probeState: ModelSettingsProbeState = probeStateSchema.parse(
    input.probeState,
  );
  const lastErrorCode: ModelSettingsErrorCode | null =
    input.lastErrorCode === null
      ? null
      : modelSettingsErrorCodeSchema.parse(input.lastErrorCode);
  return {
    sourceKind: sourceKindSchema.parse(input.sourceKind),
    sourceState: sourceStateSchema.parse(input.sourceState),
    planType: planTypeSchema.parse(input.planType),
    catalog: normalizedModelCatalogSchema.parse(input.catalog),
    catalogHash: catalogHashSchema.parse(input.catalogHash),
    effective:
      input.effective === null
        ? null
        : modelSelectionSchema.parse(input.effective),
    selectionState,
    probeState,
    probedCatalogHash:
      input.probedCatalogHash === null
        ? null
        : catalogHashSchema.parse(input.probedCatalogHash),
    probedSelection:
      input.probedSelection === null
        ? null
        : modelSelectionSchema.parse(input.probedSelection),
    sourceRefreshedAt:
      input.sourceRefreshedAt === null
        ? null
        : new Date(input.sourceRefreshedAt.getTime()),
    probedAt:
      input.probedAt === null ? null : new Date(input.probedAt.getTime()),
    lastErrorCode,
  };
}
