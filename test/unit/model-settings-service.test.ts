import { describe, expect, it, vi } from "vitest";

import {
  cloneCapabilitiesSnapshot,
  type CapabilitiesListener,
  type CodexAccountCapabilitiesSnapshot,
  type CodexModelOption,
} from "../../src/agent/codex-account-capabilities.js";
import {
  ApiKeyModelCapabilitySource,
  type ModelCapabilitySource,
} from "../../src/agent/model-capability-source.js";
import { ModelSettingsError } from "../../src/agent/model-settings-errors.js";
import {
  ModelSettingsService,
  type ModelSettingsDashboardSnapshot,
  type ModelSettingsReadinessSnapshot,
  type ModelSettingsReconciliationRecord,
  type ModelSettingsStore,
  type PersistModelSettingsReconciliationInput,
} from "../../src/agent/model-settings-service.js";
import type {
  DeploymentModelSettings,
  ModelSelection,
} from "../../src/agent/model-selection.js";
import type { CapabilityPairRunner } from "../../src/config/capabilities.js";
import { ModelSettingsHttpController } from "../../src/http/model-settings-controller.js";
import { ModelSettingsApiError } from "../../src/http/server.js";

const luna: CodexModelOption = {
  id: "gpt-5.6-luna",
  model: "gpt-5.6-luna",
  displayName: "GPT-5.6 Luna",
  supportedReasoningEfforts: [
    { reasoningEffort: "medium", description: "Default" },
    { reasoningEffort: "high", description: "More reasoning" },
  ],
  defaultReasoningEffort: "medium",
  isDefault: true,
};

const terra: CodexModelOption = {
  id: "gpt-5.6-terra",
  model: "gpt-5.6-terra",
  displayName: "GPT-5.6 Terra",
  supportedReasoningEfforts: [
    { reasoningEffort: "low", description: "Fast" },
  ],
  defaultReasoningEffort: "low",
  isDefault: false,
};

function available(
  models: readonly CodexModelOption[] = [luna],
  refreshedAt = new Date("2026-08-18T16:00:00Z"),
): CodexAccountCapabilitiesSnapshot {
  return {
    state: "available",
    planType: "plus",
    models,
    refreshedAt,
  };
}

function cloneSettings(
  settings: DeploymentModelSettings,
): DeploymentModelSettings {
  return {
    ...settings,
    preferred: { ...settings.preferred },
    effective:
      settings.effective === null ? null : { ...settings.effective },
    modelCatalogRefreshedAt:
      settings.modelCatalogRefreshedAt === null
        ? null
        : new Date(settings.modelCatalogRefreshedAt.getTime()),
  };
}

function cloneRecord(
  record: ModelSettingsReconciliationRecord,
): ModelSettingsReconciliationRecord {
  return structuredClone(record);
}

class FakeStore implements ModelSettingsStore {
  settings: DeploymentModelSettings = {
    planType: null,
    preferred: {
      modelId: "gpt-5.6-luna",
      reasoningEffort: "high",
    },
    effective: null,
    selectionState: "pending",
    modelCatalogRefreshedAt: null,
  };
  reconciliation: ModelSettingsReconciliationRecord | undefined;
  persistCalls = 0;
  activePersists = 0;
  maximumActivePersists = 0;
  failNextPersists = 0;
  failNextReconciliationReads = 0;
  persistDelay: (() => Promise<void>) | undefined;

  public async read(): Promise<DeploymentModelSettings> {
    return cloneSettings(this.settings);
  }

  public async readReconciliation(): Promise<
    ModelSettingsReconciliationRecord | undefined
  > {
    if (this.failNextReconciliationReads > 0) {
      this.failNextReconciliationReads -= 1;
      throw new Error("fixture reconciliation read failed");
    }
    return this.reconciliation === undefined
      ? undefined
      : cloneRecord(this.reconciliation);
  }

  public async persistReconciliation(
    input: PersistModelSettingsReconciliationInput,
  ): Promise<DeploymentModelSettings> {
    this.persistCalls += 1;
    this.activePersists += 1;
    this.maximumActivePersists = Math.max(
      this.maximumActivePersists,
      this.activePersists,
    );
    try {
      if (this.failNextPersists > 0) {
        this.failNextPersists -= 1;
        throw new Error("fixture reconciliation persistence failed");
      }
      await this.persistDelay?.();
      const record = cloneRecord(input.reconciliation);
      this.reconciliation = record;
      this.settings = {
        planType: record.planType,
        preferred: input.replacePreference
          ? { ...input.preferred }
          : { ...this.settings.preferred },
        effective:
          record.effective === null ? null : { ...record.effective },
        selectionState: record.selectionState,
        modelCatalogRefreshedAt:
          record.sourceRefreshedAt === null
            ? null
            : new Date(record.sourceRefreshedAt.getTime()),
      };
      return cloneSettings(this.settings);
    } finally {
      this.activePersists -= 1;
    }
  }
}

