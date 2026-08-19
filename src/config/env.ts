import { createHash } from "node:crypto";
import { isAbsolute, parse, relative, resolve } from "node:path";

import { z } from "zod";

const emptyToUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const requiredText = (label: string) =>
  z.string({ error: `${label} is required` }).trim().min(1, `${label} is required`);

const optionalText = (schema: z.ZodType<string>) =>
  z.preprocess(emptyToUndefined, schema.optional());

const integerFromEnvironment = (
  label: string,
  minimum: number,
  maximum: number,
  defaultValue?: number,
) => {
  const schema = z.coerce
    .number({ error: `${label} must be an integer` })
    .int(`${label} must be an integer`)
    .min(minimum, `${label} must be at least ${minimum}`)
    .max(maximum, `${label} must be at most ${maximum}`);

  return z.preprocess(
    emptyToUndefined,
    defaultValue === undefined ? schema : schema.default(defaultValue),
  );
};

const booleanFromEnvironment = (label: string, defaultValue: boolean) =>
  z.preprocess(
    emptyToUndefined,
    z
      .enum(["true", "false"], {
        error: `${label} must be either true or false`,
      })
      .default(String(defaultValue) as "true" | "false")
      .transform((value) => value === "true"),
  );

const databaseUrlSchema = requiredText("DATABASE_URL")
  .pipe(z.url("DATABASE_URL must be a valid URL"))
  .refine(
    (value) => value.startsWith("postgres://") || value.startsWith("postgresql://"),
    "DATABASE_URL must use the postgres or postgresql protocol",
  );

const databaseMigrationEnvironmentSchema = z.object({
  DATABASE_URL: databaseUrlSchema,
});

const e164PhoneNumberSchema = (label: string) =>
  z
    .string({ error: `${label} must be an E.164 phone number` })
    .trim()
    .regex(/^\+[1-9]\d{7,14}$/u, `${label} must be an E.164 phone number`);

const ownerHandlesSchema = z.string().trim().min(1).transform(
  (value, context): string[] => {
    const handles = value
      .split(",")
      .map((handle) => handle.trim())
      .filter((handle) => handle.length > 0);

    if (handles.length === 0) {
      context.addIssue({
        code: "custom",
        message: "AGENT_OWNER_HANDLES must contain at least one phone number or email",
      });
      return z.NEVER;
    }

    const normalized = handles.map((handle) => handle.toLowerCase());
    const invalid = normalized.filter(
      (handle) =>
        !/^\+[1-9]\d{7,14}$/.test(handle) &&
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(handle),
    );

    if (invalid.length > 0) {
      context.addIssue({
        code: "custom",
        message:
          "AGENT_OWNER_HANDLES entries must be E.164 phone numbers or email addresses",
      });
      return z.NEVER;
    }

    return [...new Set(normalized)];
  },
);

const protectedPathSchema = (label: string) =>
  requiredText(label)
    .refine((value) => !value.includes("\0"), `${label} contains an invalid null byte`)
    .refine(
      (value) => !value.split(/[\\/]+/u).includes(".."),
      `${label} must not contain parent-directory traversal`,
    )
    .transform((value) => (isAbsolute(value) ? value : resolve(value)))
    .refine(
      (value) => value !== parse(value).root,
      `${label} must not resolve to a filesystem root`,
    );

const railwayIdentifierSchema = (label: string) =>
  optionalText(
    z
      .string()
      .trim()
      .min(1)
      .max(256)
      .regex(/^[a-zA-Z0-9_-]+$/u, `${label} is malformed`),
  );

const railwayVolumeMountPathSchema = optionalText(
  z
    .string()
    .trim()
    .refine(isAbsolute, "RAILWAY_VOLUME_MOUNT_PATH must be absolute")
    .refine(
      (value) => !value.includes("\0"),
      "RAILWAY_VOLUME_MOUNT_PATH contains an invalid null byte",
    )
    .refine(
      (value) => !value.split(/[\\/]+/u).includes(".."),
      "RAILWAY_VOLUME_MOUNT_PATH must not contain parent-directory traversal",
    )
    .transform((value) => resolve(value))
    .refine(
      (value) => value !== parse(value).root,
      "RAILWAY_VOLUME_MOUNT_PATH must not resolve to a filesystem root",
    ),
);

function isStrictDescendant(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return (
    pathFromParent !== "" &&
    !pathFromParent.startsWith("..") &&
    !isAbsolute(pathFromParent)
  );
}

