import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { CodexModelOption } from "../../agent/codex-account-capabilities.js";
import {
  modelSelectionSchema,
  modelSelectionStateSchema,
  modelSupportsSelection,
  resolveEffectiveModelSelection,
  type DeploymentModelSettings,
  type ModelSelection,
} from "../../agent/model-selection.js";
import { deployments } from "../schema.js";
import type { Database, DatabaseTransaction } from "../client.js";

const planTypeSchema = z.string().trim().min(1).max(64).nullable();

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
