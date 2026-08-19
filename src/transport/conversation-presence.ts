import type { Space } from "spectrum-ts";

import type { OperationalRepository } from "../db/repositories/operational.js";
import type { PersistedSpaceRoute, SpaceResolver } from "./space-resolver.js";

export const DEFAULT_TYPING_RUNTIME_BUFFER_MS = 30_000;

export const CONVERSATION_PRESENCE_METRICS = {
  startAttempts: "spectrum_typing_start_attempts_total",
  startFailures: "spectrum_typing_start_failures_total",
  stopAttempts: "spectrum_typing_stop_attempts_total",
  stopFailures: "spectrum_typing_stop_failures_total",
  safetyTimeouts: "spectrum_typing_safety_timeouts_total",
} as const;

export type ConversationPresenceMetricName =
  (typeof CONVERSATION_PRESENCE_METRICS)[keyof typeof CONVERSATION_PRESENCE_METRICS];

export interface ConversationPresenceMetricsPort {
  increment(metric: ConversationPresenceMetricName): void;
}

/** Label-free by design: presence telemetry cannot carry conversation data. */
export class ConversationPresenceMetrics
  implements ConversationPresenceMetricsPort
{
  readonly #counts: Record<ConversationPresenceMetricName, number> = {
    [CONVERSATION_PRESENCE_METRICS.startAttempts]: 0,
    [CONVERSATION_PRESENCE_METRICS.startFailures]: 0,
    [CONVERSATION_PRESENCE_METRICS.stopAttempts]: 0,
    [CONVERSATION_PRESENCE_METRICS.stopFailures]: 0,
    [CONVERSATION_PRESENCE_METRICS.safetyTimeouts]: 0,
  };

  public increment(metric: ConversationPresenceMetricName): void {
    this.#counts[metric] += 1;
  }

  public snapshot(): Readonly<Record<ConversationPresenceMetricName, number>> {
    return { ...this.#counts };
  }
}

export interface ConversationPresencePort {
  begin(spaceId: string): Promise<number>;
  end(spaceId: string, generation?: number): Promise<void>;
  close(): Promise<void>;
}

export interface InboundConversationPresencePort {
  reserve(route: PersistedSpaceRoute): number;
  beginRoute(route: PersistedSpaceRoute, generation: number): Promise<void>;
  endRoute(route: PersistedSpaceRoute, generation?: number): Promise<void>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export interface ConversationPresenceOptions {
  operational: Pick<OperationalRepository, "getPersistedRoute">;
  resolver: SpaceResolver<Space>;
  maximumTypingDurationMs: number;
  metrics?: ConversationPresenceMetricsPort;
  setTimeout?: typeof globalThis.setTimeout;
}

interface PresenceState {
  active: boolean;
  generation: number;
  operation: Promise<void>;
  providerSpace: Space | undefined;
  route: PersistedSpaceRoute;
  safetyTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  typing: boolean;
}

interface ChainPresenceBinding {
  generation: number;
  route: PersistedSpaceRoute;
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function routeKey(route: PersistedSpaceRoute): string {
  return `${route.spaceType}\0${route.spaceGuid}\0${route.routePhone ?? ""}`;
}

/**
 * Owns real Spectrum typing state without persisting ephemeral presence.
 * Every provider and telemetry failure is contained inside this boundary.
 */
export class ConversationPresenceCoordinator
  implements ConversationPresencePort, InboundConversationPresencePort
{
  readonly #activeByRoute = new Map<string, PresenceState>();
  readonly #chainBindings = new Map<string, ChainPresenceBinding>();
  readonly #generationByRoute = new Map<string, number>();
  readonly #metrics: ConversationPresenceMetricsPort;
  readonly #maximumTypingDurationMs: number;
  readonly #routesBySpaceId = new Map<string, PersistedSpaceRoute>();
  readonly #setTimeout: typeof globalThis.setTimeout;
  #closed = false;

  public constructor(private readonly options: ConversationPresenceOptions) {
    this.#maximumTypingDurationMs = positiveInteger(
      "maximumTypingDurationMs",
      options.maximumTypingDurationMs,
    );
    this.#metrics = options.metrics ?? new ConversationPresenceMetrics();
    this.#setTimeout = options.setTimeout ?? globalThis.setTimeout;
  }