const encryptionKeySchema = requiredText("APP_ENCRYPTION_KEY").refine((value) => {
  if (/^[a-f0-9]{64}$/i.test(value)) {
    return true;
  }

  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    return false;
  }

  return Buffer.from(value, "base64").byteLength === 32;
}, "APP_ENCRYPTION_KEY must be a 32-byte key encoded as base64 or 64 hexadecimal characters");

const rawEnvironmentSchema = z
  .object({
    // Required infrastructure and process values
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: integerFromEnvironment("PORT", 1, 65_535, 10_000),
    PATH: requiredText("PATH"),
    LANG: optionalText(z.string().trim().min(1)),
    LANGUAGE: optionalText(z.string().trim().min(1)),
    LC_ALL: optionalText(z.string().trim().min(1)),
    LC_CTYPE: optionalText(z.string().trim().min(1)),

    SPECTRUM_PROJECT_ID: optionalText(
      z.string().trim().min(1, "SPECTRUM_PROJECT_ID must not be empty"),
    ),
    SPECTRUM_PROJECT_SECRET: optionalText(
      z.string().trim().min(1, "SPECTRUM_PROJECT_SECRET must not be empty"),
    ),
    DATABASE_URL: databaseUrlSchema,
    OWNER_PHONE_NUMBER: optionalText(
      e164PhoneNumberSchema("OWNER_PHONE_NUMBER"),
    ),
    OWNER_PHONE_NUMBER_E164_EXAMPLE_PLUS19495550123: optionalText(
      e164PhoneNumberSchema(
        "OWNER_PHONE_NUMBER_E164_EXAMPLE_PLUS19495550123",
      ),
    ),
    AGENT_OWNER_HANDLES: z.preprocess(
      emptyToUndefined,
      ownerHandlesSchema.optional(),
    ),
    DEPLOYMENT_ID: requiredText("DEPLOYMENT_ID").pipe(
      z.uuid("DEPLOYMENT_ID must be a UUID"),
    ),
    APP_ENCRYPTION_KEY: encryptionKeySchema,

    // Codex authentication and isolated storage
    CODEX_HOME: protectedPathSchema("CODEX_HOME"),
    AGENT_WORKSPACE_ROOT: protectedPathSchema("AGENT_WORKSPACE_ROOT"),
    CODEX_AUTH_MODE: z.enum(["chatgpt", "api_key"]).default("chatgpt"),
    OPENAI_API_KEY: optionalText(
      z.string().trim().min(1, "OPENAI_API_KEY must not be empty"),
    ),

    // Optional semantic memory
    SUPERMEMORY_API_KEY: optionalText(
      z.string().trim().min(1, "SUPERMEMORY_API_KEY must not be empty"),
    ),
    SUPERMEMORY_CONTAINER_PREFIX: z
      .preprocess(
        emptyToUndefined,
        z
          .string()
          .trim()
          .min(1)
          .max(64)
          .regex(/^[a-z0-9][a-z0-9-]*$/i)
          .default("imessage-agent"),
      ),

    // Operational limits, retention, and logging
    INBOUND_DEBOUNCE_MS: integerFromEnvironment(
      "INBOUND_DEBOUNCE_MS",
      0,
      5_000,
      0,
    ),
    MAX_EXECUTION_CONCURRENCY: integerFromEnvironment(
      "MAX_EXECUTION_CONCURRENCY",
      1,
      20,
      3,
    ),
    MAX_OWNER_EXECUTION_CONCURRENCY: integerFromEnvironment(
      "MAX_OWNER_EXECUTION_CONCURRENCY",
      1,
      20,
      2,
    ),
    MESSAGE_RATE_LIMIT_PER_MINUTE: integerFromEnvironment(
      "MESSAGE_RATE_LIMIT_PER_MINUTE",
      1,
      10_000,
      60,
    ),
    TASK_RATE_LIMIT_PER_HOUR: integerFromEnvironment(
      "TASK_RATE_LIMIT_PER_HOUR",
      1,
      10_000,
      120,
    ),
    MAX_TASK_RUNTIME_MS: integerFromEnvironment(
      "MAX_TASK_RUNTIME_MS",
      1_000,
      3_600_000,
      900_000,
    ),
    RAW_MESSAGE_RETENTION_DAYS: integerFromEnvironment(
      "RAW_MESSAGE_RETENTION_DAYS",
      1,
      3_650,
      30,
    ),
    FAILURE_RETENTION_DAYS: integerFromEnvironment(
      "FAILURE_RETENTION_DAYS",
      1,
      365,
      14,
    ),
    PAIRING_MODE: z.enum(["off", "on"]).default("off"),
    GROUP_MODE: z
      .enum(["disabled", "owner_mentions_only"])
      .default("owner_mentions_only"),
    LOG_MESSAGE_CONTENT: booleanFromEnvironment("LOG_MESSAGE_CONTENT", false),

    RAILWAY_SERVICE_ID: railwayIdentifierSchema("RAILWAY_SERVICE_ID"),
    RAILWAY_DEPLOYMENT_ID: railwayIdentifierSchema("RAILWAY_DEPLOYMENT_ID"),
    RAILWAY_VOLUME_MOUNT_PATH: railwayVolumeMountPathSchema,
  })
  .superRefine((environment, context) => {
    // Cross-field safety checks prevent individually valid values from creating
    // an unsafe combined provider, concurrency, or storage layout.
    if (
      (environment.SPECTRUM_PROJECT_ID === undefined) !==
      (environment.SPECTRUM_PROJECT_SECRET === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: [
          environment.SPECTRUM_PROJECT_ID === undefined
            ? "SPECTRUM_PROJECT_ID"
            : "SPECTRUM_PROJECT_SECRET",
        ],
        message:
          "SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET must either both be set or both be omitted until Photon setup is complete",
      });
    }

    if (
      environment.OWNER_PHONE_NUMBER !== undefined &&
      environment.OWNER_PHONE_NUMBER_E164_EXAMPLE_PLUS19495550123 !==
        undefined &&
      environment.OWNER_PHONE_NUMBER !==
        environment.OWNER_PHONE_NUMBER_E164_EXAMPLE_PLUS19495550123
    ) {
      context.addIssue({
        code: "custom",
        path: ["OWNER_PHONE_NUMBER_E164_EXAMPLE_PLUS19495550123"],
        message:
          "OWNER_PHONE_NUMBER and OWNER_PHONE_NUMBER_E164_EXAMPLE_PLUS19495550123 must match when both are set",
      });
    }

    if (
      environment.CODEX_AUTH_MODE === "api_key" &&
      environment.OPENAI_API_KEY === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["OPENAI_API_KEY"],
        message: "OPENAI_API_KEY is required when CODEX_AUTH_MODE=api_key",
      });
    }

    if (
      environment.MAX_OWNER_EXECUTION_CONCURRENCY >
      environment.MAX_EXECUTION_CONCURRENCY
    ) {
      context.addIssue({
        code: "custom",
        path: ["MAX_OWNER_EXECUTION_CONCURRENCY"],
        message:
          "MAX_OWNER_EXECUTION_CONCURRENCY must not exceed MAX_EXECUTION_CONCURRENCY",
      });
    }

    const workspaceRelativeToCodex = relative(
      environment.CODEX_HOME,
      environment.AGENT_WORKSPACE_ROOT,
    );
    const codexRelativeToWorkspace = relative(
      environment.AGENT_WORKSPACE_ROOT,
      environment.CODEX_HOME,
    );
    const pathsOverlap =
      workspaceRelativeToCodex === "" ||
      (!workspaceRelativeToCodex.startsWith("..") &&
        !isAbsolute(workspaceRelativeToCodex)) ||
      (!codexRelativeToWorkspace.startsWith("..") &&
        !isAbsolute(codexRelativeToWorkspace));

    if (pathsOverlap) {
      context.addIssue({
        code: "custom",
        path: ["AGENT_WORKSPACE_ROOT"],
        message:
          "AGENT_WORKSPACE_ROOT and CODEX_HOME must be separate, non-overlapping paths",
      });
    }
    const railwayRuntime =
      environment.RAILWAY_SERVICE_ID !== undefined ||
      environment.RAILWAY_DEPLOYMENT_ID !== undefined ||
      environment.RAILWAY_VOLUME_MOUNT_PATH !== undefined;

    if (railwayRuntime && environment.RAILWAY_VOLUME_MOUNT_PATH === undefined) {
      context.addIssue({
        code: "custom",
        path: ["RAILWAY_VOLUME_MOUNT_PATH"],
        message:
          "RAILWAY_VOLUME_MOUNT_PATH is required when Railway runtime variables are present",
      });
    }

    if (environment.RAILWAY_VOLUME_MOUNT_PATH !== undefined) {
      for (const [pathName, protectedPath] of [
        ["CODEX_HOME", environment.CODEX_HOME],
        ["AGENT_WORKSPACE_ROOT", environment.AGENT_WORKSPACE_ROOT],
      ] as const) {
        if (
          !isStrictDescendant(
            environment.RAILWAY_VOLUME_MOUNT_PATH,
            protectedPath,
          )
        ) {
          context.addIssue({
            code: "custom",
            path: [pathName],
            message: `${pathName} must be under RAILWAY_VOLUME_MOUNT_PATH on Railway`,
          });
        }
      }
    }
  })
  .transform((environment) => ({
    ...environment,
    AGENT_OWNER_HANDLES: environment.AGENT_OWNER_HANDLES ?? [],
  }));

