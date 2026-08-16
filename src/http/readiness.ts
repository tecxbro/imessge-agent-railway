export const SPECTRUM_CONNECTION_STATES = [
  "starting",
  "connected",
  "degraded",
  "stopped",
] as const;

export type SpectrumConnectionState =
  (typeof SPECTRUM_CONNECTION_STATES)[number];

export const SPECTRUM_FAILURE_CODES = [
  "SPECTRUM_STREAM_DISCONNECTED",
  "SPECTRUM_STREAM_RESTART_EXHAUSTED",
] as const;

export type SpectrumFailureCode = (typeof SPECTRUM_FAILURE_CODES)[number];

export interface SpectrumReadinessSnapshot {
  component: "spectrum";
  ready: boolean;
  state: SpectrumConnectionState;
  failureCode?: SpectrumFailureCode;
  restartAttempt?: number;
}

export const READINESS_COMPONENTS = [
  "configuration",
  "database",
  "migrations",
  "queue",
  "spectrum",
  "codexAuth",
  "codexCapabilities",
  "disk",
  "workspace",
  "supermemory",
] as const;

export type ReadinessComponent = (typeof READINESS_COMPONENTS)[number];

export const READINESS_STATES = [
  "unknown",
  "starting",
  "ok",
  "disabled",
  "missing",
  "degraded",
  "failed",
  "stopping",
] as const;

export type ReadinessState = (typeof READINESS_STATES)[number];

export interface ComponentReadiness {
  state: ReadinessState;
  code?: string;
}

export interface ServiceReadinessSnapshot {
  status: "ready" | "not_ready";
  ready: boolean;
  shuttingDown: boolean;
  components: Record<ReadinessComponent, ComponentReadiness>;
  actions: string[];
}

const CRITICAL_COMPONENTS: ReadonlySet<ReadinessComponent> = new Set([
  "configuration",
  "database",
  "migrations",
  "queue",
  "spectrum",
  "codexAuth",
  "codexCapabilities",
  "disk",
  "workspace",
]);

const SAFE_ACTIONS: Readonly<Partial<Record<string, string>>> = {
  CODEX_AUTH_MISSING:
    "Open the agent dashboard and connect ChatGPT. Agent intake stays off until sign-in and the Codex readiness check finish.",
  CODEX_AUTH_EXPIRED:
    "Open the agent dashboard and reconnect ChatGPT. Agent intake stays off until the Codex readiness check finishes.",
  CODEX_CAPABILITY_FAILED:
    "Run the configured Codex model and effort capability probe, correct unsupported profiles, then restart.",
  DATABASE_UNAVAILABLE:
    "Restore PostgreSQL connectivity before accepting new message execution.",
  MIGRATIONS_PENDING:
    "Run npm run db:migrate with the current release before starting workers.",
  PERSISTENT_STORAGE_INVALID:
    "Verify the persistent disk mount, ownership, and 0700 directory permissions, then restart.",
  SPECTRUM_STREAM_DISCONNECTED:
    "Check Photon connectivity and credentials while the supervised receive loop reconnects.",
  SPECTRUM_STREAM_RESTART_EXHAUSTED:
    "Check Photon connectivity and credentials, then restart the service.",
};

function initialComponents(): Record<ReadinessComponent, ComponentReadiness> {
  return Object.fromEntries(
    READINESS_COMPONENTS.map((component) => [component, { state: "unknown" }]),
  ) as Record<ReadinessComponent, ComponentReadiness>;
}

function cloneComponents(
  components: Readonly<Record<ReadinessComponent, ComponentReadiness>>,
): Record<ReadinessComponent, ComponentReadiness> {
  return Object.fromEntries(
    READINESS_COMPONENTS.map((component) => [
      component,
      { ...components[component] },
    ]),
  ) as Record<ReadinessComponent, ComponentReadiness>;
}

/**
 * Stores only bounded component states and operator-safe error codes. Provider
 * errors and configuration values must never be passed into this registry.
 */
export class ReadinessRegistry {
  readonly #components = initialComponents();
  #shuttingDown = false;

  public mark(
    component: ReadinessComponent,
    state: ReadinessState,
    code?: string,
  ): void {
    if (code !== undefined && !/^[A-Z][A-Z0-9_]{2,127}$/u.test(code)) {
      throw new Error(
        "Readiness codes must be bounded uppercase identifiers, not raw provider errors.",
      );
    }
    this.#components[component] = {
      state,
      ...(code === undefined ? {} : { code }),
    };
  }

  public beginShutdown(): void {
    this.#shuttingDown = true;
  }

  public snapshot(
    spectrum?: Readonly<SpectrumReadinessSnapshot>,
  ): ServiceReadinessSnapshot {
    const components = cloneComponents(this.#components);
    if (spectrum !== undefined) {
      components.spectrum = {
        state:
          spectrum.state === "connected"
            ? "ok"
            : spectrum.state === "starting"
              ? "starting"
              : spectrum.state === "degraded"
                ? "degraded"
                : this.#shuttingDown
                  ? "stopping"
                  : "missing",
        ...(spectrum.failureCode === undefined
          ? {}
          : { code: spectrum.failureCode }),
      };
    }

    const ready =
      !this.#shuttingDown &&
      [...CRITICAL_COMPONENTS].every(
        (component) => components[component].state === "ok",
      );
    const actions = [
      ...new Set(
        READINESS_COMPONENTS.flatMap((component) => {
          const code = components[component].code;
          const action = code === undefined ? undefined : SAFE_ACTIONS[code];
          return action === undefined ? [] : [action];
        }),
      ),
    ];

    return {
      status: ready ? "ready" : "not_ready",
      ready,
      shuttingDown: this.#shuttingDown,
      components,
      actions,
    };
  }
}

/**
 * Holds only operator-safe Spectrum health metadata. Raw errors, credentials,
 * phone numbers, and space identifiers never enter the readiness snapshot.
 */
export class SpectrumReadiness {
  #snapshot: SpectrumReadinessSnapshot = {
    component: "spectrum",
    ready: false,
    state: "stopped",
  };

  public markStarting(restartAttempt = 0): void {
    this.#snapshot = {
      component: "spectrum",
      ready: false,
      state: "starting",
      ...(restartAttempt > 0 ? { restartAttempt } : {}),
    };
  }

  public markConnected(): void {
    this.#snapshot = {
      component: "spectrum",
      ready: true,
      state: "connected",
    };
  }

  public markDegraded(
    failureCode: SpectrumFailureCode,
    restartAttempt: number,
  ): void {
    this.#snapshot = {
      component: "spectrum",
      ready: false,
      state: "degraded",
      failureCode,
      restartAttempt,
    };
  }

  public markStopped(): void {
    this.#snapshot = {
      component: "spectrum",
      ready: false,
      state: "stopped",
    };
  }

  public snapshot(): Readonly<SpectrumReadinessSnapshot> {
    return { ...this.#snapshot };
  }
}
