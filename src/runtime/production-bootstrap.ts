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
import {
  ExecutionCapabilityError,
  ExecutionCapabilityService,
} from "../agent/execution-capability-service.js";
import { InteractionRuntime } from "../agent/interaction-runtime.js";
import {
  ApiKeyModelCapabilitySource,
  ChatGptModelCapabilitySource,
} from "../agent/model-capability-source.js";
import { ModelSettingsService } from "../agent/model-settings-service.js";
import { ThreadStore } from "../agent/thread-store.js";
import { createCodexPairRunner } from "../config/capabilities.js";
import {
  loadEnvironment,
  type Environment,
} from "../config/env.js";
import { loadPromptBundle } from "../config/prompt-bundle.js";
import { createDatabaseClient, type DatabaseClient } from "../db/client.js";
import { runDatabaseMigrations } from "../db/migrate.js";
import { ChainRepository } from "../db/repositories/chains.js";
import { ChainAuthorizationRepository } from "../db/repositories/chain-authorization.js";
import { CommandRepository } from "../db/repositories/commands.js";
import { PostgresCodexThreadRepository } from "../db/repositories/codex-threads.js";
import { FailureRepository } from "../db/repositories/failures.js";
import { PostgresExecutionCapabilityRepository } from "../db/repositories/execution-capabilities.js";
import { ApprovalRepository } from "../db/repositories/approvals.js";
import { ActionExecutionRepository } from "../db/repositories/action-executions.js";
import { MemoryCurationRepository } from "../db/repositories/memory-curation.js";
import { PostgresPhotonInstallationRepository } from "../db/repositories/photon-installations.js";
import { InboundRepository } from "../db/repositories/inbound.js";
import { PostgresMemoryReceiptStore } from "../db/repositories/memory-receipts.js";
import {
  ModelSettingsRepository,
} from "../db/repositories/model-settings.js";
import { OperationalRepository } from "../db/repositories/operational.js";
import { OrchestrationRepository } from "../db/repositories/orchestration.js";
import { OutboundRepository } from "../db/repositories/outbound.js";
import { RetentionRepository } from "../db/repositories/retention.js";
import type { AgentServiceBootstrap } from "../index.js";
import type { ModelSettingsController } from "../http/server.js";
import { ModelSettingsHttpController } from "../http/model-settings-controller.js";
import { SpectrumReadiness } from "../http/readiness.js";
import { recallMemoryContext } from "../memory/recall.js";
import {
  SupermemoryClient,
  type SupermemoryPort,
} from "../memory/supermemory-client.js";
import { createLogger } from "../observability/logger.js";
import { DurableQueue } from "../queue/boss.js";
import { createInboundFlushHandler } from "../queue/handlers/inbound-flush.js";
import { createOutboundSendHandler } from "../queue/handlers/outbound-send.js";
import { createApprovalRequestHandler } from "../queue/handlers/approval-request.js";
import { createApprovalExecuteHandler } from "../queue/handlers/approval-execute.js";
import { createMemoryCurateHandler } from "../queue/handlers/memory-curate.js";
import { createRetentionHandler } from "../queue/handlers/retention.js";
import { createTaskExecuteHandler } from "../queue/handlers/task-execute.js";
import { createTurnPlanHandler } from "../queue/handlers/turn-plan.js";
import { createTurnSynthesizeHandler } from "../queue/handlers/turn-synthesize.js";
import { InFlightChainRegistry } from "../queue/in-flight-chain-registry.js";
import { QUEUE_NAMES } from "../queue/names.js";
import { DurablePipeline } from "../queue/pipeline.js";
import { PgBossPublisher } from "../queue/publisher.js";
import { PgBossMemoryQueuePublisher } from "../queue/extensions/memory-queues.js";
import {
  DatabaseAuthorizationDirectory,
  DatabaseGroupReplyVerifier,
  DeterministicSenderAuthorizer,
  SecureAuthorizeAndIngest,
} from "../security/authorize-sender.js";
import {
  ApprovalService,
  createApprovalPayloadCipher,
  type ApprovalChainProgression,
} from "../security/approvals.js";
import {
  CodexStartDeniedError,
  QueuedCodexStartGate,
} from "../security/queued-authorization.js";
import { SecureStructuredCodexRunner } from "../security/secure-codex-runner.js";
import { createDataCipher } from "../security/data-cipher.js";
import { OperationalRateLimits } from "../security/rate-limits.js";
import {
  AuthorizedCommandHandler,
  AuthorizedInboundCommandInterceptor,
} from "../commands/handlers.js";
import { ActionExecutorRegistry } from "../actions/action-executor-registry.js";
import { auditStartupSecretBoundaries } from "../security/secret-boundaries.js";
import { runSpectrumMessageLoop } from "../transport/message-loop.js";
import {
  PhotonInstallationHttpProvider,
  type PhotonSetupController,
} from "../transport/photon-setup.js";
import { PhotonInstallationService } from "../transport/photon-installation-service.js";
import { DurablePhotonSetupController } from "../transport/durable-photon-setup.js";
import {
  DurableInboundConsumer,
  NativeSpectrumOutboundTransport,
} from "../transport/operational.js";
import {
  ConversationPresenceCoordinator,
  DEFAULT_TYPING_RUNTIME_BUFFER_MS,
} from "../transport/conversation-presence.js";
import { createSpectrumSpaceResolver } from "../transport/space-resolver.js";
import {
  createSpectrumApp,
  resolveSpectrumCloudCredentials,
  spectrumCredentialsFromEnvironment,
  type SpectrumCloudCredentials,
  type SpectrumApp,
} from "../transport/spectrum.js";
import { PhotonCredentialsStore } from "./photon-credentials.js";
import { createOwnerBindingRevisionPort } from "./owner-binding-revision.js";
import { RestartableOutboundTransport } from "./restartable-outbound-transport.js";
import type { SpectrumRunHandle } from "./spectrum-run-handle.js";
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
  authorizationReferences: ChainAuthorizationRepository;
  memoryCuration: MemoryCurationRepository;
  memoryPublisher: PgBossMemoryQueuePublisher;
  approvals: ApprovalRepository;
  actionExecutions: ActionExecutionRepository;
  authorizationDirectory: DatabaseAuthorizationDirectory;
  rateLimits: OperationalRateLimits;
  approvalCommands: AuthorizedCommandHandler;
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
  const photonSetup = new DurablePhotonSetupController();
  let spectrumCredentials: SpectrumCloudCredentials | undefined;
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
  let activeConversationPresence: ConversationPresenceCoordinator | undefined;
  const endChainPresence = (chainId: string): void => {
    void activeConversationPresence?.endChain(chainId);
  };
  const interruptSupersededChains = (chainIds: readonly string[]): void => {
    void activeConversationPresence?.endChains(chainIds);
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
  const runChainWithPresence = async (
    chainId: string,
    signal: AbortSignal,
    operation: (chainSignal: AbortSignal) => Promise<void>,
  ): Promise<void> => {
    try {
      await inFlightChains.run(chainId, signal, operation);
    } catch (error) {
      endChainPresence(chainId);
      throw error;
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
  let modelSettingsService: ModelSettingsService | undefined;
  let photonInstallationService: PhotonInstallationService | undefined;
  let queue: DurableQueue | undefined;
  let composition: QueueComposition | undefined;
  const outboundTransport = new RestartableOutboundTransport();
  const activeSpectrumRuns = new Map<
    string,
    { controller: AbortController; done: Promise<{ reason: "exited" | "restart_exhausted" }> }
  >();
  let nextSpectrumRun = 0;
  let memoryProvider: SupermemoryPort | undefined;
  const codexActivationListeners = new Set<
    (snapshot: {
      auth: "ready" | "missing" | "failed";
      capabilities: "available" | "unavailable";
    }) => void | Promise<void>
  >();
  const photonActivationListeners = new Set<
    (snapshot: {
      connected: boolean;
      ownerRevisionCurrent: boolean;
    }) => void | Promise<void>
  >();
  const modelSettings: ModelSettingsController = new ModelSettingsHttpController({
    readDashboard: async () =>
      await required(modelSettingsService, "Model settings read").readDashboard(),
    updatePreference: async (selection) =>
      await required(modelSettingsService, "Model settings update").updatePreference(
        selection,
      ),
  });

  // Configuration and storage startup
  const bootstrap: AgentServiceBootstrap = {
    onCodexActivationChanged(listener) {
      codexActivationListeners.add(listener);
      return () => codexActivationListeners.delete(listener);
    },

    onPhotonActivationChanged(listener) {
      photonActivationListeners.add(listener);
      return () => photonActivationListeners.delete(listener);
    },

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
      const modelSource =
        environment.CODEX_AUTH_MODE === "chatgpt"
          ? new ChatGptModelCapabilitySource(chatgptSetup!)
          : new ApiKeyModelCapabilitySource({
              selection: (await modelSettingsRepository.read()).preferred,
          });
      modelSettingsService = new ModelSettingsService({
        source: modelSource,
        store: modelSettingsRepository,
        probe: pairRunner,
        readiness: {
          publish(snapshot) {
            const activationSnapshot = {
              auth:
                environment.CODEX_AUTH_MODE === "api_key" ||
                chatgptSetup?.status().state === "connected"
                  ? ("ready" as const)
                  : chatgptSetup?.status().state === "failed"
                    ? ("failed" as const)
                    : ("missing" as const),
              capabilities: snapshot.ready
                ? ("available" as const)
                : ("unavailable" as const),
            };
            for (const listener of codexActivationListeners) {
              void Promise.resolve(listener(activationSnapshot)).catch(
                () => undefined,
              );
            }
          },
        },
      });
      await modelSettingsService.start();

      const photonRepository = new PostgresPhotonInstallationRepository(
        client.pool,
      );
      const ownerBinding = createOwnerBindingRevisionPort({
        deploymentId: environment.DEPLOYMENT_ID,
        ownerIdentity: deploymentIdentity,
        revisionStore: photonRepository,
      });
      photonInstallationService = new PhotonInstallationService({
        installationId: environment.DEPLOYMENT_ID,
        deploymentId: environment.DEPLOYMENT_ID,
        repository: photonRepository,
        ownerBinding,
        provider: new PhotonInstallationHttpProvider(),
        cipher,
      });
      photonSetup.bind({
        service: photonInstallationService,
        repository: photonRepository,
        ownerBinding,
        cipher,
      });
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
      const existingInstallation = await photonRepository.load(
        environment.DEPLOYMENT_ID,
      );
      if (existingInstallation !== undefined) {
        void photonSetup.resume().catch(() => undefined);
      } else if (storedPhotonSetup !== undefined) {
        void photonSetup
          .importLegacyCredentials(storedPhotonSetup)
          .catch(() => undefined);
      } else if (legacySpectrumCredentials !== undefined) {
        logger.warn(
          { component: "photon", errorCode: "PHOTON_LEGACY_IMPORT_INCOMPLETE" },
          "legacy Spectrum-only credentials cannot bypass the durable current-owner installation contract",
        );
      }
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
      const authorizationReferences = new ChainAuthorizationRepository(
        client.database,
      );
      const chains = new ChainRepository(
        client.database,
        authorizationReferences,
      );
      const outbound = new OutboundRepository(client.database);
      const authorizationDirectory = new DatabaseAuthorizationDirectory(
        client.database,
      );
      const rateLimits = new OperationalRateLimits({
        messagesPerOwner: {
          limit: environment.MESSAGE_RATE_LIMIT_PER_MINUTE,
          windowMs: 60_000,
        },
        tasksPerOwner: {
          limit: environment.TASK_RATE_LIMIT_PER_HOUR,
          windowMs: 60 * 60 * 1_000,
        },
      });
      const executionCapabilityRepository =
        new PostgresExecutionCapabilityRepository(client.database);
      await executionCapabilityRepository.seedPersonalWorkspaceBinding(
        environment.DEPLOYMENT_ID,
      );
      const executionCapabilities = new ExecutionCapabilityService({
        repository: executionCapabilityRepository,
        workspaceRoot: environment.AGENT_WORKSPACE_ROOT,
        codexHome: environment.CODEX_HOME,
      });
      const actorFor = async (reference: {
        deploymentId: string;
        ownerId: string;
        principalIdentityId: string;
      }) => {
        const principal = await authorizationDirectory.findById(
          reference.deploymentId,
          reference.principalIdentityId,
        );
        if (principal === undefined || principal.ownerId !== reference.ownerId) {
          throw new CodexStartDeniedError(
            "CODEX_START_AUTHORIZATION_INVALID",
          );
        }
        if (principal.revokedAt !== null) {
          throw new CodexStartDeniedError("CODEX_START_IDENTITY_REVOKED");
        }
        if (principal.ownerStatus !== "active") {
          throw new CodexStartDeniedError("CODEX_START_OWNER_DISABLED");
        }
        if (principal.deploymentStatus !== "active") {
          throw new CodexStartDeniedError(
            "CODEX_START_DEPLOYMENT_UNAVAILABLE",
          );
        }
        return {
          deploymentId: reference.deploymentId,
          ownerId: reference.ownerId,
          senderRole: principal.role,
        };
      };
      const memoryCuration = new MemoryCurationRepository(client.database, {
        encrypt: cipher.encrypt,
        decrypt: cipher.decrypt,
      });
      const orchestration = new OrchestrationRepository(client.database, {
        workspaceRoot: environment.AGENT_WORKSPACE_ROOT,
        interactionWorkingDirectory: environment.AGENT_WORKSPACE_ROOT,
        encrypt: cipher.encrypt,
        decrypt: cipher.decrypt,
        authorizationReferences,
        memoryCuration,
        capabilities: async (identity) => {
          const reference =
            identity.chainId === undefined
              ? undefined
              : await authorizationReferences.load(identity.chainId);
          if (reference === undefined) return [];
          const available = await executionCapabilities.listAvailableCapabilities(
            await actorFor(reference),
          );
          return available.map((capability) => ({
            workspaceBinding: capability.workspaceBinding,
            permissionProfiles: capability.allowedPermissionProfiles,
          }));
        },
        authorizeCapability: async (input) => {
          try {
            const authorized =
              await executionCapabilities.authorizeExecutionCapability(
                await actorFor(input.authorizationReference),
                {
                  workspaceBinding: input.workspaceBinding,
                  permissionProfile: input.permissionProfile,
                },
              );
            return {
              resolvedWorkspacePath: authorized.resolvedWorkspacePath,
              allowedPermissionProfiles: authorized.allowedPermissionProfiles,
            };
          } catch (error) {
            if (error instanceof ExecutionCapabilityError) {
              throw new CodexStartDeniedError(
                "CODEX_START_AUTHORIZATION_INVALID",
              );
            }
            throw error;
          }
        },
      });
      const failures = new FailureRepository(client.database, protectedValues);
      const retention = new RetentionRepository(client.database);
      const memoryPublisher = new PgBossMemoryQueuePublisher(queue.boss);
      const approvalCipher = createApprovalPayloadCipher(
        environment.APP_ENCRYPTION_KEY,
      );
      const approvals = new ApprovalRepository(client.database, {
        encryptExecutionResult: cipher.encrypt,
      });
      const approvalService = new ApprovalService(approvals, approvalCipher);
      const actionExecutions = new ActionExecutionRepository(client.database, {
        encryptExecutionResult: cipher.encrypt,
      });
      const executors = new ActionExecutorRegistry();
      const publishApprovalProgression = async (
        progression: ApprovalChainProgression | null,
      ): Promise<void> => {
        if (progression === null) return;
        await Promise.all(
          progression.newlyRunnableTasks.map((task) =>
            publisher.enqueueTaskExecute(task),
          ),
        );
        if (progression.shouldSynthesize) {
          await publisher.enqueueTurnSynthesize({
            chainId: progression.chainId,
            expectedChainVersion: progression.expectedChainVersion,
            expectedState: "executing",
          });
        }
      };
      const expireApprovals = async (): Promise<void> => {
        for (const scope of await approvals.findExpiredApprovalScopes()) {
          const outcome = await approvalService.expireWithProgression(
            scope.ownerId,
            scope.spaceId,
          );
          for (const progression of outcome.progressions) {
            await publishApprovalProgression(progression);
          }
        }
      };
      const reconcileApprovalJobs = async (
        includeRequestJobs: boolean,
      ): Promise<void> => {
        await expireApprovals();
        if (includeRequestJobs) {
          for (const taskId of await approvals.findApprovalRequestTaskIds()) {
            await publisher.enqueueApprovalRequest({ executionTaskId: taskId });
          }
        }
        for (const recovery of await approvals.findApprovedActionRecoveries()) {
          const consumed = await approvalService.consume(
            recovery.approvalId,
            recovery.ownerId,
            recovery.spaceId,
            recovery.executionTaskId,
          );
          if (consumed !== undefined) {
            await publisher.enqueueApprovalExecute({
              actionExecutionId: consumed.actionExecutionId,
            });
          }
        }
        const staleActions = await actionExecutions.requeueStaleRunning(
          new Date(Date.now() - environment.MAX_TASK_RUNTIME_MS),
        );
        const actionIds = new Set([
          ...(await actionExecutions.findPendingActionExecutionIds()),
          ...staleActions,
        ]);
        for (const actionExecutionId of actionIds) {
          await publisher.enqueueApprovalExecute({ actionExecutionId });
        }
      };
      const approvalCommands = new AuthorizedCommandHandler({
        approvals: {
          listPending: (actor, spaceId) =>
            approvalService.listPending(actor, spaceId),
          respond: async (actor, spaceId, approvalId, status) => {
            const outcome = await approvalService.respondWithProgression(
              actor,
              spaceId,
              approvalId,
              status,
            );
            await publishApprovalProgression(outcome.progression);
            if (outcome.changed && status === "approved") {
              const consumed = await approvalService.consume(
                approvalId,
                actor.ownerId,
                spaceId,
              );
              if (consumed !== undefined) {
                await publisher.enqueueApprovalExecute({
                  actionExecutionId: consumed.actionExecutionId,
                });
              }
            }
            return outcome.changed;
          },
        },
      });
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
        authorizationReferences,
        memoryCuration,
        memoryPublisher,
        approvals,
        actionExecutions,
        authorizationDirectory,
        rateLimits,
        approvalCommands,
      };

      const state = composition;
      const startGate = new QueuedCodexStartGate(
        authorizationDirectory,
        rateLimits,
      );
      const threadStore = new ThreadStore(
        new PostgresCodexThreadRepository(client.database, {
          encrypt: cipher.encrypt,
          decrypt: cipher.decrypt,
        }),
        codex,
        (chainId) =>
          new SecureStructuredCodexRunner({
            chainId,
            authorizationReferences,
            startGate,
            delegate: codex,
          }),
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

      await queue.registerWorker(
        QUEUE_NAMES.inboundFlush,
        createInboundFlushHandler({
          chains,
          publisher,
          onChainsSuperseded: interruptSupersededChains,
          onChainCreated: (chainId, spaceId) => {
            activeConversationPresence?.bindChain(chainId, spaceId);
          },
        }),
      );
      const turnPlanHandler = createTurnPlanHandler({
        repository: orchestration,
        interaction,
        publisher,
        memoryPublisher: publisher,
        reconcileMemory: async () => {
          await memoryPublisher.reconcile(memoryCuration, {
            providerEnabled: memoryProvider !== undefined,
          });
        },
        commandHandlers: commands,
        promptBundle,
        encrypt: cipher.encrypt,
        recallMemory: async (context, signal) => {
          if (memoryProvider === undefined) {
            return { available: false, ownerProfile: [], recalledMemories: [] };
          }
          const recalled = await recallMemoryContext({
            provider: memoryProvider,
            receipts: state.memoryReceipts,
            deploymentId: context.deploymentId,
            ownerId: context.ownerId,
            spaceId: context.spaceId,
            query: context.combinedTurnText,
            signal,
          });
          return {
            available: recalled.available,
            ownerProfile: recalled.ownerProfile.map((item) => item.text),
            recalledMemories: recalled.relevantMemories.map((item) => item.text),
          };
        },
        sendStatus: async ({ spaceId, message, clientGuid, signal }) => {
          await outboundTransport.send({ spaceId, clientGuid, text: message, signal });
        },
        onStatusFailure: () => {
          logger.warn(
            { component: "outbound", errorCode: "STATUS_SEND_FAILED" },
            "optional progress status could not be delivered",
          );
        },
        onPresenceEnd: endChainPresence,
      });
      await queue.registerWorker(
        QUEUE_NAMES.turnPlan,
        async (payload, signal) =>
          runChainWithPresence(payload.chainId, signal, (chainSignal) =>
            turnPlanHandler(payload, chainSignal),
          ),
      );
      const taskExecuteHandler = createTaskExecuteHandler({
        repository: orchestration,
        execution,
        publisher,
        approvalPublisher: publisher,
        promptBundle,
        maximumRuntimeMs: environment.MAX_TASK_RUNTIME_MS,
        onPresenceEnd: endChainPresence,
      });
      await queue.registerWorker(
        QUEUE_NAMES.taskExecute,
        async (payload, signal) =>
          runChainWithPresence(payload.chainId, signal, (chainSignal) =>
            taskExecuteHandler(payload, chainSignal),
          ),
        environment.MAX_EXECUTION_CONCURRENCY,
      );
      const synthesizeHandler = createTurnSynthesizeHandler({
        repository: orchestration,
        interaction,
        publisher,
        promptBundle,
        encrypt: cipher.encrypt,
        onPresenceEnd: endChainPresence,
      });
      await queue.registerWorker(
        QUEUE_NAMES.turnSynthesize,
        async (payload, signal) =>
          runChainWithPresence(payload.chainId, signal, (chainSignal) =>
            synthesizeHandler(payload, chainSignal),
          ),
      );
      const outboundHandler = createOutboundSendHandler({
        outbound,
        failures,
        transport: outboundTransport,
        decrypt: cipher.decrypt,
        failureRetentionDays: environment.FAILURE_RETENTION_DAYS,
        afterBatchComplete: async () => {
          await memoryPublisher.reconcile(memoryCuration, {
            providerEnabled: memoryProvider !== undefined,
          });
        },
      });
      await queue.registerWorker(
        QUEUE_NAMES.outboundSend,
        async (payload, signal) => {
          const chainId = await outbound.findChainIdForBatch(
            payload.outboundBatchId,
          );
          if (chainId === undefined)
            return await outboundHandler(payload, signal);
          await runChainWithPresence(chainId, signal, (chainSignal) =>
            outboundHandler(payload, chainSignal),
          );
        },
      );
      await queue.registerWorker(
        QUEUE_NAMES.approvalRequest,
        async (payload) => {
          await createApprovalRequestHandler({
          repository: approvals,
          approvals: approvalService,
          executors,
          decryptExecutionResult: cipher.decrypt,
          publisher: {
            publishApprovalRequest: async (message) => {
              await outboundTransport.send({
                spaceId: message.spaceId,
                clientGuid: `approval-${message.idempotencyKey}`,
                text: message.body,
                signal: new AbortController().signal,
              });
            },
          },
          })(payload);
        },
      );
      await queue.registerWorker(
        QUEUE_NAMES.approvalExecute,
        createApprovalExecuteHandler({
          repository: actionExecutions,
          executors,
          cipher: approvalCipher,
          publisher: {
            enqueueNewlyRunnableTask: (task) => publisher.enqueueTaskExecute(task),
            enqueueApprovalSynthesis: (input) =>
              publisher.enqueueTurnSynthesize(input),
          },
        }),
      );
      await queue.registerWorker(
        QUEUE_NAMES.memoryCurate,
        async (payload, signal) =>
          createMemoryCurateHandler({
            repository: memoryCuration,
            receipts: state.memoryReceipts,
            ...(memoryProvider === undefined ? {} : { provider: memoryProvider }),
          })(payload, signal),
      );
      await queue.registerWorker(
        QUEUE_NAMES.maintenanceRetention,
        createRetentionHandler({
          retention,
          rawMessageRetentionDays: environment.RAW_MESSAGE_RETENTION_DAYS,
          failureRetentionDays: environment.FAILURE_RETENTION_DAYS,
        }),
      );
      await queue.registerWorker(
        QUEUE_NAMES.maintenanceHealth,
        async () => reconcileApprovalJobs(false),
      );

      await pipeline.reconcile();
      await memoryPublisher.reconcile(memoryCuration, {
        providerEnabled: memoryProvider !== undefined,
      });
      await reconcileApprovalJobs(true);
    },

    // Codex capability check
    async checkCodex() {
      const service = required(modelSettingsService, "Codex model settings check");
      let modelReady = false;
      try {
        modelReady = (await service.refresh()).ready;
      } catch {
        modelReady = false;
      }
      const auth =
        environment.CODEX_AUTH_MODE === "api_key" ||
        chatgptSetup?.status().state === "connected"
          ? "ok"
          : chatgptSetup?.status().state === "failed"
            ? "failed"
            : "missing";
      return {
        auth:
          auth === "ok" ? "ok" : auth === "missing" ? "missing" : "failed",
        capabilities:
          auth !== "ok" ? "unknown" : modelReady ? "ok" : "failed",
        ...(auth === "missing"
          ? { authCode: "CODEX_AUTH_MISSING" as const }
          : auth === "failed"
            ? { authCode: "CODEX_AUTH_EXPIRED" as const }
            : {}),
        ...(auth === "ok" && !modelReady
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
      if (composition !== undefined) {
        await composition.memoryPublisher.reconcile(
          composition.memoryCuration,
          { providerEnabled: true },
        );
      }
      return "ok";
    },

    // Restartable Spectrum intake; durable workers were composed once above.
    async startSpectrumRun(): Promise<SpectrumRunHandle> {
      const currentCredentials = photonSetup.credentials();
      if (
        photonSetup.status().state !== "connected" ||
        currentCredentials === undefined
      ) {
        throw new Error(
          "Spectrum cannot start until Photon is connected for the current owner revision.",
        );
      }
      spectrumCredentials = {
        projectId: currentCredentials.photonProjectId,
        projectSecret: currentCredentials.spectrumProjectSecret,
      };
      const credentials = required(
        spectrumCredentials,
        "Spectrum credential setup",
      );
      const state = required(composition, "Spectrum startup");
      const app = await createSpectrumApp(credentials);
      const resolver = createSpectrumSpaceResolver(app);
      const conversationPresence = new ConversationPresenceCoordinator({
        operational: state.operational,
        resolver:
          resolver as unknown as import("../transport/space-resolver.js").SpaceResolver<Space>,
        maximumTypingDurationMs:
          environment.MAX_TASK_RUNTIME_MS + DEFAULT_TYPING_RUNTIME_BUFFER_MS,
      });
      const nativeOutbound = new NativeSpectrumOutboundTransport({
        operational: state.operational,
        resolver:
          resolver as unknown as import("../transport/space-resolver.js").SpaceResolver<Space>,
        conversationPresence,
      });
      const runId = `spectrum-${++nextSpectrumRun}`;
      const controller = new AbortController();
      outboundTransport.attach(runId, nativeOutbound);
      activeConversationPresence = conversationPresence;

      const authorizer = new DeterministicSenderAuthorizer({
        deploymentId: environment.DEPLOYMENT_ID,
        fingerprintKey: environment.APP_ENCRYPTION_KEY,
        directory: state.authorizationDirectory,
        groupPolicy: {
          mode: environment.GROUP_MODE,
          agentHandles: [],
          agentMentionNames: ["agent"],
        },
        replyVerifier: new DatabaseGroupReplyVerifier(
          required(databaseClient, "Spectrum startup").database,
          state.operational,
          environment.DEPLOYMENT_ID,
        ),
        rateLimits: state.rateLimits,
      });
      const consumer = new DurableInboundConsumer({
        operational: state.operational,
        pipeline: state.pipeline,
        cipher,
        contentHashKey: environment.APP_ENCRYPTION_KEY,
        rawMessageRetentionDays: environment.RAW_MESSAGE_RETENTION_DAYS,
        onSpacePersisted: (spaceId, route) => {
          conversationPresence.associateSpace(spaceId, route);
        },
      });
      const commandInterceptor = new AuthorizedInboundCommandInterceptor({
        deploymentId: environment.DEPLOYMENT_ID,
        spaces: state.operational,
        handler: state.approvalCommands,
        respond: async (inbound, safeResponse, context) => {
          const spaceId = await state.operational.findInternalSpaceId(
            environment.DEPLOYMENT_ID,
            inbound,
          );
          if (spaceId === undefined) {
            throw new Error(
              "The authorized command space disappeared before its response.",
            );
          }
          await nativeOutbound.send({
            spaceId,
            clientGuid: `command-${inbound.externalMessageId}`,
            text: safeResponse,
            signal: context.signal ?? controller.signal,
          });
        },
      });
      const boundary = new SecureAuthorizeAndIngest(
        authorizer,
        consumer,
        commandInterceptor,
      );
      const loop = runSpectrumMessageLoop({
        authorizeAndIngest: boundary,
        messages: () => app.messages,
        readiness: new SpectrumReadiness(),
        conversationPresence,
        signal: controller.signal,
        onIgnored: (reason) => {
          logger.debug({ component: "spectrum", reason }, "ignored message event");
        },
      });
      const done = loop
        .then(() => ({ reason: "exited" as const }))
        .catch(() => {
          logger.error(
            {
              component: "spectrum",
              errorCode: "SPECTRUM_STREAM_RESTART_EXHAUSTED",
            },
            "Spectrum receive loop stopped after bounded restart attempts",
          );
          return { reason: "restart_exhausted" as const };
        })
        .finally(() => {
          outboundTransport.detach(runId);
          if (activeConversationPresence === conversationPresence) {
            activeConversationPresence = undefined;
          }
          activeSpectrumRuns.delete(runId);
        });
      activeSpectrumRuns.set(runId, { controller, done });
      return {
        runId,
        done,
        async stop() {
          controller.abort();
          await done;
        },
      };
    },

    // Shutdown adapters
    async stopSpectrum() {
      const runs = [...activeSpectrumRuns.values()];
      for (const run of runs) run.controller.abort();
      await Promise.all(runs.map((run) => run.done));
    },

    async stopCodex() {
      await modelSettingsService?.close();
      await photonSetup.close();
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
    const snapshot = { connected: true, ownerRevisionCurrent: true };
    for (const listener of photonActivationListeners) {
      void Promise.resolve(listener(snapshot)).catch(() => undefined);
    }
  });
  photonSetup.onStatusChanged((status) => {
    if (status.state === "connected") return;
    spectrumCredentials = undefined;
    const snapshot = { connected: false, ownerRevisionCurrent: false };
    for (const listener of photonActivationListeners) {
      void Promise.resolve(listener(snapshot)).catch(() => undefined);
    }
  });
  deploymentIdentity.onConfigured(async () => {
    if (photonInstallationService === undefined) return;
    await photonSetup.refresh();
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
