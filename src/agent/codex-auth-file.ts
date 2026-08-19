import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";

import { CodexAppServerProtocolError } from "./codex-app-server/protocol.js";

export async function validateAndRestrictCodexAuthFile(
  codexHome: string,
): Promise<void> {
  const authPath = resolve(codexHome, "auth.json");
  const currentUid = process.getuid?.();
  const handle = await open(authPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || (currentUid !== undefined && before.uid !== currentUid)) {
      throw new CodexAppServerProtocolError();
    }
    await handle.chmod(0o600);
    const after = await handle.stat();
    if (
      !after.isFile() ||
      (after.mode & 0o077) !== 0 ||
      (currentUid !== undefined && after.uid !== currentUid)
    ) {
      throw new CodexAppServerProtocolError();
    }
  } finally {
    await handle.close();
  }
}
