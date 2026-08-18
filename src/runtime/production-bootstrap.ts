/**
 * Production composition root.
 *
 * Connects configuration, storage, PostgreSQL, pg-boss, Codex, optional
 * Supermemory, authorization, and Spectrum into the generic lifecycle defined
 * in `src/index.ts`.
 *
 * Keep provider construction here. Domain modules depend on injected
 * interfaces so they remain testable without live accounts.
 */
import { dirname, resolve } from "node:path";

import type { Logger } from "pino";
import type { Space } from "spectrum-ts";

import {
  CodexAppServerAuth,
  type ChatGptSetupController,
} from "../agent/codex-app-server-auth.js";
import { CodexClient } from "../agent/codex-client.js";
import { buildCodexChildEnvironment } from "../agent/child-environment.js";
import { ExecutionRuntime } from "../agent/execution-runtime.js";
import { InteractionRuntime } from "../agent/interaction-runtime.js";
import {
  modelSupportsSelection,
  type ModelSelection,
} from "../agent/model-selection.js";
import { ThreadStore } from "../agent/thread-store.js";
import {
  createCodexPairRunner,
  probeCodexCapabilities,
} from "../config/capabilities.js";
import {
  loadEnvironment,
  type Environment,
} from "../config/env.js";
import { loadPromptBundle } from "../config/prompt-bundle.js";
import { createDatabaseClient, type DatabaseClient } from "../db/client.js";
import { runDatabaseMigrations } from "../db/migrate.js";
import { ChainRepository } from "../db/repositories/chains.js";
import { CommandRepository } from "../db/repositories/commands.js";
import { PostgresCodexThreadRepository } from "../db/repositories/codex-threads.js";
import { FailureRepository } from "../db/repositories/failures.js";
import { InboundRepository } from "../db/repositories/inbound.js";
import { PostgresMemoryReceiptStore } from "../db/repositories/memory-receipts.js";
import {
  ModelPreferenceUnavailableError,
  ModelSettingsRepository,
} from "../db/repositories/model-settings.js";
import { OperationalRepository } from "../db/repositories/operational.js";
import { OrchestrationRepository } from "../db/repositories/orchestration.js";
import { OutboundRepository } from "../db/repositories/outbound.js";
import { RetentionRepository } from "../db/repositories/retention.js";
import type { AgentServiceBootstrap } from "../index.js";
import {
  ModelSettingsApiError,
  type ModelSettingsController,
} from "../http/server.js";
import { recallMemoryContext } from "../memory/recall.js";
import {
  SupermemoryClient,
  type SupermemoryPort,
} from "../memory/supermemory-client.js";
import { createLogger } from "../observability/logger.js";
import { DurableQueue } from "../queue/boss.js";
import { createInboundFlushHandler } from "../queue/handlers/inbound-flush.js";
import { createOutboundSendHandler } from "../queue/handlers/outbound-send.js";
import { createRetentionHandler } from "../queue/handlers/retention.js";
import { createTaskExecuteHandler } from "../queue/handlers/task-execute.js";
import { createTurnPlanHandler } from "../queue/handlers/turn-plan.js";
import { createTurnSynthesizeHandler } from "../queue/handlers/turn-synthesize.js";
import { InFlightChainRegistry } from "../queue/in-flight-chain-registry.js";
import { QUEUE_NAMES } from "../queue/names.js";
import { DurablePipeline } from "../queue/pipeline.js";
import { PgBossPublisher } from "../queue/publisher.js";
import {
  DatabaseAuthorizationDirectory,
  DatabaseGroupReplyVerifier,
  DeterministicSenderAuthorizer,
  SecureAuthorizeAndIngest,
} from "../security/authorize-sender.js";
import { createDataCipher } from "../security/data-cipher.js";
import { OperationalRateLimits } from "../security/rate-limits.js";
import { auditStartupSecretBoundaries } from "../security/secret-boundaries.js";
import { runSpectrumMessageLoop } from "../transport/message-loop.js";
import {
  PhotonSetupService,
  type PhotonSetupController,
} from "../transport/photon-setup.js";
import {
  DurableInboundConsumer,
  NativeSpectrumOutboundTransport,
} from "../transport/operational.js";
import { createSpectrumSpaceResolver } from "../transport/space-resolver.js";
import {
  createSpectrumApp,
  resolveSpectrumCloudCredentials,
  spectrumCredentialsFromEnvironment,
  type SpectrumCloudCredentials,
  type SpectrumApp,
} from "../transport/spectrum.js";
import { PhotonCredentialsStore } from "./photon-credentials.js";
import { preparePersistentStorage } from "./persistent-storage.js";
import {
  createDeploymentIdentityController,
  initializeDeploymentIdentityController,
  selectLegacyOwnerPhoneNumber,
  type DeploymentIdentityController,
} from "./deployment-identity.js";