export type Environment = z.infer<typeof rawEnvironmentSchema>;
export type DatabaseMigrationEnvironment = z.infer<
  typeof databaseMigrationEnvironmentSchema
>;

export class EnvironmentValidationError extends Error {
  public readonly issues: readonly z.core.$ZodIssue[];

  public constructor(issues: readonly z.core.$ZodIssue[]) {
    const details = issues.map((issue) => {
      const key = issue.path.length > 0 ? issue.path.join(".") : "environment";
      return `- ${key}: ${issue.message}`;
    });

    super(
      [
        "Environment configuration is invalid:",
        ...details,
        "Fix the listed variables and restart the service. See .env.example for the supported configuration.",
      ].join("\n"),
    );
    this.name = "EnvironmentValidationError";
    this.issues = issues;
  }
}

function loadLocalEnvironmentFile(): void {
  try {
    process.loadEnvFile();
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }

    throw new Error(
      "Failed to load the local .env file. Check that it is readable or remove it and use process environment variables.",
      { cause: error },
    );
  }
}

/**
 * Railway injects a stable service ID that is not an application UUID. Derive
 * the internal deployment UUID for brand-new installations without exposing a
 * provider identifier to memory namespaces. Migrated installations configure
 * DEPLOYMENT_ID explicitly so their existing identity always wins.
 */
