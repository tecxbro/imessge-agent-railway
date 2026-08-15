import { execFileSync } from "node:child_process";

const EXPECTED_REPOSITORY = "tecxbro/imessge-agent-railway";
const EXPECTED_URL = "https://github.com/tecxbro/imessge-agent-railway.git";

function repositoryFromUrl(remoteUrl) {
  const candidate = remoteUrl.trim().replace(/\.git$/iu, "");
  const match = candidate.match(
    /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+\/[^/]+)$/iu,
  );
  return match?.[1]?.toLowerCase();
}

function fail(remoteName, observedRepository) {
  console.error(
    [
      "PUSH_TARGET_MISMATCH: refusing to push.",
      `Remote: ${remoteName}`,
      `Observed repository: ${observedRepository ?? "unrecognized or disabled"}`,
      `Required repository: ${EXPECTED_URL}`,
      "Fix the remote instead of bypassing this guard.",
    ].join("\n"),
  );
  process.exitCode = 1;
}

const remoteName = process.argv[2] ?? "origin";
let remoteUrl = process.argv[3];

if (remoteUrl === undefined) {
  try {
    remoteUrl = execFileSync(
      "git",
      ["remote", "get-url", "--push", remoteName],
      { encoding: "utf8" },
    ).trim();
  } catch {
    fail(remoteName, undefined);
  }
}

if (remoteUrl !== undefined) {
  const repository = repositoryFromUrl(remoteUrl);
  if (repository !== EXPECTED_REPOSITORY) {
    fail(remoteName, repository);
  } else {
    console.log(`Push target verified: ${EXPECTED_URL}`);
  }
}
