import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";

import type { Environment } from "../config/env.js";

export interface SpectrumCloudCredentials {
  projectId: string;
  projectSecret: string;
}

export interface PersistedPhotonCredentials {
  photonProjectId: string;
  spectrumProjectSecret: string;
}

export function spectrumCredentialsFromEnvironment(
  environment: Pick<
    Environment,
    "SPECTRUM_PROJECT_ID" | "SPECTRUM_PROJECT_SECRET"
  >,
): SpectrumCloudCredentials | undefined {
  if (
    environment.SPECTRUM_PROJECT_ID === undefined ||
    environment.SPECTRUM_PROJECT_SECRET === undefined
  ) {
    return undefined;
  }
  return {
    projectId: environment.SPECTRUM_PROJECT_ID,
    projectSecret: environment.SPECTRUM_PROJECT_SECRET,
  };
}

/**
 * Resolves runtime credentials with dashboard-managed Photon setup taking
 * precedence over the legacy environment pair.
 */
export function resolveSpectrumCloudCredentials(
  persisted: PersistedPhotonCredentials | undefined,
  environment: Pick<
    Environment,
    "SPECTRUM_PROJECT_ID" | "SPECTRUM_PROJECT_SECRET"
  >,
): SpectrumCloudCredentials | undefined {
  if (persisted !== undefined) {
    return {
      projectId: persisted.photonProjectId,
      projectSecret: persisted.spectrumProjectSecret,
    };
  }
  return spectrumCredentialsFromEnvironment(environment);
}

export function buildSpectrumCloudOptions(
  credentials: SpectrumCloudCredentials,
) {
  // spectrum-ts 12.7.0 declares the optional empty iMessage config as a
  // `never` parameter under the repository's TypeScript 7 compiler. The
  // documented and runtime API is still `imessage.config()`.
  const configureIMessage = imessage.config as unknown as () => ReturnType<
    typeof imessage.config
  >;
  const provider = configureIMessage();

  return {
    projectId: credentials.projectId,
    projectSecret: credentials.projectSecret,
    providers: [provider] as [typeof provider],
  };
}

/** Creates the long-lived Spectrum Cloud application and its iMessage gRPC provider. */
export async function createSpectrumApp(
  credentials: SpectrumCloudCredentials,
) {
  const options = buildSpectrumCloudOptions(credentials);
  return Spectrum<typeof options.providers>(options);
}

export type SpectrumApp = Awaited<ReturnType<typeof createSpectrumApp>>;
