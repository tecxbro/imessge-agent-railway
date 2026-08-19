import { createHash } from "node:crypto";

import {
  cloneCapabilitiesSnapshot,
  type CodexAccountCapabilitiesSnapshot,
  type CodexModelOption,
} from "./codex-account-capabilities.js";
import {
  normalizeFinalCapabilitySnapshot,
  type FinalModelCapabilitySnapshot,
  type ModelCapabilitySource,
  type ModelCapabilitySourceKind,
} from "./model-capability-source.js";
import {
  isModelSettingsError,
  ModelSettingsError,
  type ModelSettingsErrorCode,
} from "./model-settings-errors.js";
import {
  modelSelectionSchema,
  modelSupportsSelection,
  resolveEffectiveModelSelection,
  type DeploymentModelSettings,
  type ModelSelection,
  type ModelSelectionState,
} from "./model-selection.js";
import type {
  CapabilityPairRunner,
  PairProbeFailure,
} from "../config/capabilities.js";

export type ModelSettingsProbeState =
  | "not_probed"
  | "supported"
  | "unsupported"
  | "failed";

export interface ModelSettingsReconciliationRecord {
  sourceKind: ModelCapabilitySourceKind;
  sourceState: "available" | "unavailable";
  planType: string | null;
  catalog: readonly CodexModelOption[];
  catalogHash: string;
  effective: ModelSelection | null;
  selectionState: Exclude<ModelSelectionState, "pending">;
  probeState: ModelSettingsProbeState;
  probedCatalogHash: string | null;
  probedSelection: ModelSelection | null;
  sourceRefreshedAt: Date | null;
  probedAt: Date | null;
  lastErrorCode: ModelSettingsErrorCode | null;
}

export interface PersistModelSettingsReconciliationInput {
  preferred: ModelSelection;
  replacePreference: boolean;
  reconciliation: ModelSettingsReconciliationRecord;
}

export interface ModelSettingsStore {
  read(): Promise<DeploymentModelSettings>;
  readReconciliation(): Promise<ModelSettingsReconciliationRecord | undefined>;
  persistReconciliation(
    input: PersistModelSettingsReconciliationInput,
  ): Promise<DeploymentModelSettings>;
}

export interface ModelSettingsDashboardSnapshot
  extends DeploymentModelSettings {
  availableModels: readonly CodexModelOption[];
}

export interface ModelSettingsReadinessSnapshot {
  ready: boolean;
  state: "ready" | "unavailable";
  sourceKind: ModelCapabilitySourceKind;
  catalogHash: string | null;
  effective: ModelSelection | null;
  code?: ModelSettingsErrorCode;
}

export interface ModelSettingsReadinessPublisher {
  publish(
    snapshot: Readonly<ModelSettingsReadinessSnapshot>,
  ): void | Promise<void>;
}

export interface ModelSettingsServiceOptions {
  source: ModelCapabilitySource;
  store: ModelSettingsStore;
  probe: CapabilityPairRunner;
  readiness?: ModelSettingsReadinessPublisher;
  now?: () => Date;
}

function cloneModels(
  models: readonly CodexModelOption[],
): readonly CodexModelOption[] {
  return models.map((model) => ({
    ...model,
    supportedReasoningEfforts: model.supportedReasoningEfforts.map(
      (effort) => ({ ...effort }),
    ),
  }));
}

function cloneSelection(selection: ModelSelection | null): ModelSelection | null {
  return selection === null ? null : { ...selection };
}

function sameSelection(
  left: ModelSelection | null,
  right: ModelSelection | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.modelId === right.modelId &&
      left.reasoningEffort === right.reasoningEffort)
  );
}

function stableCatalogHash(models: readonly CodexModelOption[]): string {
  const canonicalCatalog = models.map((model) => ({
    id: model.id,
    model: model.model,
    displayName: model.displayName,
    supportedReasoningEfforts: model.supportedReasoningEfforts.map(
      (effort) => ({
        reasoningEffort: effort.reasoningEffort,
        description: effort.description,
      }),
    ),
    defaultReasoningEffort: model.defaultReasoningEffort,
    isDefault: model.isDefault,
  }));
  return createHash("sha256")
    .update(JSON.stringify(canonicalCatalog), "utf8")
    .digest("hex");
}