  /** Associates the durable identifier with its already-normalized provider route. */
  public associateSpace(spaceId: string, route: PersistedSpaceRoute): void {
    if (!this.#closed) {
      this.#routesBySpaceId.set(spaceId, route);
    }
  }

  /** Reserves a generation after authorization, before any provider action. */
  public reserve(route: PersistedSpaceRoute): number {
    if (this.#closed) return 0;

    const key = routeKey(route);
    const generation = (this.#generationByRoute.get(key) ?? 0) + 1;
    this.#generationByRoute.set(key, generation);
    const existing = this.#activeByRoute.get(key);
    if (existing === undefined) {
      this.#activeByRoute.set(key, {
        active: true,
        generation,
        operation: Promise.resolve(),
        providerSpace: undefined,
        route,
        safetyTimer: undefined,
        typing: false,
      });
      return generation;
    }

    existing.active = true;
    existing.generation = generation;
    existing.route = route;
    if (existing.typing) {
      this.#refreshSafetyDeadline(existing);
    }
    return generation;
  }

  public async begin(spaceId: string): Promise<number> {
    const route = await this.#routeForSpace(spaceId, "start");
    if (route === undefined) return 0;
    const generation = this.reserve(route);
    await this.beginRoute(route, generation);
    return generation;
  }

  public async beginRoute(
    route: PersistedSpaceRoute,
    generation: number,
  ): Promise<void> {
    if (this.#closed || generation < 1) return;
    const state = this.#activeByRoute.get(routeKey(route));
    if (state === undefined || !state.active || state.generation < generation) {
      return;
    }

    await this.#enqueue(state, async () => {
      if (!state.active || state.generation < generation) return;
      if (state.typing) {
        this.#refreshSafetyDeadline(state);
        return;
      }

      this.#increment(CONVERSATION_PRESENCE_METRICS.startAttempts);
      try {
        const space = await this.options.resolver.resolve(state.route);
        await space.startTyping();
        state.providerSpace = space;
        state.typing = true;
        if (state.active) {
          this.#refreshSafetyDeadline(state);
        } else {
          await this.#stopProvider(state);
        }
      } catch {
        this.#increment(CONVERSATION_PRESENCE_METRICS.startFailures);
      }
    });
  }

  public async end(spaceId: string, generation?: number): Promise<void> {
    const route = await this.#routeForSpace(spaceId, "stop");
    if (route !== undefined) {
      await this.endRoute(route, generation);
    }
  }

