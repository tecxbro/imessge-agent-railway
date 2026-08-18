/**
 * Executable production entrypoint.
 *
 * `src/index.ts` owns provider-neutral lifecycle ordering, while
 * `production-bootstrap.ts` supplies the real provider and storage adapters.
 */
import { pathToFileURL } from "node:url";

import {
  startAgentService,
  type RunningAgentService,
  type StartAgentServiceOptions,
} from "./index.js";

export type ProductionServer = RunningAgentService;

/**
 * Starts the production HTTP process through the same staged lifecycle used by
 * the operational runtime. Keeping this function injectable makes it possible
 * to prove boot ordering without opening provider connections in unit tests.
 */
export async function startProductionServer(
  options: StartAgentServiceOptions,
): Promise<ProductionServer> {
  return await startAgentService(options);
}

async function main(): Promise<void> {
  const { createProductionRuntime } = await import(
    "./runtime/production-bootstrap.js"
  );
  const runtime = await createProductionRuntime();

  const service = await startProductionServer({
    port: runtime.environment.PORT,
    host: "0.0.0.0",
    bootstrap: runtime.bootstrap,
    deploymentIdentity: runtime.deploymentIdentity,
    deploymentPage: {
      authMode: runtime.environment.CODEX_AUTH_MODE,
      supermemoryConfigured:
        runtime.environment.SUPERMEMORY_API_KEY !== undefined,
    },
    photonSetup: runtime.photonSetup,
    modelSettings: runtime.modelSettings,
    ...(runtime.chatgptSetup === undefined
      ? {}
      : { chatgptSetup: runtime.chatgptSetup }),
    onStartupFailure: (code) => {
      runtime.logger.error(
        { component: "bootstrap", errorCode: code },
        "agent startup stage failed; readiness remains closed",
      );
    },
  });
  const readiness = service.readiness.snapshot(
    service.spectrumReadiness.snapshot(),
  );

  runtime.logger.info(
    {
      component: "bootstrap",
      port: runtime.environment.PORT,
      promptBundleVersion: runtime.promptBundleVersion,
      ready: readiness.ready,
    },
    readiness.ready
      ? "operational agent service listening"
      : "agent HTTP service listening; operational readiness remains closed",
  );
}

const executablePath = process.argv[1];
if (
  executablePath !== undefined &&
  import.meta.url === pathToFileURL(executablePath).href
) {
  await main();
}
