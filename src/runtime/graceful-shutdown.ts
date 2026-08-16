import { ReadinessRegistry } from "../http/readiness.js";

export interface ShutdownHook {
  name: string;
  priority: number;
  timeoutMs: number;
  critical?: boolean;
  stop(): Promise<void>;
}

export interface ShutdownFailure {
  name: string;
  critical: boolean;
  code: "SHUTDOWN_FAILED" | "SHUTDOWN_TIMEOUT";
}

export interface ShutdownResult {
  clean: boolean;
  failures: ShutdownFailure[];
}

class ShutdownTimeoutError extends Error {
  public constructor(name: string) {
    super(`Shutdown hook ${name} timed out.`);
    this.name = "ShutdownTimeoutError";
  }
}

function withTimeout(hook: ShutdownHook): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ShutdownTimeoutError(hook.name));
    }, hook.timeoutMs);
    timer.unref();
    hook.stop().then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class GracefulShutdown {
  readonly #abortController = new AbortController();
  readonly #hooks: ShutdownHook[] = [];
  #running?: Promise<ShutdownResult>;

  public constructor(private readonly readiness: ReadinessRegistry) {}

  public get signal(): AbortSignal {
    return this.#abortController.signal;
  }

  public register(hook: ShutdownHook): void {
    if (this.#running !== undefined) {
      throw new Error("Cannot register a shutdown hook after shutdown begins.");
    }
    if (
      hook.name.trim().length === 0 ||
      !Number.isFinite(hook.priority) ||
      !Number.isInteger(hook.timeoutMs) ||
      hook.timeoutMs < 1
    ) {
      throw new Error(
        "Shutdown hooks require a name, finite priority, and positive timeout.",
      );
    }
    if (this.#hooks.some((registered) => registered.name === hook.name)) {
      throw new Error(`Shutdown hook ${hook.name} is already registered.`);
    }
    this.#hooks.push(hook);
  }

  public shutdown(
    _reason: NodeJS.Signals | "test" = "test",
  ): Promise<ShutdownResult> {
    this.#running ??= this.#run();
    return this.#running;
  }

  async #run(): Promise<ShutdownResult> {
    // Close readiness and broadcast cancellation before running hooks. Lower
    // priorities stop dependents first; HTTP remains available until last.
    this.readiness.beginShutdown();
    this.#abortController.abort(new Error("Service shutdown requested"));
    const failures: ShutdownFailure[] = [];
    const hooks = [...this.#hooks].sort(
      (left, right) => left.priority - right.priority,
    );

    for (const hook of hooks) {
      try {
        await withTimeout(hook);
      } catch (error) {
        failures.push({
          name: hook.name,
          critical: hook.critical ?? true,
          code: error instanceof ShutdownTimeoutError
            ? "SHUTDOWN_TIMEOUT"
            : "SHUTDOWN_FAILED",
        });
      }
    }

    return {
      clean: failures.every((failure) => !failure.critical),
      failures,
    };
  }
}

export function installShutdownSignals(input: {
  shutdown: GracefulShutdown;
  onResult?: (result: ShutdownResult, signal: NodeJS.Signals) => void;
}): () => void {
  const listeners = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    const listener = (): void => {
      void input.shutdown.shutdown(signal).then((result) => {
        if (!result.clean) {
          process.exitCode = 1;
        }
        input.onResult?.(result, signal);
      });
    };
    listeners.set(signal, listener);
    process.once(signal, listener);
  }
  return () => {
    for (const [signal, listener] of listeners) {
      process.removeListener(signal, listener);
    }
  };
}
