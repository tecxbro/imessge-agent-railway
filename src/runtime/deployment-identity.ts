import {
  OwnerPhoneNumberValidationError,
  ownerPhoneNumberSchema,
} from "./phone-number.js";

export {
  OwnerPhoneNumberValidationError,
  ownerPhoneNumberSchema,
} from "./phone-number.js";

export type DeploymentIdentityStatus =
  | { state: "initializing" }
  | { state: "not_configured" }
  | {
      state: "configured";
      maskedPhoneNumber: string;
    }
  | {
      state: "failed";
      code: "OWNER_IDENTITY_STORAGE_FAILED";
    };

export interface DeploymentIdentityController {
  initialize(): Promise<DeploymentIdentityStatus>;
  status(): DeploymentIdentityStatus;
  configureOwner(phoneNumber: string): Promise<DeploymentIdentityStatus>;
  readOwnerPhoneNumber(): Promise<string | undefined>;
  onConfigured(
    listener: () => void | Promise<void>,
  ): () => void;
}

export interface DeploymentIdentityRepository {
  replaceOwnerPhoneNumber(phoneNumber: string): Promise<void>;
  readOwnerPhoneNumber(): Promise<string | undefined>;
}

export interface BindableDeploymentIdentityController
  extends DeploymentIdentityController {
  bindRepository(repository: DeploymentIdentityRepository): void;
}

export type LegacyOwnerPhoneSelection =
  | { state: "none" }
  | { state: "ready"; phoneNumber: string }
  | { state: "migration_required" };

export interface DeploymentIdentityInitializationResult {
  status: DeploymentIdentityStatus;
  migrationRequired: boolean;
  importedLegacyOwner: boolean;
}

export function selectLegacyOwnerPhoneNumber(input: {
  ownerPhoneNumber?: string;
  renderOwnerPhoneNumber?: string;
  ownerHandles: readonly string[];
}): LegacyOwnerPhoneSelection {
  if (input.ownerPhoneNumber !== undefined) {
    return {
      state: "ready",
      phoneNumber: ownerPhoneNumberSchema.parse(input.ownerPhoneNumber),
    };
  }
  if (input.renderOwnerPhoneNumber !== undefined) {
    return {
      state: "ready",
      phoneNumber: ownerPhoneNumberSchema.parse(input.renderOwnerPhoneNumber),
    };
  }
  if (input.ownerHandles.length === 0) {
    return { state: "none" };
  }
  if (input.ownerHandles.length !== 1) {
    return { state: "migration_required" };
  }
  const parsed = ownerPhoneNumberSchema.safeParse(input.ownerHandles[0]);
  return parsed.success
    ? { state: "ready", phoneNumber: parsed.data }
    : { state: "migration_required" };
}

export async function initializeDeploymentIdentityController(input: {
  controller: BindableDeploymentIdentityController;
  repository: DeploymentIdentityRepository;
  legacyOwner: LegacyOwnerPhoneSelection;
  protectPhoneNumber?: (phoneNumber: string) => void;
}): Promise<DeploymentIdentityInitializationResult> {
  input.controller.bindRepository(input.repository);
  const storedOwnerPhoneNumber =
    await input.controller.readOwnerPhoneNumber();
  if (storedOwnerPhoneNumber !== undefined) {
    input.protectPhoneNumber?.(storedOwnerPhoneNumber);
    return {
      status: await input.controller.initialize(),
      migrationRequired: false,
      importedLegacyOwner: false,
    };
  }
  if (input.legacyOwner.state === "ready") {
    input.protectPhoneNumber?.(input.legacyOwner.phoneNumber);
    await input.controller.configureOwner(input.legacyOwner.phoneNumber);
  }
  return {
    status: await input.controller.initialize(),
    migrationRequired: input.legacyOwner.state === "migration_required",
    importedLegacyOwner: input.legacyOwner.state === "ready",
  };
}

function maskedPhoneNumber(phoneNumber: string): string {
  return `••••••${phoneNumber.slice(-4)}`;
}

class DeploymentIdentityService
  implements BindableDeploymentIdentityController
{
  readonly #listeners = new Set<() => void | Promise<void>>();
  #repository: DeploymentIdentityRepository | undefined;
  #status: DeploymentIdentityStatus = { state: "initializing" };
  #serializedOperation: Promise<void> = Promise.resolve();

  public bindRepository(repository: DeploymentIdentityRepository): void {
    if (this.#repository !== undefined && this.#repository !== repository) {
      throw new Error("Deployment identity repository is already bound.");
    }
    this.#repository = repository;
  }

  public status(): DeploymentIdentityStatus {
    return { ...this.#status };
  }

  public async initialize(): Promise<DeploymentIdentityStatus> {
    return await this.#serialize(async () => {
      const repository = this.#repository;
      if (repository === undefined) {
        this.#status = {
          state: "failed",
          code: "OWNER_IDENTITY_STORAGE_FAILED",
        };
        return this.status();
      }
      try {
        const phoneNumber = await repository.readOwnerPhoneNumber();
        this.#status =
          phoneNumber === undefined
            ? { state: "not_configured" }
            : {
                state: "configured",
                maskedPhoneNumber: maskedPhoneNumber(
                  ownerPhoneNumberSchema.parse(phoneNumber),
                ),
              };
      } catch {
        this.#status = {
          state: "failed",
          code: "OWNER_IDENTITY_STORAGE_FAILED",
        };
      }
      return this.status();
    });
  }

  public async configureOwner(
    phoneNumber: string,
  ): Promise<DeploymentIdentityStatus> {
    const parsed = ownerPhoneNumberSchema.safeParse(phoneNumber);
    if (!parsed.success) {
      throw new OwnerPhoneNumberValidationError();
    }
    const normalizedPhoneNumber = parsed.data;

    return await this.#serialize(async () => {
      const repository = this.#repository;
      if (repository === undefined) {
        this.#status = {
          state: "failed",
          code: "OWNER_IDENTITY_STORAGE_FAILED",
        };
        return this.status();
      }
      try {
        await repository.replaceOwnerPhoneNumber(normalizedPhoneNumber);
      } catch {
        this.#status = {
          state: "failed",
          code: "OWNER_IDENTITY_STORAGE_FAILED",
        };
        return this.status();
      }

      this.#status = {
        state: "configured",
        maskedPhoneNumber: maskedPhoneNumber(normalizedPhoneNumber),
      };
      await Promise.allSettled(
        [...this.#listeners].map(async (listener) => await listener()),
      );
      return this.status();
    });
  }

  public async readOwnerPhoneNumber(): Promise<string | undefined> {
    const repository = this.#repository;
    if (repository === undefined) {
      return undefined;
    }
    const phoneNumber = await repository.readOwnerPhoneNumber();
    return phoneNumber === undefined
      ? undefined
      : ownerPhoneNumberSchema.parse(phoneNumber);
  }

  public onConfigured(listener: () => void | Promise<void>): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async #serialize(
    operation: () => Promise<DeploymentIdentityStatus>,
  ): Promise<DeploymentIdentityStatus> {
    const result = this.#serializedOperation.then(operation, operation);
    this.#serializedOperation = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }
}

export function createDeploymentIdentityController(): BindableDeploymentIdentityController {
  return new DeploymentIdentityService();
}