class EmittingFakeSource implements ModelCapabilitySource {
  public readonly kind = "chatgpt" as const;
  readonly #listeners = new Set<CapabilitiesListener>();
  current: CodexAccountCapabilitiesSnapshot = {
    state: "unavailable",
    planType: null,
    models: [],
    refreshedAt: null,
  };
  finalSnapshot: CodexAccountCapabilitiesSnapshot = available();
  refreshCalls = 0;
  refreshError: Error | undefined;
  beforeFinal: (() => Promise<void>) | undefined;
  afterFinal: (() => Promise<void>) | undefined;
  #refreshActive = false;

  public get listenerCount(): number {
    return this.#listeners.size;
  }

  public snapshot(): CodexAccountCapabilitiesSnapshot {
    return cloneCapabilitiesSnapshot(this.current);
  }

  public subscribe(listener: CapabilitiesListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public async refresh(): Promise<CodexAccountCapabilitiesSnapshot> {
    if (this.#refreshActive) {
      throw new Error("recursive capability refresh");
    }
    this.#refreshActive = true;
    this.refreshCalls += 1;
    try {
      if (this.refreshError !== undefined) {
        throw this.refreshError;
      }
      await this.emit({
        state: "refreshing",
        planType: this.current.planType,
        models: this.current.models,
        refreshedAt: this.current.refreshedAt,
      });
      await this.beforeFinal?.();
      await this.emit(this.finalSnapshot);
      await this.afterFinal?.();
      return cloneCapabilitiesSnapshot(this.finalSnapshot);
    } finally {
      this.#refreshActive = false;
    }
  }

  public async emit(
    snapshot: CodexAccountCapabilitiesSnapshot,
  ): Promise<void> {
    this.current = cloneCapabilitiesSnapshot(snapshot);
    for (const listener of this.#listeners) {
      await listener(cloneCapabilitiesSnapshot(snapshot));
    }
  }
}

function supportedProbe(): CapabilityPairRunner & {
  probe: ReturnType<typeof vi.fn<CapabilityPairRunner["probe"]>>;
} {
  return {
    probe: vi.fn<CapabilityPairRunner["probe"]>(async () => ({
      supported: true,
    })),
  };
}

function expectDomainError(
  code: ModelSettingsError["code"],
): (error: unknown) => boolean {
  return (error) => error instanceof ModelSettingsError && error.code === code;
}

describe("ModelSettingsService", () => {
  it("single-flights refresh and avoids recursive listener feedback", async () => {
    const source = new EmittingFakeSource();
    const store = new FakeStore();
    const probe = supportedProbe();
    const published: ModelSettingsReadinessSnapshot[] = [];
    const service = new ModelSettingsService({
      source,
      store,
      probe,
      readiness: {
        publish(snapshot) {
          published.push(structuredClone(snapshot));
        },
      },
    });
    await service.start();

    const [first, second] = await Promise.all([
      service.refresh(),
      service.refresh(),
    ]);

    expect(source.refreshCalls).toBe(1);
    expect(store.persistCalls).toBe(1);
    expect(probe.probe).toHaveBeenCalledOnce();
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      ready: true,
      state: "ready",
      effective: {
        modelId: "gpt-5.6-luna",
        reasoningEffort: "high",
      },
    });
    expect(published).toEqual([first]);
    await service.close();
  });

  it("ignores refreshing snapshots and coalesces identical final catalogs", async () => {
    const source = new EmittingFakeSource();
    const store = new FakeStore();
    const probe = supportedProbe();
    const service = new ModelSettingsService({ source, store, probe });
    await service.start();
    await service.refresh();

    source.finalSnapshot = available(
      structuredClone([luna]),
      new Date("2026-08-18T17:00:00Z"),
    );
    await service.refresh();

    expect(source.refreshCalls).toBe(2);
    expect(store.persistCalls).toBe(1);
    expect(probe.probe).toHaveBeenCalledOnce();
    await service.close();
  });