function sameFinalSnapshot(
  previous: ModelSettingsReconciliationRecord,
  sourceKind: ModelCapabilitySourceKind,
  snapshot: FinalModelCapabilitySnapshot,
  catalogHash: string,
  effective: ModelSelection | null,
  selectionState: Exclude<ModelSelectionState, "pending">,
): boolean {
  return (
    previous.sourceKind === sourceKind &&
    previous.sourceState === snapshot.state &&
    previous.planType === snapshot.planType &&
    previous.catalogHash === catalogHash &&
    sameSelection(previous.effective, effective) &&
    previous.selectionState === selectionState
  );
}

function cloneRecord(
  record: ModelSettingsReconciliationRecord,
): ModelSettingsReconciliationRecord {
  return {
    ...record,
    catalog: cloneModels(record.catalog),
    effective: cloneSelection(record.effective),
    probedSelection: cloneSelection(record.probedSelection),
    sourceRefreshedAt:
      record.sourceRefreshedAt === null
        ? null
        : new Date(record.sourceRefreshedAt.getTime()),
    probedAt:
      record.probedAt === null ? null : new Date(record.probedAt.getTime()),
  };
}

function readinessFromRecord(
  record: ModelSettingsReconciliationRecord,
): ModelSettingsReadinessSnapshot {
  const probeMatches =
    record.probeState === "supported" &&
    record.probedCatalogHash === record.catalogHash &&
    sameSelection(record.probedSelection, record.effective);
  if (
    record.sourceState === "available" &&
    record.effective !== null &&
    probeMatches
  ) {
    return {
      ready: true,
      state: "ready",
      sourceKind: record.sourceKind,
      catalogHash: record.catalogHash,
      effective: { ...record.effective },
    };
  }
  return {
    ready: false,
    state: "unavailable",
    sourceKind: record.sourceKind,
    catalogHash: record.catalogHash,
    effective: cloneSelection(record.effective),
    code:
      record.lastErrorCode ??
      (record.effective === null
        ? "MODEL_SETTINGS_UNAVAILABLE"
        : "MODEL_PAIR_UNAVAILABLE"),
  };
}

function cloneReadiness(
  snapshot: ModelSettingsReadinessSnapshot,
): ModelSettingsReadinessSnapshot {
  return {
    ...snapshot,
    effective: cloneSelection(snapshot.effective),
  };
}

function readinessIdentity(snapshot: ModelSettingsReadinessSnapshot): string {
  return JSON.stringify(snapshot);
}

function finalSnapshotEventIdentity(
  sourceKind: ModelCapabilitySourceKind,
  snapshot: CodexAccountCapabilitiesSnapshot,
): string | undefined {
  if (snapshot.state === "refreshing") {
    return undefined;
  }
  try {
    const normalized = normalizeFinalCapabilitySnapshot(snapshot);
    return JSON.stringify({
      sourceKind,
      state: normalized.state,
      planType: normalized.planType,
      catalogHash: stableCatalogHash(normalized.models),
      refreshedAt: normalized.refreshedAt?.toISOString() ?? null,
    });
  } catch {
    return undefined;
  }
}

interface ProbeSnapshot {
  probeState: Exclude<ModelSettingsProbeState, "not_probed">;
  probedCatalogHash: string;
  probedSelection: ModelSelection;
  probedAt: Date;
  lastErrorCode: "MODEL_PAIR_UNAVAILABLE" | null;
  failure?: PairProbeFailure;
}

interface ExplicitRefreshGeneration {
  readonly finalSnapshots: Map<string, Promise<void>>;
}

export class ModelSettingsService {
  readonly #source: ModelCapabilitySource;
  readonly #store: ModelSettingsStore;
  readonly #probe: CapabilityPairRunner;
  readonly #readinessPublisher: ModelSettingsReadinessPublisher | undefined;
  readonly #now: () => Date;
  #unsubscribe: (() => void) | undefined;
  #started = false;
  #closing = false;
  #startFlight: Promise<void> | undefined;
  #queue: Promise<void> = Promise.resolve();
  #explicitRefresh: Promise<ModelSettingsReadinessSnapshot> | undefined;
  #explicitRefreshGeneration: ExplicitRefreshGeneration | undefined;
  readonly #pendingFinalSnapshots = new Map<string, Promise<void>>();
  #readiness: ModelSettingsReadinessSnapshot;
  #lastPublishedReadinessIdentity: string | undefined;
  #publicationQueue: Promise<void> = Promise.resolve();

