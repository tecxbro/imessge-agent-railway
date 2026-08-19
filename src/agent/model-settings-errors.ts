export const MODEL_SETTINGS_ERROR_CODES = [
  "MODEL_SETTINGS_UNAVAILABLE",
  "MODEL_SELECTION_STALE",
  "MODEL_PAIR_UNAVAILABLE",
  "MODEL_CAPABILITY_REFRESH_FAILED",
] as const;

export type ModelSettingsErrorCode =
  (typeof MODEL_SETTINGS_ERROR_CODES)[number];

export class ModelSettingsError extends Error {
  public constructor(
    public readonly code: ModelSettingsErrorCode,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "ModelSettingsError";
  }
}

export function isModelSettingsError(
  error: unknown,
): error is ModelSettingsError {
  return error instanceof ModelSettingsError;
}