interface QueueComposition {
  operational: OperationalRepository;
  pipeline: DurablePipeline;
  inbound: InboundRepository;
  chains: ChainRepository;
  outbound: OutboundRepository;
  orchestration: OrchestrationRepository;
  failures: FailureRepository;
  retention: RetentionRepository;
  publisher: PgBossPublisher;
  memoryReceipts: PostgresMemoryReceiptStore;
}

export interface ProductionRuntime {
  environment: Environment;
  logger: Logger;
  promptBundleVersion: string;
  bootstrap: AgentServiceBootstrap;
  deploymentIdentity: DeploymentIdentityController;
  photonSetup: PhotonSetupController;
  chatgptSetup?: ChatGptSetupController;
  modelSettings: ModelSettingsController;
}

function required<Value>(value: Value | undefined, stage: string): Value {
  if (value === undefined) {
    throw new Error(`${stage} was called before its required startup stage.`);
  }
  return value;
}

export async function createProductionRuntime(): Promise<ProductionRuntime> {
  // Configuration and protected values
  const environment = loadEnvironment();
  const cipher = createDataCipher(environment.APP_ENCRYPTION_KEY);
  const photonCredentialsStore = new PhotonCredentialsStore({
    directory: resolve(dirname(environment.CODEX_HOME), "photon"),
    encryptionKey: environment.APP_ENCRYPTION_KEY,
  });
  const storedPhotonSetup = await photonCredentialsStore.load();
  const legacySpectrumCredentials =
    spectrumCredentialsFromEnvironment(environment);
  const deploymentIdentity = createDeploymentIdentityController();
  const photonSetup = new PhotonSetupService({
    ownerIdentity: deploymentIdentity,
    credentialsStore: photonCredentialsStore,
    ...(storedPhotonSetup === undefined
      ? {}
      : { storedCredentials: storedPhotonSetup }),
    legacyCredentialsPresent: legacySpectrumCredentials !== undefined,
  });
  let spectrumCredentials: SpectrumCloudCredentials | undefined =
    resolveSpectrumCloudCredentials(storedPhotonSetup, environment);
  const protectedValues: string[] = [
    environment.DATABASE_URL,
    environment.APP_ENCRYPTION_KEY,
    ...(environment.OWNER_PHONE_NUMBER === undefined
      ? []
      : [environment.OWNER_PHONE_NUMBER]),
    ...(environment.OWNER_PHONE_NUMBER_E164_EXAMPLE_PLUS19495550123 ===
    undefined
      ? []
      : [environment.OWNER_PHONE_NUMBER_E164_EXAMPLE_PLUS19495550123]),
    ...environment.AGENT_OWNER_HANDLES,
    ...(environment.SPECTRUM_PROJECT_SECRET === undefined
      ? []
      : [environment.SPECTRUM_PROJECT_SECRET]),
    ...(storedPhotonSetup === undefined
      ? []
      : [
          storedPhotonSetup.photonDeviceBearerToken,
          storedPhotonSetup.photonProjectId,
          storedPhotonSetup.spectrumProjectSecret,
          storedPhotonSetup.ownerPhoneNumber,
          storedPhotonSetup.assignedIMessageNumber,
        ]),
    ...(environment.OPENAI_API_KEY === undefined
      ? []
      : [environment.OPENAI_API_KEY]),
    ...(environment.SUPERMEMORY_API_KEY === undefined
      ? []
      : [environment.SUPERMEMORY_API_KEY]),
  ];
  const logger = createLogger({ protectedValues });
  const protectValue = (value: string): void => {
    if (!protectedValues.includes(value)) {
      protectedValues.push(value);
    }
  };
  const inFlightChains = new InFlightChainRegistry();
  const interruptSupersededChains = (chainIds: readonly string[]): void => {
    const abortedWorkCount = inFlightChains.cancel(chainIds);
    if (abortedWorkCount > 0) {
      logger.info(
        {
          component: "queue",
          supersededChainCount: chainIds.length,
          abortedWorkCount,
        },
        "superseded in-flight work aborted",
      );
    }
  };
  const promptBundle = await loadPromptBundle();
  const codexParentEnvironment = {
    PATH: environment.PATH,
    ...(environment.LANG === undefined ? {} : { LANG: environment.LANG }),
    ...(environment.LANGUAGE === undefined
      ? {}
      : { LANGUAGE: environment.LANGUAGE }),
    ...(environment.LC_ALL === undefined
      ? {}
      : { LC_ALL: environment.LC_ALL }),
    ...(environment.LC_CTYPE === undefined
      ? {}
      : { LC_CTYPE: environment.LC_CTYPE }),
  };
  const chatgptSetup =
    environment.CODEX_AUTH_MODE === "chatgpt"
      ? new CodexAppServerAuth({
          codexHome: environment.CODEX_HOME,
          parentEnvironment: codexParentEnvironment,
        })
      : undefined;

  // Codex runtime construction
  const codex = new CodexClient({
    codexHome: environment.CODEX_HOME,
    authMode: environment.CODEX_AUTH_MODE,
    parentEnvironment: codexParentEnvironment,
    ...(environment.OPENAI_API_KEY === undefined
      ? {}
      : { openAiApiKey: environment.OPENAI_API_KEY }),
    maximumRuntimeMs: environment.MAX_TASK_RUNTIME_MS,
    maximumConcurrency: environment.MAX_EXECUTION_CONCURRENCY,
    maximumConcurrencyPerOwner: environment.MAX_OWNER_EXECUTION_CONCURRENCY,
  });
  const pairRunner = createCodexPairRunner(
    codex,
    environment.AGENT_WORKSPACE_ROOT,
  );

  // Mutable provider lifecycle state
  let databaseClient: DatabaseClient | undefined;
  let operationalRepository: OperationalRepository | undefined;
  let modelSettingsRepository: ModelSettingsRepository | undefined;
  let queue: DurableQueue | undefined;
  let composition: QueueComposition | undefined;
  let spectrumApp: SpectrumApp | undefined;
  let spectrumLoop: Promise<void> | undefined;
  let memoryProvider: SupermemoryPort | undefined;

  const syncCapabilitiesToRepository = async (
    snapshot: ReturnType<NonNullable<typeof chatgptSetup>["capabilities"]>,
  ): Promise<void> => {
    const repository = modelSettingsRepository;
    if (repository === undefined || snapshot.state === "refreshing") {
      return;
    }
    await repository.syncAccountCapabilities({
      planType: snapshot.state === "available" ? snapshot.planType : null,
      models: snapshot.state === "available" ? snapshot.models : [],
      refreshedAt: snapshot.refreshedAt ?? new Date(),
    });
  };
  chatgptSetup?.onCapabilitiesChanged(syncCapabilitiesToRepository);

  const modelSettings: ModelSettingsController = {
    async read() {
      const repository = modelSettingsRepository;
      const capabilities = chatgptSetup?.capabilities();
      if (
        repository === undefined ||
        capabilities === undefined ||
        capabilities.state !== "available"
      ) {
        throw new ModelSettingsApiError("MODEL_SETTINGS_UNAVAILABLE");
      }
      const settings = await repository.read();
      if (
        settings.effective === null ||
        settings.selectionState === "pending" ||
        settings.selectionState === "unavailable"
      ) {
        throw new ModelSettingsApiError("MODEL_SETTINGS_UNAVAILABLE");
      }
      return { ...settings, availableModels: capabilities.models };
    },
    async update(selection: ModelSelection) {
      const repository = modelSettingsRepository;
      if (repository === undefined || chatgptSetup === undefined) {
        throw new ModelSettingsApiError("MODEL_SETTINGS_UNAVAILABLE");
      }
      const capabilities = await chatgptSetup.refreshCapabilities();
      if (capabilities.state !== "available") {
        throw new ModelSettingsApiError("MODEL_SETTINGS_UNAVAILABLE");
      }
      const model = capabilities.models.find(
        (candidate) => candidate.id === selection.modelId,
      );
      if (model === undefined || !modelSupportsSelection(model, selection)) {
        throw new ModelSettingsApiError("MODEL_SELECTION_STALE");
      }
      const probe = await pairRunner.probe({
        model: selection.modelId,
        effort: selection.reasoningEffort,
      });
      if (!probe.supported) {
        throw new ModelSettingsApiError("MODEL_PAIR_UNAVAILABLE");
      }
      try {
        const settings = await repository.updatePreference({
          ...selection,
          currentCatalog: capabilities.models,
        });
        return { ...settings, availableModels: capabilities.models };
      } catch (error) {
        if (error instanceof ModelPreferenceUnavailableError) {
          throw new ModelSettingsApiError("MODEL_SELECTION_STALE");
        }
        throw new ModelSettingsApiError("MODEL_SETTINGS_UNAVAILABLE");
      }
    },
  };

  // Configuration and storage startup
  const bootstrap: AgentServiceBootstrap = {
    async prepareConfiguration() {
      // Parsing the environment and prompt contract above is the configuration
      // stage. Construct the child allowlist here so unsafe inheritance fails
      // before any provider or database connection is opened.
      buildCodexChildEnvironment({
        parentEnvironment: {
          PATH: environment.PATH,
          ...(environment.LANG === undefined ? {} : { LANG: environment.LANG }),
          ...(environment.LANGUAGE === undefined
            ? {}
            : { LANGUAGE: environment.LANGUAGE }),
          ...(environment.LC_ALL === undefined
            ? {}
            : { LC_ALL: environment.LC_ALL }),
          ...(environment.LC_CTYPE === undefined
            ? {}
            : { LC_CTYPE: environment.LC_CTYPE }),
        },
        codexHome: environment.CODEX_HOME,
        authMode: environment.CODEX_AUTH_MODE,
        ...(environment.OPENAI_API_KEY === undefined
          ? {}
          : { openAiApiKey: environment.OPENAI_API_KEY }),
      });
    },

    async prepareStorage() {
      await preparePersistentStorage({
        codexHome: environment.CODEX_HOME,
        workspaceRoot: environment.AGENT_WORKSPACE_ROOT,
        authMode: environment.CODEX_AUTH_MODE,
      });
      const childEnvironment = buildCodexChildEnvironment({
        parentEnvironment: { PATH: environment.PATH },
        codexHome: environment.CODEX_HOME,
        authMode: environment.CODEX_AUTH_MODE,
        ...(environment.OPENAI_API_KEY === undefined
          ? {}
          : { openAiApiKey: environment.OPENAI_API_KEY }),
      });
      await auditStartupSecretBoundaries({
        codexHome: environment.CODEX_HOME,
        workspaceRoot: environment.AGENT_WORKSPACE_ROOT,
        authMode: environment.CODEX_AUTH_MODE,
        childEnvironment,
        protectedValues,
      });
      await chatgptSetup?.initialize();
    },

    // Database and queue startup
    async connectDatabase() {
      databaseClient = createDatabaseClient({
        connectionString: environment.DATABASE_URL,
        maxConnections: Math.max(4, environment.MAX_EXECUTION_CONCURRENCY + 2),
      });
      await databaseClient.checkReady();
    },

    async applyMigrations() {
      await runDatabaseMigrations(
        required(databaseClient, "Database migration"),
      );
    },

    async initializeDeploymentIdentity() {
      const client = required(databaseClient, "Deployment identity startup");
      const operational = new OperationalRepository(client.database, {
        deploymentId: environment.DEPLOYMENT_ID,
        fingerprintKey: environment.APP_ENCRYPTION_KEY,
        encrypt: cipher.encrypt,
        decrypt: cipher.decrypt,
      });
      await operational.ensureDeployment();
      operationalRepository = operational;
      modelSettingsRepository = new ModelSettingsRepository(
        client.database,
        environment.DEPLOYMENT_ID,
      );
      const capabilities = chatgptSetup?.capabilities();
      if (
        capabilities !== undefined &&
        capabilities.state === "available"
      ) {
        await syncCapabilitiesToRepository(capabilities);
      }
      const legacyOwner = selectLegacyOwnerPhoneNumber({
        ...(environment.OWNER_PHONE_NUMBER === undefined
          ? {}
          : { ownerPhoneNumber: environment.OWNER_PHONE_NUMBER }),
        ...(environment.OWNER_PHONE_NUMBER_E164_EXAMPLE_PLUS19495550123 ===
        undefined
          ? {}
          : {
              renderOwnerPhoneNumber:
                environment.OWNER_PHONE_NUMBER_E164_EXAMPLE_PLUS19495550123,
            }),
        ownerHandles: environment.AGENT_OWNER_HANDLES,
      });
      const initialization = await initializeDeploymentIdentityController({
        controller: deploymentIdentity,
        repository: operational,
        legacyOwner,
        protectPhoneNumber: protectValue,
      });
      return {
        status: initialization.status,
        migrationRequired: initialization.migrationRequired,
      };
    },

    async startQueue() {
      const client = required(databaseClient, "Queue startup");
      const operational = required(
        operationalRepository,
        "Queue deployment identity startup",
      );

      queue = new DurableQueue({
        connectionString: environment.DATABASE_URL,
        onError: () => {
          logger.error(
            { component: "queue", errorCode: "QUEUE_RUNTIME_ERROR" },
            "durable queue emitted a runtime error",
          );
        },
      });
      await queue.start();
      const publisher = new PgBossPublisher(queue.boss);
      const inbound = new InboundRepository(client.database);
      const chains = new ChainRepository(client.database);
      const outbound = new OutboundRepository(client.database);
      const orchestration = new OrchestrationRepository(client.database, {
        workspaceRoot: environment.AGENT_WORKSPACE_ROOT,
        interactionWorkingDirectory: environment.AGENT_WORKSPACE_ROOT,
        encrypt: cipher.encrypt,
        decrypt: cipher.decrypt,
        // A new Railway volume has no code-owned execution binding. The
        // interaction model therefore answers directly until an operator adds
        // an explicit workspace capability in a later requirement.
        capabilities: () => [],
      });
      const failures = new FailureRepository(client.database, protectedValues);
      const retention = new RetentionRepository(client.database);
      const pipeline = new DurablePipeline({
        inbound,
        chains,
        outbound,
        orchestration,
        publisher,
        onChainsSuperseded: interruptSupersededChains,
        debounceMs: environment.INBOUND_DEBOUNCE_MS,
        taskRuntimeMs: environment.MAX_TASK_RUNTIME_MS,
      });
      composition = {
        operational,
        pipeline,
        inbound,
        chains,
        outbound,
        orchestration,
        failures,
        retention,
        publisher,
        memoryReceipts: new PostgresMemoryReceiptStore(client.database),
      };
    },

    // Codex capability check
    async checkCodex() {
      const repository = required(
        modelSettingsRepository,
        "Codex model settings check",
      );
      let selection: ModelSelection | null;
      if (environment.CODEX_AUTH_MODE === "chatgpt") {
        const capabilities = await chatgptSetup!.refreshCapabilities();
        await syncCapabilitiesToRepository(capabilities);
        selection = (await repository.read()).effective;
      } else {
        selection = (await repository.read()).preferred;
      }
      const report = await probeCodexCapabilities({
        codexHome: environment.CODEX_HOME,
        authMode: environment.CODEX_AUTH_MODE,
        ...(environment.OPENAI_API_KEY === undefined
          ? {}
          : { openAiApiKey: environment.OPENAI_API_KEY }),
        selection,
        runner: pairRunner,
      });
      if (
        environment.CODEX_AUTH_MODE === "api_key" &&
        report.ready &&
        selection !== null
      ) {
        await repository.activateProbedPreference(selection);
      }
      const auth = report.components.auth;
      return {
        auth:
          auth === "ok" ? "ok" : auth === "missing" ? "missing" : "failed",
        capabilities:
          auth !== "ok" ? "unknown" : report.ready ? "ok" : "failed",
        ...(auth === "missing"
          ? { authCode: "CODEX_AUTH_MISSING" as const }
          : auth === "failed"
            ? { authCode: "CODEX_AUTH_EXPIRED" as const }
            : {}),
        ...(auth === "ok" && !report.ready
          ? { capabilityCode: "CODEX_CAPABILITY_FAILED" as const }
          : {}),
      };
    },

    // Optional memory setup
    async configureSupermemory() {
      if (environment.SUPERMEMORY_API_KEY === undefined) {
        memoryProvider = undefined;
        return "disabled";
      }
      memoryProvider = new SupermemoryClient({
        apiKey: environment.SUPERMEMORY_API_KEY,
      });
      return "ok";
    },

    // Spectrum and worker composition
    async startSpectrum({ signal, readiness }) {
      const credentials = required(
        spectrumCredentials,
        "Spectrum credential setup",
      );
      const state = required(composition, "Spectrum startup");
      const durableQueue = required(queue, "Spectrum worker startup");
      const client = required(databaseClient, "Spectrum startup");
      spectrumApp = await createSpectrumApp(credentials);
      const resolver = createSpectrumSpaceResolver(spectrumApp);
      const outboundTransport = new NativeSpectrumOutboundTransport({
        operational: state.operational,
        resolver: resolver as unknown as import("../transport/space-resolver.js").SpaceResolver<Space>,
      });
      const threadStore = new ThreadStore(
        new PostgresCodexThreadRepository(client.database, {
          encrypt: cipher.encrypt,
          decrypt: cipher.decrypt,
        }),
        codex,
      );
      const interaction = new InteractionRuntime(threadStore);
      const execution = new ExecutionRuntime(threadStore);
      const commands = new CommandRepository(client.database, {
        decrypt: cipher.decrypt,
        readiness: () => ({
          messaging: "ready",
          signIn: "ready",
          work: "ready",
          memory:
            environment.SUPERMEMORY_API_KEY === undefined
              ? "disabled"
              : "ready",
        }),
      });

      const combinedWorkerSignal = (jobSignal: AbortSignal): AbortSignal =>
        AbortSignal.any([signal, jobSignal]);
      await durableQueue.registerWorker(
        QUEUE_NAMES.inboundFlush,
        createInboundFlushHandler({
          chains: state.chains,
          publisher: state.publisher,
          onChainsSuperseded: interruptSupersededChains,
        }),
      );
      const turnPlanHandler = createTurnPlanHandler({
        repository: state.orchestration,
        interaction,
        publisher: state.publisher,
        commandHandlers: commands,
        promptBundle,
        encrypt: cipher.encrypt,
        recallMemory: async (context, recallSignal) => {
          if (memoryProvider === undefined) {
            return {
              available: false,
              ownerProfile: [],
              recalledMemories: [],
            };
          }
          const recalled = await recallMemoryContext({
            provider: memoryProvider,
            receipts: state.memoryReceipts,
            deploymentId: context.deploymentId,
            ownerId: context.ownerId,
            spaceId: context.spaceId,
            query: context.combinedTurnText,
            signal: recallSignal,
          });
          return {
            available: recalled.available,
            ownerProfile: recalled.ownerProfile.map((item) => item.text),
            recalledMemories: recalled.relevantMemories.map(
              (item) => item.text,
            ),
          };
        },
        sendStatus: async ({
          spaceId,
          message,
          clientGuid,
          signal: statusSignal,
        }) => {
          await outboundTransport.send({
            spaceId,
            clientGuid,
            text: message,
            signal: statusSignal,
          });
        },
        onStatusFailure: () => {
          logger.warn(
            { component: "outbound", errorCode: "STATUS_SEND_FAILED" },
            "optional progress status could not be delivered",
          );
        },
      });
      await durableQueue.registerWorker(
        QUEUE_NAMES.turnPlan,
        async (payload, jobSignal) =>
          await inFlightChains.run(
            payload.chainId,
            combinedWorkerSignal(jobSignal),
            async (chainSignal) =>
              await turnPlanHandler(payload, chainSignal),
          ),
      );
      const taskExecuteHandler = createTaskExecuteHandler({
        repository: state.orchestration,
        execution,
        publisher: state.publisher,
        promptBundle,
        maximumRuntimeMs: environment.MAX_TASK_RUNTIME_MS,
      });
      await durableQueue.registerWorker(
        QUEUE_NAMES.taskExecute,
        async (payload, jobSignal) =>
          await inFlightChains.run(
            payload.chainId,
            combinedWorkerSignal(jobSignal),
            async (chainSignal) =>
              await taskExecuteHandler(payload, chainSignal),
          ),
        environment.MAX_EXECUTION_CONCURRENCY,
      );
      const turnSynthesizeHandler = createTurnSynthesizeHandler({
        repository: state.orchestration,
        interaction,
        publisher: state.publisher,
        promptBundle,
        encrypt: cipher.encrypt,
      });
      await durableQueue.registerWorker(
        QUEUE_NAMES.turnSynthesize,
        async (payload, jobSignal) =>
          await inFlightChains.run(
            payload.chainId,
            combinedWorkerSignal(jobSignal),
            async (chainSignal) =>
              await turnSynthesizeHandler(payload, chainSignal),
          ),
      );
      const outboundSendHandler = createOutboundSendHandler({
        outbound: state.outbound,
        failures: state.failures,
        transport: outboundTransport,
        decrypt: cipher.decrypt,
        failureRetentionDays: environment.FAILURE_RETENTION_DAYS,
      });
      await durableQueue.registerWorker(
        QUEUE_NAMES.outboundSend,
        async (payload, jobSignal) => {
          const chainId = await state.outbound.findChainIdForBatch(
            payload.outboundBatchId,
          );
          if (chainId === undefined) {
            await outboundSendHandler(
              payload,
              combinedWorkerSignal(jobSignal),
            );
            return;
          }
          await inFlightChains.run(
            chainId,
            combinedWorkerSignal(jobSignal),
            async (chainSignal) =>
              await outboundSendHandler(payload, chainSignal),
          );
        },
      );
      await durableQueue.registerWorker(
        QUEUE_NAMES.maintenanceRetention,
        createRetentionHandler({
          retention: state.retention,
          rawMessageRetentionDays: environment.RAW_MESSAGE_RETENTION_DAYS,
          failureRetentionDays: environment.FAILURE_RETENTION_DAYS,
        }),
      );

      // Re-publish durable work before accepting another provider event.
      await state.pipeline.reconcile();
      const directory = new DatabaseAuthorizationDirectory(client.database);
      const authorizer = new DeterministicSenderAuthorizer({
        deploymentId: environment.DEPLOYMENT_ID,
        fingerprintKey: environment.APP_ENCRYPTION_KEY,
        directory,
        groupPolicy: {
          mode: environment.GROUP_MODE,
          agentHandles: [],
          agentMentionNames: ["agent"],
        },
        replyVerifier: new DatabaseGroupReplyVerifier(
          client.database,
          state.operational,
          environment.DEPLOYMENT_ID,
        ),
        rateLimits: new OperationalRateLimits({
          messagesPerOwner: {
            limit: environment.MESSAGE_RATE_LIMIT_PER_MINUTE,
            windowMs: 60_000,
          },
          tasksPerOwner: {
            limit: environment.TASK_RATE_LIMIT_PER_HOUR,
            windowMs: 60 * 60 * 1_000,
          },
        }),
      });
      const consumer = new DurableInboundConsumer({
        operational: state.operational,
        pipeline: state.pipeline,
        cipher,
        contentHashKey: environment.APP_ENCRYPTION_KEY,
        rawMessageRetentionDays: environment.RAW_MESSAGE_RETENTION_DAYS,
      });
      const boundary = new SecureAuthorizeAndIngest(authorizer, consumer);
      spectrumLoop = runSpectrumMessageLoop({
        authorizeAndIngest: boundary,
        messages: () => spectrumApp!.messages,
        readiness,
        signal,
        onIgnored: (reason) => {
          logger.debug({ component: "spectrum", reason }, "ignored message event");
        },
      });
      void spectrumLoop.catch(() => {
        logger.error(
          {
            component: "spectrum",
            errorCode: "SPECTRUM_STREAM_RESTART_EXHAUSTED",
          },
          "Spectrum receive loop stopped after bounded restart attempts",
        );
      });
    },

    // Shutdown adapters
    async stopSpectrum() {
      await spectrumLoop?.catch(() => undefined);
      spectrumLoop = undefined;
      spectrumApp = undefined;
    },

    async stopCodex() {
      await chatgptSetup?.close();
    },

    async stopQueue() {
      await queue?.stop();
      queue = undefined;
    },

    async closeDatabase() {
      await databaseClient?.close();
      databaseClient = undefined;
    },
  };

  photonSetup.onConnected((credentials) => {
    spectrumCredentials = {
      projectId: credentials.photonProjectId,
      projectSecret: credentials.spectrumProjectSecret,
    };
  });

  return {
    environment,
    logger,
    promptBundleVersion: promptBundle.version,
    bootstrap,
    deploymentIdentity,
    photonSetup,
    modelSettings,
    ...(chatgptSetup === undefined ? {} : { chatgptSetup }),
  };
}