  public constructor(options: ModelSettingsServiceOptions) {
    this.#source = options.source;
    this.#store = options.store;
    this.#probe = options.probe;
    this.#readinessPublisher = options.readiness;
    this.#now = options.now ?? (() => new Date());
    this.#readiness = {
      ready: false,
      state: "unavailable",
      sourceKind: options.source.kind,
      catalogHash: null,
      effective: null,
      code: "MODEL_SETTINGS_UNAVAILABLE",
    };
  }

  public start(): Promise<void> {
    if (this.#startFlight !== undefined) {
      return this.#startFlight;
    }
    if (this.#started) {
      return this.#queue;
    }
    this.#closing = false;
    const start = this.#start();
    this.#startFlight = start;
    const clear = () => {
      if (this.#startFlight === start) {
        this.#startFlight = undefined;
      }
    };
    void start.then(clear, clear);
    return start;
  }

  async #start(): Promise<void> {
    const persisted = await this.#store.readReconciliation();
    if (persisted !== undefined) {
      await this.#publish(readinessFromRecord(persisted));
    }
    if (this.#closing) {
      return;
    }
    const unsubscribe = this.#source.subscribe((snapshot) => {
      // Capability providers may await listeners while refresh() is in flight.
      // Enqueue and return immediately so the provider can finish that refresh.
      void this.#enqueueSnapshot(snapshot).catch(() => undefined);
    });
    if (this.#closing) {
      unsubscribe();
      return;
    }
    this.#unsubscribe = unsubscribe;
    this.#started = true;
  }

  public async close(): Promise<void> {
    this.#closing = true;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#started = false;
    await this.#startFlight?.catch(() => undefined);
    await this.#explicitRefresh?.catch(() => undefined);
    await this.#queue;
    await this.#publicationQueue;
  }

  public refresh(): Promise<ModelSettingsReadinessSnapshot> {
    if (this.#closing) {
      return Promise.reject(
        new ModelSettingsError("MODEL_SETTINGS_UNAVAILABLE"),
      );
    }
    if (this.#explicitRefresh !== undefined) {
      return this.#explicitRefresh;
    }
    const generation: ExplicitRefreshGeneration = {
      finalSnapshots: new Map(),
    };
    this.#explicitRefreshGeneration = generation;
    const refresh = this.#refreshAndReconcile();
    this.#explicitRefresh = refresh;
    const clear = () => {
      if (this.#explicitRefresh === refresh) {
        this.#explicitRefresh = undefined;
      }
      if (this.#explicitRefreshGeneration === generation) {
        this.#explicitRefreshGeneration = undefined;
      }
    };
    void refresh.then(clear, clear);
    return refresh;
  }

  public readiness(): ModelSettingsReadinessSnapshot {
    return cloneReadiness(this.#readiness);
  }

  public async readDashboard(): Promise<ModelSettingsDashboardSnapshot> {
    const [settings, reconciliation] = await Promise.all([
      this.#store.read(),
      this.#store.readReconciliation(),
    ]);
    if (
      reconciliation === undefined ||
      reconciliation.sourceState !== "available" ||
      reconciliation.effective === null ||
      settings.effective === null ||
      !sameSelection(reconciliation.effective, settings.effective)
    ) {
      throw new ModelSettingsError("MODEL_SETTINGS_UNAVAILABLE");
    }
    return {
      ...settings,
      preferred: { ...settings.preferred },
      effective: { ...settings.effective },
      availableModels: cloneModels(reconciliation.catalog),
    };
  }

  public async updatePreference(
    selection: ModelSelection,
  ): Promise<ModelSettingsDashboardSnapshot> {
    const parsed = modelSelectionSchema.parse(selection);
    await this.refresh();
    return await this.#serialize(async () => await this.#savePreference(parsed));
  }

  async #refreshAndReconcile(): Promise<ModelSettingsReadinessSnapshot> {
    let snapshot: CodexAccountCapabilitiesSnapshot;
    try {
      snapshot = cloneCapabilitiesSnapshot(await this.#source.refresh());
    } catch (error) {
      if (!this.#closing) {
        await this.#publishFailure("MODEL_CAPABILITY_REFRESH_FAILED");
      }
      throw new ModelSettingsError("MODEL_CAPABILITY_REFRESH_FAILED", {
        cause: error,
      });
    }
    if (snapshot.state === "refreshing") {
      if (!this.#closing) {
        await this.#publishFailure("MODEL_CAPABILITY_REFRESH_FAILED");
      }
      throw new ModelSettingsError("MODEL_CAPABILITY_REFRESH_FAILED");
    }
    try {
      await this.#enqueueSnapshot(snapshot);
    } catch (error) {
      if (isModelSettingsError(error)) {
        throw error;
      }
      throw new ModelSettingsError("MODEL_SETTINGS_UNAVAILABLE", {
        cause: error,
      });
    }
    return this.readiness();
  }

  #enqueueSnapshot(snapshot: CodexAccountCapabilitiesSnapshot): Promise<void> {
    const cloned = cloneCapabilitiesSnapshot(snapshot);
    if (this.#closing) {
      return Promise.reject(
        new ModelSettingsError("MODEL_SETTINGS_UNAVAILABLE"),
      );
    }
    const identity = finalSnapshotEventIdentity(this.#source.kind, cloned);
    if (identity !== undefined) {
      const retained =
        this.#explicitRefreshGeneration?.finalSnapshots.get(identity);
      if (retained !== undefined) {
        return retained;
      }
      const pending = this.#pendingFinalSnapshots.get(identity);
      if (pending !== undefined) {
        return pending;
      }
    }
    const reconciliation = this.#serialize(async () => {
      try {
        await this.#reconcile(cloned);
      } catch (error) {
        if (!this.#closing) {
          await this.#publishFailure(this.#errorCode(error));
        }
        throw error;
      }
    });
    if (identity !== undefined) {
      this.#pendingFinalSnapshots.set(identity, reconciliation);
      this.#explicitRefreshGeneration?.finalSnapshots.set(
        identity,
        reconciliation,
      );
      const clear = () => {
        if (this.#pendingFinalSnapshots.get(identity) === reconciliation) {
          this.#pendingFinalSnapshots.delete(identity);
        }
      };
      void reconciliation.then(clear, clear);
    }
    return reconciliation;
  }

  #serialize<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #reconcile(snapshot: CodexAccountCapabilitiesSnapshot): Promise<void> {
    if (snapshot.state === "refreshing") {
      return;
    }
    let normalized: FinalModelCapabilitySnapshot;
    try {
      normalized = normalizeFinalCapabilitySnapshot(snapshot);
    } catch (error) {
      throw new ModelSettingsError("MODEL_CAPABILITY_REFRESH_FAILED", {
        cause: error,
      });
    }

    const [settings, previous] = await Promise.all([
      this.#store.read(),
      this.#store.readReconciliation(),
    ]);
    const effectiveSelection =
      normalized.state === "available"
        ? resolveEffectiveModelSelection(settings.preferred, normalized.models)
        : null;
    const effective =
      effectiveSelection === null
        ? null
        : {
            modelId: effectiveSelection.modelId,
            reasoningEffort: effectiveSelection.reasoningEffort,
          };
    const selectionState: Exclude<ModelSelectionState, "pending"> =
      effectiveSelection?.source ?? "unavailable";
    const catalogHash = stableCatalogHash(normalized.models);

    if (
      previous !== undefined &&
      sameFinalSnapshot(
        previous,
        this.#source.kind,
        normalized,
        catalogHash,
        effective,
        selectionState,
      )
    ) {
      await this.#publish(readinessFromRecord(previous));
      return;
    }

    const probeKeyChanged =
      effective !== null &&
      (previous === undefined ||
        previous.catalogHash !== catalogHash ||
        !sameSelection(previous.effective, effective));
    const probe =
      effective === null
        ? undefined
        : probeKeyChanged
          ? await this.#probeSelection(effective, catalogHash)
          : previous;
    const reconciliation: ModelSettingsReconciliationRecord = {
      sourceKind: this.#source.kind,
      sourceState: normalized.state,
      planType: normalized.planType,
      catalog: cloneModels(normalized.models),
      catalogHash,
      effective,
      selectionState,
      probeState:
        effective === null
          ? "not_probed"
          : probe === undefined
            ? "not_probed"
            : probe.probeState,
      probedCatalogHash:
        effective === null || probe === undefined
          ? null
          : probe.probedCatalogHash,
      probedSelection:
        effective === null || probe === undefined
          ? null
          : cloneSelection(probe.probedSelection),
      sourceRefreshedAt:
        normalized.refreshedAt === null
          ? null
          : new Date(normalized.refreshedAt.getTime()),
      probedAt:
        effective === null || probe === undefined || probe.probedAt === null
          ? null
          : new Date(probe.probedAt.getTime()),
      lastErrorCode:
        normalized.state === "unavailable" || effective === null
          ? "MODEL_SETTINGS_UNAVAILABLE"
          : probe?.lastErrorCode ?? null,
    };
    await this.#store.persistReconciliation({
      preferred: settings.preferred,
      replacePreference: false,
      reconciliation,
    });
    await this.#publish(readinessFromRecord(reconciliation));
  }

  async #savePreference(
    selection: ModelSelection,
  ): Promise<ModelSettingsDashboardSnapshot> {
    const reconciliation = await this.#store.readReconciliation();
    if (
      reconciliation === undefined ||
      reconciliation.sourceState !== "available"
    ) {
      throw new ModelSettingsError("MODEL_SETTINGS_UNAVAILABLE");
    }
    const model = reconciliation.catalog.find(
      (candidate) => candidate.id === selection.modelId,
    );
    if (model === undefined || !modelSupportsSelection(model, selection)) {
      throw new ModelSettingsError("MODEL_SELECTION_STALE");
    }

    const existingProbeKeyMatches =
      reconciliation.catalogHash === reconciliation.probedCatalogHash &&
      sameSelection(reconciliation.probedSelection, selection);
    if (
      existingProbeKeyMatches &&
      reconciliation.probeState !== "supported"
    ) {
      throw new ModelSettingsError("MODEL_PAIR_UNAVAILABLE");
    }
    if (!existingProbeKeyMatches) {
      const probe = await this.#probeSelection(
        selection,
        reconciliation.catalogHash,
      );
      if (probe.probeState !== "supported") {
        throw new ModelSettingsError("MODEL_PAIR_UNAVAILABLE");
      }
    }

    const next: ModelSettingsReconciliationRecord = {
      ...cloneRecord(reconciliation),
      effective: { ...selection },
      selectionState: "preferred",
      probeState: "supported",
      probedCatalogHash: reconciliation.catalogHash,
      probedSelection: { ...selection },
      probedAt: this.#now(),
      lastErrorCode: null,
    };
    const settings = await this.#store.persistReconciliation({
      preferred: selection,
      replacePreference: true,
      reconciliation: next,
    });
    await this.#publish(readinessFromRecord(next));
    return {
      ...settings,
      preferred: { ...settings.preferred },
      effective:
        settings.effective === null ? null : { ...settings.effective },
      availableModels: cloneModels(next.catalog),
    };
  }

  async #probeSelection(
    selection: ModelSelection,
    catalogHash: string,
  ): Promise<ProbeSnapshot> {
    const probedAt = this.#now();
    try {
      const result = await this.#probe.probe({
        model: selection.modelId,
        effort: selection.reasoningEffort,
      });
      return {
        probeState: result.supported ? "supported" : "unsupported",
        probedCatalogHash: catalogHash,
        probedSelection: { ...selection },
        probedAt,
        lastErrorCode: result.supported ? null : "MODEL_PAIR_UNAVAILABLE",
        ...(result.failure === undefined ? {} : { failure: result.failure }),
      };
    } catch {
      return {
        probeState: "failed",
        probedCatalogHash: catalogHash,
        probedSelection: { ...selection },
        probedAt,
        lastErrorCode: "MODEL_PAIR_UNAVAILABLE",
      };
    }
  }

  #errorCode(error: unknown): ModelSettingsErrorCode {
    return isModelSettingsError(error)
      ? error.code
      : "MODEL_SETTINGS_UNAVAILABLE";
  }

  async #publishFailure(code: ModelSettingsErrorCode): Promise<void> {
    await this.#publish({
      ready: false,
      state: "unavailable",
      sourceKind: this.#source.kind,
      catalogHash: this.#readiness.catalogHash,
      effective: cloneSelection(this.#readiness.effective),
      code,
    });
  }

  #publish(snapshot: ModelSettingsReadinessSnapshot): Promise<void> {
    const next = cloneReadiness(snapshot);
    const publication = this.#publicationQueue.then(
      async () => await this.#publishNow(next),
      async () => await this.#publishNow(next),
    );
    this.#publicationQueue = publication.then(
      () => undefined,
      () => undefined,
    );
    return publication;
  }

  async #publishNow(snapshot: ModelSettingsReadinessSnapshot): Promise<void> {
    const next = cloneReadiness(snapshot);
    const identity = readinessIdentity(next);
    this.#readiness = next;
    if (
      this.#readinessPublisher === undefined ||
      identity === this.#lastPublishedReadinessIdentity
    ) {
      return;
    }
    try {
      await this.#readinessPublisher.publish(cloneReadiness(next));
      this.#lastPublishedReadinessIdentity = identity;
    } catch {
      // Keep the last-published identity unchanged so the next identical stable
      // snapshot retries the external publication without re-probing or writing.
    }
  }
}
