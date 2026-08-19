import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);

export function resolvePinnedCodexExecutable(): string {
  const target = (() => {
    if (process.platform === "darwin" && process.arch === "arm64") {
      return ["@openai/codex-darwin-arm64", "aarch64-apple-darwin"] as const;
    }
    if (process.platform === "darwin" && process.arch === "x64") {
      return ["@openai/codex-darwin-x64", "x86_64-apple-darwin"] as const;
    }
    if (process.platform === "linux" && process.arch === "arm64") {
      return ["@openai/codex-linux-arm64", "aarch64-unknown-linux-musl"] as const;
    }
    if (process.platform === "linux" && process.arch === "x64") {
      return ["@openai/codex-linux-x64", "x86_64-unknown-linux-musl"] as const;
    }
    if (process.platform === "win32" && process.arch === "arm64") {
      return ["@openai/codex-win32-arm64", "aarch64-pc-windows-msvc"] as const;
    }
    if (process.platform === "win32" && process.arch === "x64") {
      return ["@openai/codex-win32-x64", "x86_64-pc-windows-msvc"] as const;
    }
    throw new Error(`Unsupported Codex platform: ${process.platform}/${process.arch}`);
  })();
  const packageRoot = dirname(require.resolve(`${target[0]}/package.json`));
  return resolve(
    packageRoot,
    "vendor",
    target[1],
    "bin",
    process.platform === "win32" ? "codex.exe" : "codex",
  );
}