  it("coalesces one emitted and returned final even when persistence fails", async () => {
    const source = new EmittingFakeSource();
    let releaseReturn: (() => void) | undefined;
    const returnGate = new Promise<void>((resolve) => {
      releaseReturn = resolve;
    });
    source.afterFinal = async () => await returnGate;
    const store = new FakeStore();
    store.failNextPersists = 1;
    const probe = supportedProbe();
    const service = new ModelSettingsService({ source, store, probe });
    await service.start();

    const firstRefresh = service.refresh();
    const firstRejected = expect(firstRefresh).rejects.toSatisfy(
      expectDomainError("MODEL_SETTINGS_UNAVAILABLE"),
    );
    await vi.waitFor(() => expect(store.persistCalls).toBe(1));
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseReturn?.();
    await firstRejected;
    expect(store.persistCalls).toBe(1);
    expect(probe.probe).toHaveBeenCalledOnce();

    source.afterFinal = undefined;
    await expect(service.refresh()).resolves.toMatchObject({ ready: true });
    expect(store.persistCalls).toBe(2);
    expect(probe.probe).toHaveBeenCalledTimes(2);
    await service.close();
  });

  it("probes once for a changed catalog and once for a changed effective pair", async () => {
    const source = new EmittingFakeSource();
    const store = new FakeStore();
    const probe = supportedProbe();
    const service = new ModelSettingsService({ source, store, probe });
    await service.start();
    await service.refresh();

    source.finalSnapshot = available([luna, terra]);
    await service.refresh();
    await service.updatePreference({
      modelId: "gpt-5.6-terra",
      reasoningEffort: "low",
    });

    expect(store.persistCalls).toBe(3);
    expect(probe.probe).toHaveBeenCalledTimes(3);
    expect(probe.probe).toHaveBeenNthCalledWith(3, {
      model: "gpt-5.6-terra",
      effort: "low",
    });
    await service.close();
  });

  it("persists plan metadata without reprobing an unchanged catalog and pair", async () => {
    const source = new EmittingFakeSource();
    const store = new FakeStore();
    const probe = supportedProbe();
    const service = new ModelSettingsService({ source, store, probe });
    await service.start();
    await service.refresh();

    source.finalSnapshot = {
      ...available([luna], new Date("2026-08-18T17:00:00Z")),
      planType: "business",
    };
    await service.refresh();

    expect(store.persistCalls).toBe(2);
    expect(probe.probe).toHaveBeenCalledOnce();
    await expect(service.readDashboard()).resolves.toMatchObject({
      planType: "business",
    });
    await service.close();
  });