export function deploymentIdFromRailwayServiceId(serviceId: string): string {
  const normalized = z
    .string()
    .trim()
    .min(1)
    .max(256)
    .regex(/^[a-zA-Z0-9_-]+$/u, "RAILWAY_SERVICE_ID is malformed")
    .parse(serviceId);
  const digest = createHash("sha256")
    .update(`imessage-codex-agent:railway:${normalized}`, "utf8")
    .digest();
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hexadecimal = digest.subarray(0, 16).toString("hex");
  return [
    hexadecimal.slice(0, 8),
    hexadecimal.slice(8, 12),
    hexadecimal.slice(12, 16),
    hexadecimal.slice(16, 20),
    hexadecimal.slice(20),
  ].join("-");
}

function withRailwayDeploymentId(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (
    (source["DEPLOYMENT_ID"] === undefined ||
      source["DEPLOYMENT_ID"]?.trim() === "") &&
    source["RAILWAY_SERVICE_ID"] !== undefined &&
    source["RAILWAY_SERVICE_ID"].trim() !== ""
  ) {
    return {
      ...source,
      DEPLOYMENT_ID: deploymentIdFromRailwayServiceId(
        source["RAILWAY_SERVICE_ID"],
      ),
    };
  }
  return source;
}

export function loadDatabaseMigrationEnvironment(
  source?: NodeJS.ProcessEnv,
): DatabaseMigrationEnvironment {
  if (source === undefined) {
    loadLocalEnvironmentFile();
  }

  const result = databaseMigrationEnvironmentSchema.safeParse(
    source ?? process.env,
  );

  if (!result.success) {
    throw new EnvironmentValidationError(result.error.issues);
  }

  return result.data;
}

export function loadEnvironment(source?: NodeJS.ProcessEnv): Environment {
  if (source === undefined) {
    loadLocalEnvironmentFile();
  }

  const environmentSource = withRailwayDeploymentId(source ?? process.env);
  const removedCredentialIssues: z.core.$ZodIssue[] = [
    "AGENT_PASSWORD",
    "DASHBOARD_SETUP_SECRET",
  ]
    .filter((key) => Object.hasOwn(environmentSource, key))
    .map((key) => ({
      code: "custom",
      path: [key],
      message: `${key} is no longer supported; remove it from the service environment`,
      input: undefined,
    }));
  if (removedCredentialIssues.length > 0) {
    throw new EnvironmentValidationError(removedCredentialIssues);
  }

  const result = rawEnvironmentSchema.safeParse(environmentSource);

  if (!result.success) {
    throw new EnvironmentValidationError(result.error.issues);
  }

  return result.data;
}
