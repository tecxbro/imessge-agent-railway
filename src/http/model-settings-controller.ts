import type { ModelSettingsDashboardSnapshot } from "../agent/model-settings-service.js";
import {
  isModelSettingsError,
  type ModelSettingsErrorCode,
} from "../agent/model-settings-errors.js";
import type { ModelSelection } from "../agent/model-selection.js";
import {
  ModelSettingsApiError,
  type ModelSettingsApiErrorCode,
  type ModelSettingsApiSnapshot,
  type ModelSettingsController,
} from "./server.js";

export interface ModelSettingsHttpService {
  readDashboard(): Promise<ModelSettingsDashboardSnapshot>;
  updatePreference(
    selection: ModelSelection,
  ): Promise<ModelSettingsDashboardSnapshot>;
}

function httpErrorCode(
  code: ModelSettingsErrorCode,
): ModelSettingsApiErrorCode {
  return code === "MODEL_SELECTION_STALE" || code === "MODEL_PAIR_UNAVAILABLE"
    ? code
    : "MODEL_SETTINGS_UNAVAILABLE";
}

export class ModelSettingsHttpController implements ModelSettingsController {
  public constructor(private readonly service: ModelSettingsHttpService) {}

  public async read(): Promise<ModelSettingsApiSnapshot> {
    return await this.#map(async () => await this.service.readDashboard());
  }

  public async update(
    selection: ModelSelection,
  ): Promise<ModelSettingsApiSnapshot> {
    return await this.#map(
      async () => await this.service.updatePreference(selection),
    );
  }

  async #map(
    operation: () => Promise<ModelSettingsDashboardSnapshot>,
  ): Promise<ModelSettingsApiSnapshot> {
    try {
      return await operation();
    } catch (error) {
      throw new ModelSettingsApiError(
        isModelSettingsError(error)
          ? httpErrorCode(error.code)
          : "MODEL_SETTINGS_UNAVAILABLE",
      );
    }
  }
}
