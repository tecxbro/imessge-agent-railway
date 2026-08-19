import type {
  SpectrumRunExitReason,
  SpectrumRunHandle,
} from "./spectrum-run-handle.js";

export const ACTIVATION_STATES = [
  "initializing",
  "blocked",
  "starting",
  "active",
  "stopping",
  "degraded",
  "shutting_down",
  "stopped",
] as const;

export type ActivationState = (typeof ACTIVATION_STATES)[number];

export const ACTIVATION_BLOCKERS = [
  "startup_incomplete",
  "owner_not_configured",
  "photon_not_connected",
  "photon_owner_revision_stale",
  "codex_auth_missing",
  "codex_auth_failed",
  "codex_capabilities_unavailable",
] as const;

export type ActivationBlocker = (typeof ACTIVATION_BLOCKERS)[number];

export type CodexAuthSnapshot = "ready" | "missing" | "failed";
export type CodexCapabilitiesSnapshot = "available" | "unavailable";
export type SpectrumActivationStatus =
  | "stopped"
  | "starting"
  | "active"
  | "stopping"
  | "degraded";

export interface OwnerActivationSnapshot {
  configured: boolean;
}

export interface PhotonActivationSnapshot {
  connected: boolean;
  ownerRevisionCurrent: boolean;
}

export interface CodexActivationSnapshot {
  auth: CodexAuthSnapshot;
  capabilities: CodexCapabilitiesSnapshot;
}

export interface ActivationSnapshot {
  readonly state: ActivationState;
  readonly blockers: readonly ActivationBlocker[];
  readonly shouldRun: boolean;
  readonly ready: boolean;
  readonly startupCompleted: boolean;
  readonly ownerConfigured: boolean;
  readonly photonConnected: boolean;
  readonly photonOwnerRevisionCurrent: boolean;
  readonly codexAuth: CodexAuthSnapshot;
  readonly codexCapabilities: CodexCapabilitiesSnapshot;
  readonly spectrum: SpectrumActivationStatus;
  readonly runId: string | null;
  readonly recoveryAttempt: number;
  readonly recoveryScheduled: boolean;
  readonly shuttingDown: boolean;
}

export interface ActivationReadinessSink {
  publish(snapshot: ActivationSnapshot): void;
}

export interface RecoverySchedule {
  readonly recoveryId: number;
  readonly attempt: number;
  readonly delayMs: number;
  fire(): void;
}

export interface RecoveryScheduler {
  schedule(recovery: RecoverySchedule): void;
  cancel(): void;
}

export interface StartupCompletedEvent {
  type: "StartupCompleted";
}

export interface OwnerSnapshotChangedEvent {
  type: "OwnerSnapshotChanged";
  snapshot: OwnerActivationSnapshot;
}

export interface PhotonSnapshotChangedEvent {
  type: "PhotonSnapshotChanged";
  snapshot: PhotonActivationSnapshot;
}

export interface CodexSnapshotChangedEvent {
  type: "CodexSnapshotChanged";
  snapshot: CodexActivationSnapshot;
}

export interface SpectrumStartedEvent {
  type: "SpectrumStarted";
  startId: number;
  handle: SpectrumRunHandle;
}

export interface SpectrumExitedEvent {
  type: "SpectrumExited";
  startId: number;
  runId?: string;
  reason: SpectrumRunExitReason | "start_failed";
}

export interface RecoveryTimerFiredEvent {
  type: "RecoveryTimerFired";
  recoveryId: number;
}

export interface ShutdownRequestedEvent {
  type: "ShutdownRequested";
}

export type ActivationEvent =
  | StartupCompletedEvent
  | OwnerSnapshotChangedEvent
  | PhotonSnapshotChangedEvent
  | CodexSnapshotChangedEvent
  | SpectrumStartedEvent
  | SpectrumExitedEvent
  | RecoveryTimerFiredEvent
  | ShutdownRequestedEvent;
