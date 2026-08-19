export type SpectrumRunExitReason = "exited" | "restart_exhausted";

export interface SpectrumRunCompletion {
  reason: SpectrumRunExitReason;
}

export type SpectrumStopReason =
  | "prerequisite_lost"
  | "shutdown"
  | "stale_start";

export interface SpectrumRunHandle {
  readonly runId: string;
  readonly done: Promise<SpectrumRunCompletion>;
  stop(reason: SpectrumStopReason): Promise<void>;
}

export interface SpectrumRunFactory {
  start(): Promise<SpectrumRunHandle>;
}