  it("serializes concurrently emitted final snapshots", async () => {
    const source = new EmittingFakeSource();
    const store = new FakeStore();
    store.persistDelay = async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
    };
    const probe = supportedProbe();
    const service = new ModelSettingsService({ source, store, probe });
    await service.start();

    await Promise.all([
      source.emit(available([luna])),
      source.emit(available([luna, terra])),
    ]);
    await service.close();

    expect(source.refreshCalls).toBe(0);
    expect(store.persistCalls).toBe(2);
    expect(store.maximumActivePersists).toBe(1);
    expect(probe.probe).toHaveBeenCalledTimes(2);
  });

  it("keeps readiness and dashboard reads side-effect free", async () => {
    const source = new EmittingFakeSource();
    const store = new FakeStore();
    const probe = supportedProbe();
    const service = new ModelSettingsService({ source, store, probe });
    await service.start();
    await service.refresh();
    const counts = {
      refresh: source.refreshCalls,
      persist: store.persistCalls,
      probe: probe.probe.mock.calls.length,
    };

    expect(service.readiness().ready).toBe(true);
    await expect(service.readDashboard()).resolves.toMatchObject({
      availableModels: [{ id: "gpt-5.6-luna" }],
      effective: {
        modelId: "gpt-5.6-luna",
        reasoningEffort: "high",
      },
    });
    expect({
      refresh: source.refreshCalls,
      persist: store.persistCalls,
      probe: probe.probe.mock.calls.length,
    }).toEqual(counts);
    await service.close();
  });

  it("retries startup after a persistence read fails without leaking a listener", async () => {
    const source = new EmittingFakeSource();
    const store = new FakeStore();
    store.failNextReconciliationReads = 1;
    const service = new ModelSettingsService({
      source,
      store,
      probe: supportedProbe(),
    });

    await expect(service.start()).rejects.toThrow(
      "fixture reconciliation read failed",
    );
    expect(source.listenerCount).toBe(0);
    await expect(service.start()).resolves.toBeUndefined();
    expect(source.listenerCount).toBe(1);
    await service.close();
    expect(source.listenerCount).toBe(0);
  });

  it("settles an active refresh before close returns and prevents post-close writes", async () => {
    const source = new EmittingFakeSource();
    let releaseFinal: (() => void) | undefined;
    let reachedGate: (() => void) | undefined;
    const gateReached = new Promise<void>((resolve) => {
      reachedGate = resolve;
    });
    const finalGate = new Promise<void>((resolve) => {
      releaseFinal = resolve;
    });
    source.beforeFinal = async () => {
      reachedGate?.();
      await finalGate;
    };
    const store = new FakeStore();
    const probe = supportedProbe();
    const service = new ModelSettingsService({ source, store, probe });
    await service.start();

    const refresh = service.refresh();
    const refreshRejected = expect(refresh).rejects.toSatisfy(
      expectDomainError("MODEL_SETTINGS_UNAVAILABLE"),
    );
    await gateReached;
    let closeSettled = false;
    const closing = service.close().then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    releaseFinal?.();

    await refreshRejected;
    await closing;
    expect(store.persistCalls).toBe(0);
    expect(probe.probe).not.toHaveBeenCalled();
  });

  it("retries a failed readiness publication on an identical stable snapshot", async () => {
    const source = new EmittingFakeSource();
    const store = new FakeStore();
    const probe = supportedProbe();
    const publish = vi
      .fn<(snapshot: Readonly<ModelSettingsReadinessSnapshot>) => Promise<void>>()
      .mockRejectedValueOnce(new Error("fixture publisher unavailable"))
      .mockResolvedValue(undefined);
    const service = new ModelSettingsService({
      source,
      store,
      probe,
      readiness: { publish },
    });
    await service.start();
    await service.refresh();

    source.finalSnapshot = available(
      [luna],
      new Date("2026-08-18T17:00:00Z"),
    );
    await service.refresh();

    expect(publish).toHaveBeenCalledTimes(2);
    expect(store.persistCalls).toBe(1);
    expect(probe.probe).toHaveBeenCalledOnce();
    await service.close();
  });

  it("publishes failed and recovered readiness in reconciliation order", async () => {
    const source = new EmittingFakeSource();
    const store = new FakeStore();
    store.failNextPersists = 1;
    const probe = supportedProbe();
    let releaseFirstPublication: (() => void) | undefined;
    const firstPublicationGate = new Promise<void>((resolve) => {
      releaseFirstPublication = resolve;
    });
    const completedPublications: ModelSettingsReadinessSnapshot[] = [];
    let publicationCalls = 0;
    const service = new ModelSettingsService({
      source,
      store,
      probe,
      readiness: {
        async publish(snapshot) {
          publicationCalls += 1;
          if (publicationCalls === 1) {
            await firstPublicationGate;
          }
          completedPublications.push(structuredClone(snapshot));
        },
      },
    });
    await service.start();

    await source.emit(available([luna]));
    await vi.waitFor(() => expect(publicationCalls).toBe(1));
    await source.emit(available([luna, terra]));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(store.persistCalls).toBe(1);
    releaseFirstPublication?.();
    await service.close();

    expect(completedPublications).toHaveLength(2);
    expect(completedPublications[0]).toMatchObject({
      ready: false,
      code: "MODEL_SETTINGS_UNAVAILABLE",
    });
    expect(completedPublications[1]).toMatchObject({ ready: true });
    expect(service.readiness().ready).toBe(true);
  });

  it("reports stale selections without probing or persisting them", async () => {
    const source = new EmittingFakeSource();
    const store = new FakeStore();
    const probe = supportedProbe();
    const service = new ModelSettingsService({ source, store, probe });
    await service.start();
    await service.refresh();

    await expect(
      service.updatePreference({
        modelId: "gpt-5.6-terra",
        reasoningEffort: "low",
      }),
    ).rejects.toSatisfy(expectDomainError("MODEL_SELECTION_STALE"));
    expect(store.persistCalls).toBe(1);
    expect(probe.probe).toHaveBeenCalledOnce();
    await service.close();
  });

  it("persists an unsupported effective probe once and does not retry an unchanged pair", async () => {
    const source = new EmittingFakeSource();
    const store = new FakeStore();
    const probe: CapabilityPairRunner = {
      probe: vi.fn(async () => ({
        supported: false,
        failure: "model" as const,
      })),
    };
    const service = new ModelSettingsService({ source, store, probe });
    await service.start();
    await expect(service.refresh()).resolves.toMatchObject({
      ready: false,
      code: "MODEL_PAIR_UNAVAILABLE",
    });

    await expect(
      service.updatePreference({
        modelId: "gpt-5.6-luna",
        reasoningEffort: "high",
      }),
    ).rejects.toSatisfy(expectDomainError("MODEL_PAIR_UNAVAILABLE"));
    expect(store.persistCalls).toBe(1);
    expect(probe.probe).toHaveBeenCalledOnce();
    await service.close();
  });

  it("distinguishes capability refresh failure from unavailable stable settings", async () => {
    const source = new EmittingFakeSource();
    source.refreshError = new Error("provider detail must remain a cause");
    const store = new FakeStore();
    const service = new ModelSettingsService({
      source,
      store,
      probe: supportedProbe(),
    });
    await service.start();

    await expect(service.refresh()).rejects.toSatisfy(
      expectDomainError("MODEL_CAPABILITY_REFRESH_FAILED"),
    );
    expect(service.readiness()).toMatchObject({
      ready: false,
      code: "MODEL_CAPABILITY_REFRESH_FAILED",
    });
    await expect(service.readDashboard()).rejects.toSatisfy(
      expectDomainError("MODEL_SETTINGS_UNAVAILABLE"),
    );
    expect(store.persistCalls).toBe(0);
    await service.close();
  });

  it("uses the same reconciliation path for an API-key static source", async () => {
    const source = new ApiKeyModelCapabilitySource({
      selection: {
        modelId: "gpt-5.6-luna",
        reasoningEffort: "high",
      },
      refreshedAt: new Date("2026-08-18T16:00:00Z"),
    });
    const store = new FakeStore();
    const probe = supportedProbe();
    const service = new ModelSettingsService({ source, store, probe });

    await service.start();
    await service.refresh();

    expect(store.persistCalls).toBe(1);
    expect(probe.probe).toHaveBeenCalledOnce();
    expect(service.readiness()).toMatchObject({
      ready: true,
      sourceKind: "api_key",
    });
    await service.close();
  });
});

