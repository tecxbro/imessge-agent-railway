import type { DeploymentIdentityController } from "./deployment-identity.js";
import { ownerPhoneNumberSchema } from "./phone-number.js";
import type {
  OwnerBindingRevisionPort,
  OwnerBindingSnapshot,
} from "../transport/photon-installation-contracts.js";

export interface OwnerBindingRevisionStore {
  readCurrentOwnerRevision(deploymentId: string): Promise<number | undefined>;
}

export class OwnerBindingRevisionUnavailableError extends Error {
  public readonly code = "OWNER_BINDING_REVISION_UNAVAILABLE";

  public constructor() {
    super(
      "The owner binding revision is unavailable; initialize it in the owner identity transaction before Photon setup.",
    );
    this.name = "OwnerBindingRevisionUnavailableError";
  }
}

/**
 * Reads a stable owner phone/revision pair without changing the existing
 * DeploymentIdentityController contract. The revision is read twice so an
 * owner transaction racing the phone read is retried instead of returning a
 * mixed snapshot.
 */
export function createOwnerBindingRevisionPort(options: {
  deploymentId: string;
  ownerIdentity: Pick<DeploymentIdentityController, "readOwnerPhoneNumber">;
  revisionStore: OwnerBindingRevisionStore;
  maxSnapshotAttempts?: number;
}): OwnerBindingRevisionPort {
  const maxSnapshotAttempts = options.maxSnapshotAttempts ?? 3;
  if (!Number.isSafeInteger(maxSnapshotAttempts) || maxSnapshotAttempts < 1) {
    throw new Error("Owner binding snapshot attempts must be a positive integer.");
  }

  return {
    async read(): Promise<OwnerBindingSnapshot> {
      for (let attempt = 0; attempt < maxSnapshotAttempts; attempt += 1) {
        const before = await options.revisionStore.readCurrentOwnerRevision(
          options.deploymentId,
        );
        const ownerPhoneNumber =
          await options.ownerIdentity.readOwnerPhoneNumber();
        const after = await options.revisionStore.readCurrentOwnerRevision(
          options.deploymentId,
        );
        if (
          before !== undefined &&
          before === after &&
          ownerPhoneNumber !== undefined
        ) {
          return {
            ownerRevision: before,
            ownerPhoneNumber: ownerPhoneNumberSchema.parse(ownerPhoneNumber),
          };
        }
      }
      throw new OwnerBindingRevisionUnavailableError();
    },
  };
}