  public async endRoute(
    route: PersistedSpaceRoute,
    generation?: number,
  ): Promise<void> {
    const key = routeKey(route);
    const state = this.#activeByRoute.get(key);
    if (state === undefined) return;
    const expectedGeneration = generation ?? state.generation;
    if (state.generation !== expectedGeneration) return;

    state.active = false;
    this.#clearSafetyDeadline(state);
    await this.#enqueue(state, async () => {
      if (state.active || state.generation !== expectedGeneration) return;
      await this.#stopProvider(state);
      if (
        !state.active &&
        state.generation === expectedGeneration &&
        this.#activeByRoute.get(key) === state
      ) {
        this.#activeByRoute.delete(key);
      }
    });
    this.#deleteChainBindings(route, expectedGeneration);
  }

  /** Captures the generation owned by a newly materialized durable chain. */
  public bindChain(chainId: string, spaceId: string): void {
    const route = this.#routesBySpaceId.get(spaceId);
    if (route === undefined) return;
    const state = this.#activeByRoute.get(routeKey(route));
    if (state === undefined || !state.active) return;
    this.#chainBindings.set(chainId, {
      generation: state.generation,
      route,
    });
  }

  public async endChain(chainId: string): Promise<void> {
    const binding = this.#chainBindings.get(chainId);
    if (binding === undefined) return;
    this.#chainBindings.delete(chainId);
    await this.endRoute(binding.route, binding.generation);
  }

  public async endChains(chainIds: readonly string[]): Promise<void> {
    await Promise.all([...new Set(chainIds)].map((id) => this.endChain(id)));
  }

  /** Stops active indicators after a provider disconnect while allowing reuse. */
  public async reset(): Promise<void> {
    await this.#stopAll(false);
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#stopAll(true);
  }

  async #stopAll(clearAliases: boolean): Promise<void> {
    const states = [...this.#activeByRoute.values()];
    this.#chainBindings.clear();
    await Promise.all(
      states.map(async (state) => {
        const generation = state.generation;
        state.active = false;
        this.#clearSafetyDeadline(state);
        await this.#enqueue(state, async () => {
          if (state.active || state.generation !== generation) return;
          await this.#stopProvider(state);
        });
      }),
    );
    for (const [key, state] of this.#activeByRoute) {
      if (!state.active) this.#activeByRoute.delete(key);
    }
    if (clearAliases) {
      this.#routesBySpaceId.clear();
      this.#generationByRoute.clear();
    }
  }

  async #routeForSpace(
    spaceId: string,
    operation: "start" | "stop",
  ): Promise<PersistedSpaceRoute | undefined> {
    const known = this.#routesBySpaceId.get(spaceId);
    if (known !== undefined) return known;
    try {
      const route = await this.options.operational.getPersistedRoute(spaceId);
      this.#routesBySpaceId.set(spaceId, route);
      return route;
    } catch {
      this.#increment(
        operation === "start"
          ? CONVERSATION_PRESENCE_METRICS.startFailures
          : CONVERSATION_PRESENCE_METRICS.stopFailures,
      );
      return undefined;
    }
  }

  #enqueue(
    state: PresenceState,
    operation: () => Promise<void>,
  ): Promise<void> {
    const next = state.operation.then(operation, operation);
    state.operation = next.catch(() => undefined);
    return next;
  }

  async #stopProvider(state: PresenceState): Promise<void> {
    if (!state.typing || state.providerSpace === undefined) return;
    this.#increment(CONVERSATION_PRESENCE_METRICS.stopAttempts);
    try {
      await state.providerSpace.stopTyping();
    } catch {
      this.#increment(CONVERSATION_PRESENCE_METRICS.stopFailures);
    } finally {
      state.providerSpace = undefined;
      state.typing = false;
    }
  }

  #refreshSafetyDeadline(state: PresenceState): void {
    this.#clearSafetyDeadline(state);
    const generation = state.generation;
    state.safetyTimer = this.#setTimeout(() => {
      this.#increment(CONVERSATION_PRESENCE_METRICS.safetyTimeouts);
      void this.endRoute(state.route, generation);
    }, this.#maximumTypingDurationMs);
    state.safetyTimer.unref?.();
  }

  #clearSafetyDeadline(state: PresenceState): void {
    if (state.safetyTimer === undefined) return;
    clearTimeout(state.safetyTimer);
    state.safetyTimer = undefined;
  }

  #deleteChainBindings(route: PersistedSpaceRoute, generation: number): void {
    const key = routeKey(route);
    for (const [chainId, binding] of this.#chainBindings) {
      if (
        binding.generation === generation &&
        routeKey(binding.route) === key
      ) {
        this.#chainBindings.delete(chainId);
      }
    }
  }

  #increment(metric: ConversationPresenceMetricName): void {
    try {
      this.#metrics.increment(metric);
    } catch {
      // Aggregate telemetry is cosmetic and cannot affect provider health.
    }
  }
}
