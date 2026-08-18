export const REDACTED_VALUE = "[Redacted]";

const sensitiveKeys = new Set([
  "password",
  "secret",
  "token",
  "authorization",
  "apikey",
  "authjson",
  "databaseurl",
  "openaiapikey",
  "photondevicebearertoken",
  "spectrumprojectsecret",
  "supermemoryapikey",
  "appencryptionkey",
  "setupsecret",
  "dashboardsetupsecret",
  "sessionid",
  "operatorsessionid",
  "csrftoken",
  "usercode",
  "devicecode",
  "photondevicecode",
  "chatgptdevicecode",
  "verificationurl",
  "environment",
  "env",
  "text",
  "body",
  "content",
  "rawmessage",
  "messagebody",
  "prompt",
  "commandoutput",
  "sender",
  "senderhandle",
  "emailaddress",
  "phonenumber",
  "normalizedhandleciphertext",
  "normalizedpayloadciphertext",
]);

const patterns: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu,
  /\bsk-[A-Za-z0-9_-]{12,}\b/gu,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu,
  /\bpostgres(?:ql)?:\/\/[^\s]+/giu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
  /(?<![\w-])\+[1-9]\d{7,14}(?![\w-])/gu,
  /(?<![\w-])(?:\+?1[ .-]?)?\(?[2-9]\d{2}\)?[ .-]\d{3}[ .-]\d{4}(?![\w-])/gu,
] as const;

const credentialUrlPattern = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/giu;
const assignmentTokenPattern =
  /\b(api[_-]?key|access[_-]?token|auth[_-]?token|secret)=([^\s&]+)/giu;

function normalizeKey(key: string): string {
  return key.replace(/[^a-z0-9]/giu, "").toLowerCase();
}

function literalSecretValues(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length >= 6))].sort(
    (left, right) => right.length - left.length,
  );
}

export function redactSensitiveString(
  value: string,
  protectedValues: readonly string[] = [],
): string {
  let redacted = value
    .replace(credentialUrlPattern, `$1${REDACTED_VALUE}@`)
    .replace(assignmentTokenPattern, `$1=${REDACTED_VALUE}`);
  for (const pattern of patterns) {
    redacted = redacted.replace(pattern, REDACTED_VALUE);
  }
  for (const secret of literalSecretValues(protectedValues)) {
    redacted = redacted.split(secret).join(REDACTED_VALUE);
  }
  return redacted;
}

export interface RedactionOptions {
  protectedValues?: readonly string[];
  maximumDepth?: number;
  maximumEntries?: number;
  maximumStringLength?: number;
}

function redactInternal(
  value: unknown,
  options: Required<RedactionOptions>,
  seen: WeakSet<object>,
  depth: number,
  entries: { count: number },
): unknown {
  if (typeof value === "string") {
    const bounded = value.slice(0, options.maximumStringLength);
    return redactSensitiveString(bounded, options.protectedValues);
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "undefined" ||
    typeof value === "bigint"
  ) {
    return value;
  }
  if (typeof value === "symbol" || typeof value === "function") {
    return String(value);
  }
  if (depth >= options.maximumDepth) {
    return "[Truncated]";
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  if (value instanceof Error) {
    return {
      type: value.name,
      message: redactSensitiveString(value.message, options.protectedValues),
      stack:
        value.stack === undefined
          ? undefined
          : redactSensitiveString(
              value.stack.slice(0, options.maximumStringLength),
              options.protectedValues,
            ),
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, options.maximumEntries).map((entry) =>
      redactInternal(entry, options, seen, depth + 1, entries),
    );
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    entries.count += 1;
    if (entries.count > options.maximumEntries) {
      redacted["truncated"] = true;
      break;
    }
    redacted[key] = sensitiveKeys.has(normalizeKey(key))
      ? REDACTED_VALUE
      : redactInternal(entry, options, seen, depth + 1, entries);
  }
  return redacted;
}

export function redactLogValue(
  value: unknown,
  options: RedactionOptions = {},
): unknown {
  const resolved: Required<RedactionOptions> = {
    protectedValues: options.protectedValues ?? [],
    maximumDepth: options.maximumDepth ?? 12,
    maximumEntries: options.maximumEntries ?? 1_000,
    maximumStringLength: options.maximumStringLength ?? 16_384,
  };
  return redactInternal(value, resolved, new WeakSet<object>(), 0, { count: 0 });
}

export function createValueAwareRedactor(protectedValues: readonly string[]) {
  const fixed = [...protectedValues];
  return {
    string(value: string): string {
      return redactSensitiveString(value, fixed);
    },
    value(value: unknown): unknown {
      return redactLogValue(value, { protectedValues: fixed });
    },
  };
}
