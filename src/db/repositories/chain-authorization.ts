import { and, asc, eq, inArray } from "drizzle-orm";

import {
  isQueuedAuthorizationReferenceValid,
  type QueuedAuthorizationReference,
  type QueuedAuthorizationReferenceStore,
} from "../../security/queued-authorization.js";
import type { Database, DatabaseTransaction } from "../client.js";
import { chainAuthorizationIdentities } from "../schema-fragments/chain-authorization.js";
import {
  chains,
  channelIdentities,
  owners,
  spaces,
} from "../schema.js";

function authorizationIds(
  reference: QueuedAuthorizationReference,
): readonly string[] {
  return [
    reference.principalIdentityId,
    ...reference.contributorIdentityIds,
  ];
}

function sameCapturedSet(
  reference: QueuedAuthorizationReference,
  stored: readonly { identityId: string; isPrincipal: boolean }[],
): boolean {
  const expected = new Map(
    authorizationIds(reference).map((identityId) => [
      identityId,
      identityId === reference.principalIdentityId,
    ]),
  );
  return (
    stored.length === expected.size &&
    stored.every(
      (row) => expected.get(row.identityId) === row.isPrincipal,
    )
  );
}

export class ChainAuthorizationRepository
  implements QueuedAuthorizationReferenceStore
{
  public constructor(private readonly database: Database) {}

  /** Captures one immutable identity set using its own transaction. */
  public async capture(
    reference: QueuedAuthorizationReference,
    acceptedAt = new Date(),
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await this.captureInTransaction(transaction, reference, acceptedAt);
    });
  }

  /**
   * Integration seam for the chain-creation transaction. Repeated capture of
   * the exact same set is idempotent; any conflicting set rolls back.
   */
  public async captureInTransaction(
    transaction: DatabaseTransaction,
    reference: QueuedAuthorizationReference,
    acceptedAt = new Date(),
  ): Promise<void> {
    if (
      !isQueuedAuthorizationReferenceValid(reference) ||
      Number.isNaN(acceptedAt.getTime())
    ) {
      throw new Error(
        "Chain authorization capture requires one valid principal, a unique bounded contributor set, and a valid acceptance time.",
      );
    }

    const [chain] = await transaction
      .select({ deploymentId: spaces.deploymentId })
      .from(chains)
      .innerJoin(spaces, eq(chains.spaceId, spaces.id))
      .where(eq(chains.id, reference.chainId))
      .limit(1);
    if (chain?.deploymentId !== reference.deploymentId) {
      throw new Error(
        "Chain authorization capture rejected because the chain does not belong to the referenced deployment.",
      );
    }

    const identityIds = authorizationIds(reference);
    const ownedIdentities = await transaction
      .select({ identityId: channelIdentities.id })
      .from(channelIdentities)
      .innerJoin(
        owners,
        and(
          eq(channelIdentities.ownerId, owners.id),
          eq(channelIdentities.deploymentId, owners.deploymentId),
        ),
      )
      .where(
        and(
          eq(channelIdentities.deploymentId, reference.deploymentId),
          eq(channelIdentities.ownerId, reference.ownerId),
          inArray(channelIdentities.id, identityIds),
        ),
      );
    if (ownedIdentities.length !== identityIds.length) {
      throw new Error(
        "Chain authorization capture rejected because an identity does not belong to the referenced owner and deployment.",
      );
    }

    await transaction
      .insert(chainAuthorizationIdentities)
      .values(
        identityIds.map((identityId) => ({
          chainId: reference.chainId,
          identityId,
          isPrincipal: identityId === reference.principalIdentityId,
          acceptedAt,
        })),
      )
      .onConflictDoNothing();

    const stored = await transaction
      .select({
        identityId: chainAuthorizationIdentities.identityId,
        isPrincipal: chainAuthorizationIdentities.isPrincipal,
      })
      .from(chainAuthorizationIdentities)
      .where(eq(chainAuthorizationIdentities.chainId, reference.chainId));
    if (!sameCapturedSet(reference, stored)) {
      throw new Error(
        "Chain authorization capture conflicts with the immutable identity set already stored for this chain.",
      );
    }
  }

  public async load(
    chainId: string,
  ): Promise<QueuedAuthorizationReference | undefined> {
    const rows = await this.database
      .select({
        chainId: chainAuthorizationIdentities.chainId,
        identityId: chainAuthorizationIdentities.identityId,
        isPrincipal: chainAuthorizationIdentities.isPrincipal,
        chainDeploymentId: spaces.deploymentId,
        identityDeploymentId: channelIdentities.deploymentId,
        ownerId: channelIdentities.ownerId,
        ownerDeploymentId: owners.deploymentId,
      })
      .from(chainAuthorizationIdentities)
      .innerJoin(chains, eq(chainAuthorizationIdentities.chainId, chains.id))
      .innerJoin(spaces, eq(chains.spaceId, spaces.id))
      .innerJoin(
        channelIdentities,
        eq(chainAuthorizationIdentities.identityId, channelIdentities.id),
      )
      .innerJoin(owners, eq(channelIdentities.ownerId, owners.id))
      .where(eq(chainAuthorizationIdentities.chainId, chainId))
      .orderBy(
        asc(chainAuthorizationIdentities.acceptedAt),
        asc(chainAuthorizationIdentities.identityId),
      );
    if (rows.length === 0) {
      return undefined;
    }

    const first = rows[0]!;
    const principals = rows.filter((row) => row.isPrincipal);
    if (
      principals.length !== 1 ||
      rows.some(
        (row) =>
          row.chainId !== chainId ||
          row.chainDeploymentId !== first.chainDeploymentId ||
          row.identityDeploymentId !== first.chainDeploymentId ||
          row.ownerDeploymentId !== first.chainDeploymentId ||
          row.ownerId !== first.ownerId,
      )
    ) {
      return undefined;
    }

    return {
      deploymentId: first.chainDeploymentId,
      ownerId: first.ownerId,
      chainId,
      principalIdentityId: principals[0]!.identityId,
      contributorIdentityIds: rows
        .filter((row) => !row.isPrincipal)
        .map((row) => row.identityId),
    };
  }
}