describe("ModelSettingsHttpController", () => {
  const dashboardSnapshot: ModelSettingsDashboardSnapshot = {
    planType: "plus",
    preferred: { modelId: "gpt-5.6-luna", reasoningEffort: "high" },
    effective: { modelId: "gpt-5.6-luna", reasoningEffort: "high" },
    selectionState: "preferred",
    modelCatalogRefreshedAt: new Date("2026-08-18T16:00:00Z"),
    availableModels: [luna],
  };

  it.each([
    ["MODEL_SETTINGS_UNAVAILABLE", "MODEL_SETTINGS_UNAVAILABLE"],
    ["MODEL_SELECTION_STALE", "MODEL_SELECTION_STALE"],
    ["MODEL_PAIR_UNAVAILABLE", "MODEL_PAIR_UNAVAILABLE"],
    ["MODEL_CAPABILITY_REFRESH_FAILED", "MODEL_SETTINGS_UNAVAILABLE"],
  ] as const)("maps domain %s inside the HTTP adapter", async (domain, http) => {
    const controller = new ModelSettingsHttpController({
      readDashboard: vi.fn(async () => dashboardSnapshot),
      updatePreference: vi.fn(async (_selection: ModelSelection) => {
        throw new ModelSettingsError(domain);
      }),
    });

    await expect(
      controller.update({
        modelId: "gpt-5.6-luna",
        reasoningEffort: "high",
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ModelSettingsApiError && error.code === http,
    );
  });

  it("preserves the existing controller read and update snapshot contract", async () => {
    const service = {
      readDashboard: vi.fn(async () => dashboardSnapshot),
      updatePreference: vi.fn(async (_selection: ModelSelection) =>
        dashboardSnapshot,
      ),
    };
    const controller = new ModelSettingsHttpController(service);

    await expect(controller.read()).resolves.toEqual(dashboardSnapshot);
    await expect(
      controller.update({
        modelId: "gpt-5.6-luna",
        reasoningEffort: "high",
      }),
    ).resolves.toEqual(dashboardSnapshot);
  });
});
