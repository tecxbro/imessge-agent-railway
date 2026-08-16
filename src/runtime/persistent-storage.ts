import {
  access,
  appendFile,
  chmod,
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import type { CodexAuthMode } from "../agent/child-environment.js";

export interface PersistentStorageLayout {
  codexHome: string;
  workspaceRoot: string;
  codexConfigPath: string;
  codexConfigCreated: boolean;
}

export class PersistentStorageError extends Error {
  public readonly code = "PERSISTENT_STORAGE_INVALID";

  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PersistentStorageError";
  }
}

function pathContains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function requiredCodexConfig(authMode: CodexAuthMode): ReadonlyArray<string> {
  return [
    'cli_auth_credentials_store = "file"',
    `forced_login_method = "${authMode === "api_key" ? "api" : "chatgpt"}"`,
  ];
}

function configuredTomlValue(
  contents: string,
  key: "cli_auth_credentials_store" | "forced_login_method",
): string | undefined {
  const expression = new RegExp(
    `^\\s*${key}\\s*=\\s*"([^"]+)"\\s*(?:#.*)?$`,
    "mu",
  );
  return expression.exec(contents)?.[1];
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  const details = await stat(path);
  if (!details.isDirectory() || (details.mode & 0o077) !== 0) {
    throw new PersistentStorageError(
      "Persistent storage must be a directory restricted to the service account (mode 0700).",
    );
  }
  await access(path, constants.R_OK | constants.W_OK | constants.X_OK);
}

async function ensureCodexConfiguration(
  codexHome: string,
  authMode: CodexAuthMode,
): Promise<{ path: string; created: boolean }> {
  const path = resolve(codexHome, "config.toml");
  const required = requiredCodexConfig(authMode);
  let contents: string;
  let created = false;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
    contents = `${required.join("\n")}\n`;
    await writeFile(path, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    created = true;
  }

  const expectedStore = "file";
  const expectedLogin = authMode === "api_key" ? "api" : "chatgpt";
  const configuredStore = configuredTomlValue(
    contents,
    "cli_auth_credentials_store",
  );
  const configuredLogin = configuredTomlValue(contents, "forced_login_method");
  if (configuredStore !== undefined && configuredStore !== expectedStore) {
    throw new PersistentStorageError(
      "CODEX_HOME/config.toml uses a non-file credential store. Set cli_auth_credentials_store to file for headless persistent authentication.",
    );
  }
  if (configuredLogin !== undefined && configuredLogin !== expectedLogin) {
    throw new PersistentStorageError(
      `CODEX_HOME/config.toml requires a different login method. Set forced_login_method to ${expectedLogin} for the configured CODEX_AUTH_MODE.`,
    );
  }

  const missing = [
    ...(configuredStore === undefined ? [required[0]!] : []),
    ...(configuredLogin === undefined ? [required[1]!] : []),
  ];
  if (missing.length > 0) {
    const prefix = contents.length === 0 || contents.endsWith("\n") ? "" : "\n";
    await appendFile(path, `${prefix}${missing.join("\n")}\n`, "utf8");
  }
  await chmod(path, 0o600);
  const details = await stat(path);
  if (!details.isFile() || (details.mode & 0o077) !== 0) {
    throw new PersistentStorageError(
      "CODEX_HOME/config.toml must be a regular file restricted to the service account (mode 0600).",
    );
  }

  return { path, created };
}

export async function preparePersistentStorage(input: {
  codexHome: string;
  workspaceRoot: string;
  authMode: CodexAuthMode;
}): Promise<PersistentStorageLayout> {
  // Credentials and workspaces are separate private roots so repository tasks
  // cannot traverse into Codex authentication/session storage.
  const codexHome = resolve(input.codexHome);
  const workspaceRoot = resolve(input.workspaceRoot);
  if (!isAbsolute(input.codexHome) || !isAbsolute(input.workspaceRoot)) {
    throw new PersistentStorageError(
      "CODEX_HOME and AGENT_WORKSPACE_ROOT must be explicit absolute paths before startup.",
    );
  }
  if (
    pathContains(codexHome, workspaceRoot) ||
    pathContains(workspaceRoot, codexHome)
  ) {
    throw new PersistentStorageError(
      "CODEX_HOME and AGENT_WORKSPACE_ROOT must be separate, non-overlapping directories.",
    );
  }

  try {
    await ensureDirectory(codexHome);
    await ensureDirectory(workspaceRoot);
    const configuration = await ensureCodexConfiguration(
      codexHome,
      input.authMode,
    );
    return {
      codexHome,
      workspaceRoot,
      codexConfigPath: configuration.path,
      codexConfigCreated: configuration.created,
    };
  } catch (error) {
    if (error instanceof PersistentStorageError) {
      throw error;
    }
    throw new PersistentStorageError(
      "Persistent Codex/workspace storage could not be prepared. Verify the disk mount, ownership, free space, and permissions before restarting.",
      { cause: error },
    );
  }
}
