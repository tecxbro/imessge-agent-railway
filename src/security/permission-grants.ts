import {
  PERMISSION_PROFILE_NAMES,
  permissionProfileNameSchema,
  type AuthorizedSenderRole,
  type PermissionProfileName,
} from "./permissions.js";

export class PermissionProfileNotGrantedError extends Error {
  public readonly code = "PERMISSION_PROFILE_NOT_GRANTED";
  public readonly allowedPermissionProfiles: readonly PermissionProfileName[];

  public constructor(
    public readonly requested: PermissionProfileName,
    allowedPermissionProfiles: Iterable<PermissionProfileName>,
  ) {
    const allowed = canonicalPermissionProfiles(allowedPermissionProfiles);
    super(
      `Permission profile ${requested} is not in the code-authorized set${
        allowed.length === 0 ? "." : ` (${allowed.join(", ")}).`
      } Reject the task without starting Codex.`,
    );
    this.name = "PermissionProfileNotGrantedError";
    this.allowedPermissionProfiles = allowed;
  }
}

function canonicalPermissionProfiles(
  profiles: Iterable<PermissionProfileName>,
): PermissionProfileName[] {
  const requested = new Set(
    [...profiles].map((profile) => permissionProfileNameSchema.parse(profile)),
  );
  return PERMISSION_PROFILE_NAMES.filter((profile) => requested.has(profile));
}

/**
 * Derives the exact code-owned grants for an authorized sender. Collaborators
 * can use read only when the binding itself grants read; owners receive the
 * configured set without profile hierarchy or implied capabilities.
 */
export function permissionGrantsForRole(
  role: AuthorizedSenderRole,
  configuredProfiles: readonly PermissionProfileName[],
): ReadonlySet<PermissionProfileName> {
  if (role !== "owner" && role !== "collaborator") {
    throw new Error("Authorized sender role must be owner or collaborator.");
  }
  const parsed = configuredProfiles.map((profile) =>
    permissionProfileNameSchema.parse(profile),
  );
  const allowed =
    role === "collaborator"
      ? parsed.filter((profile) => profile === "read")
      : parsed;
  return new Set(canonicalPermissionProfiles(allowed));
}

/** Authorizes exact set membership; profiles do not imply one another. */
export function enforcePermissionGrantSet(
  requested: PermissionProfileName,
  allowedPermissionProfiles: ReadonlySet<PermissionProfileName>,
): PermissionProfileName {
  const parsed = permissionProfileNameSchema.parse(requested);
  if (!allowedPermissionProfiles.has(parsed)) {
    throw new PermissionProfileNotGrantedError(
      parsed,
      allowedPermissionProfiles,
    );
  }
  return parsed;
}
