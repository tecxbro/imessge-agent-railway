import Supermemory from "supermemory";
import { z } from "zod";

const internalIdSchema = z.uuid();
const containerTagSchema = z
  .string()
  .max(100)
  .regex(/^[a-zA-Z0-9_:-]+$/u);

const metadataValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.array(z.string()),
]);
const metadataSchema = z.record(z.string(), metadataValueSchema);

const profileResponseSchema = z.object({
  profile: z.object({
    static: z.array(z.string()),
    dynamic: z.array(z.string()),
  }),
});

const searchResponseSchema = z.object({
  results: z.array(
    z.object({
      id: z.string().min(1).max(512),
      memory: z.string().optional(),
      chunk: z.string().optional(),
      similarity: z.number().min(0).max(1),
      metadata: metadataSchema.nullable(),
      updatedAt: z.string(),
    }),
  ),
  timing: z.number().nonnegative(),
  total: z.number().int().nonnegative(),
});

const createResponseSchema = z.object({
  documentId: z.string().nullable(),
  memories: z.array(
    z.object({
      id: z.string().min(1).max(512),
      memory: z.string(),
      isStatic: z.boolean(),
      createdAt: z.string(),
      forgetAfter: z.string().nullable().optional(),
      forgetReason: z.string().nullable().optional(),
      metadata: metadataSchema.nullable().optional(),
    }),
  ),
});

const updateResponseSchema = z.object({
  id: z.string().min(1).max(512),
  memory: z.string(),
  version: z.number().int().positive(),
  parentMemoryId: z.string().nullable(),
  rootMemoryId: z.string().nullable(),
  createdAt: z.string(),
  forgetAfter: z.string().nullable(),
  forgetReason: z.string().nullable(),
});

const forgetResponseSchema = z.object({
  id: z.string().min(1).max(512),
  forgotten: z.literal(true),
});

const listResponseSchema = z.object({
  memoryEntries: z.array(
    z.object({
      id: z.string().min(1).max(512),
      memory: z.string(),
      version: z.number().int().positive(),
      isLatest: z.boolean(),
      isForgotten: z.boolean(),
      isStatic: z.boolean(),
      createdAt: z.string(),
      updatedAt: z.string(),
      metadata: metadataSchema.nullable(),
    }),
  ),
  pagination: z.object({
    currentPage: z.number().int().positive(),
    totalItems: z.number().int().nonnegative(),
    totalPages: z.number().int().nonnegative(),
  }),
});

const deleteContainerResponseSchema = z.object({
  success: z.literal(true),
  containerTag: containerTagSchema,
  deletedDocumentsCount: z.number().int().nonnegative(),
  deletedMemoriesCount: z.number().int().nonnegative(),
});

export type MemoryMetadataValue = z.infer<typeof metadataValueSchema>;
export type MemoryMetadata = z.infer<typeof metadataSchema>;

export interface MemoryProfile {
  static: string[];
  dynamic: string[];
}

export interface MemorySearchHit {
  id: string;
  text: string;
  similarity: number;
  metadata: MemoryMetadata;
  updatedAt: string;
}

export interface CreatedMemory {
  id: string;
  text: string;
  isStatic: boolean;
  createdAt: string;
}

export interface ListedMemory extends CreatedMemory {
  version: number;
  isLatest: boolean;
  isForgotten: boolean;
  updatedAt: string;
  metadata: MemoryMetadata;
}

export interface CreateMemoryInput {
  content: string;
  isStatic: boolean;
  metadata: MemoryMetadata;
}

export interface DeleteContainerResult {
  containerTag: string;
  deletedDocumentsCount: number;
  deletedMemoriesCount: number;
}

export interface SupermemoryPort {
  getOwnerProfile(containerTag: string, signal?: AbortSignal): Promise<MemoryProfile>;
  searchMemories(input: {
    containerTag: string;
    query: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<MemorySearchHit[]>;
  createMemories(input: {
    containerTag: string;
    memories: CreateMemoryInput[];
    signal?: AbortSignal;
  }): Promise<CreatedMemory[]>;
  updateMemory(input: {
    containerTag: string;
    memoryId: string;
    content: string;
    metadata: MemoryMetadata;
    signal?: AbortSignal;
  }): Promise<CreatedMemory>;
  forgetMemory(input: {
    containerTag: string;
    memoryId: string;
    reason: string;
    signal?: AbortSignal;
  }): Promise<{ id: string; forgotten: true }>;
  listMemories(input: {
    containerTag: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<ListedMemory[]>;
  deleteContainer(input: {
    containerTag: string;
    signal?: AbortSignal;
  }): Promise<DeleteContainerResult>;
}

export type MemoryProviderErrorCode =
  | "MEMORY_PROVIDER_ABORTED"
  | "MEMORY_PROVIDER_AUTH_FAILED"
  | "MEMORY_PROVIDER_INVALID_RESPONSE"
  | "MEMORY_PROVIDER_RATE_LIMITED"
  | "MEMORY_PROVIDER_REJECTED"
  | "MEMORY_PROVIDER_TIMEOUT"
  | "MEMORY_PROVIDER_UNAVAILABLE";

export class MemoryProviderError extends Error {
  constructor(
    public readonly code: MemoryProviderErrorCode,
    public readonly retryable: boolean,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MemoryProviderError";
  }
}

export interface SupermemoryClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxReadRetries?: number;
  sdk?: Supermemory;
  fetchImplementation?: typeof fetch;
}

const clientOptionsSchema = z.object({
  apiKey: z.string().trim().min(1),
  baseUrl: z.url().default("https://api.supermemory.ai"),
  timeoutMs: z.number().int().min(100).max(30_000).default(1_500),
  maxReadRetries: z.number().int().min(0).max(2).default(1),
});

/**
 * Derives the sole Supermemory isolation boundary from internal IDs. The resulting
 * tag is 94 characters for UUID inputs and never contains a phone number.
 */
export function ownerContainerTag(deploymentId: string, ownerId: string): string {
  const deployment = internalIdSchema.parse(deploymentId);
  const owner = internalIdSchema.parse(ownerId);
  return containerTagSchema.parse(
    `imessage-agent:${deployment}:owner:${owner}`,
  );
}

function combineSignals(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return callerSignal === undefined
    ? timeoutSignal
    : AbortSignal.any([callerSignal, timeoutSignal]);
}

function providerError(error: unknown, callerSignal?: AbortSignal): MemoryProviderError {
  if (error instanceof MemoryProviderError) {
    return error;
  }
  if (callerSignal?.aborted === true) {
    return new MemoryProviderError(
      "MEMORY_PROVIDER_ABORTED",
      false,
      "Memory operation was canceled with its parent turn.",
      { cause: error },
    );
  }
  if (
    error instanceof Supermemory.APIConnectionTimeoutError ||
    (error instanceof DOMException && error.name === "TimeoutError")
  ) {
    return new MemoryProviderError(
      "MEMORY_PROVIDER_TIMEOUT",
      true,
      "Supermemory timed out; retry the memory job or continue the turn without recall.",
      { cause: error },
    );
  }
  if (error instanceof Supermemory.RateLimitError) {
    return new MemoryProviderError(
      "MEMORY_PROVIDER_RATE_LIMITED",
      true,
      "Supermemory rate-limited the request; retry after provider backoff.",
      { cause: error },
    );
  }
  if (
    error instanceof Supermemory.AuthenticationError ||
    error instanceof Supermemory.PermissionDeniedError
  ) {
    return new MemoryProviderError(
      "MEMORY_PROVIDER_AUTH_FAILED",
      false,
      "Supermemory rejected its credentials or container access; verify the configured key and scopes.",
      { cause: error },
    );
  }
  if (error instanceof Supermemory.BadRequestError) {
    return new MemoryProviderError(
      "MEMORY_PROVIDER_REJECTED",
      false,
      "Supermemory rejected a validated request; verify the pinned API compatibility.",
      { cause: error },
    );
  }
  return new MemoryProviderError(
    "MEMORY_PROVIDER_UNAVAILABLE",
    true,
    "Supermemory is unavailable; retry the projection job or continue without recall.",
    { cause: error },
  );
}

function parseProviderResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new MemoryProviderError(
      "MEMORY_PROVIDER_INVALID_RESPONSE",
      false,
      "Supermemory returned an unexpected response; verify the pinned SDK and API schema before retrying.",
      { cause: result.error },
    );
  }
  return result.data;
}

export class SupermemoryClient implements SupermemoryPort {
  private readonly sdk: Supermemory;
  private readonly request: typeof fetch;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxReadRetries: number;

  constructor(options: SupermemoryClientOptions) {
    const parsed = clientOptionsSchema.parse({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      timeoutMs: options.timeoutMs,
      maxReadRetries: options.maxReadRetries,
    });
    this.apiKey = parsed.apiKey;
    this.baseUrl = parsed.baseUrl.replace(/\/$/u, "");
    this.timeoutMs = parsed.timeoutMs;
    this.maxReadRetries = parsed.maxReadRetries;
    this.request = options.fetchImplementation ?? globalThis.fetch;
    this.sdk =
      options.sdk ??
      new Supermemory({
        apiKey: this.apiKey,
        baseURL: this.baseUrl,
        timeout: this.timeoutMs,
        maxRetries: this.maxReadRetries,
        logLevel: "off",
      });
  }

  async getOwnerProfile(
    containerTag: string,
    signal?: AbortSignal,
  ): Promise<MemoryProfile> {
    // Validate every provider boundary and retry only bounded reads; writes are
    // not blindly retried because duplicate semantic records are durable.
    const tag = containerTagSchema.parse(containerTag);
    try {
      const response = await this.sdk.profile(
        {
          containerTag: tag,
          filters: { AND: [{ key: "scope", value: "owner" }] },
        },
        {
          signal: combineSignals(signal, this.timeoutMs),
          timeout: this.timeoutMs,
          maxRetries: this.maxReadRetries,
        },
      );
      return parseProviderResponse(profileResponseSchema, response).profile;
    } catch (error) {
      throw providerError(error, signal);
    }
  }

  async searchMemories(input: {
    containerTag: string;
    query: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<MemorySearchHit[]> {
    const tag = containerTagSchema.parse(input.containerTag);
    const query = z.string().trim().min(1).max(8_000).parse(input.query);
    const limit = z.number().int().min(1).max(100).parse(input.limit);
    try {
      const response = await this.sdk.search(
        {
          q: query,
          containerTag: tag,
          searchMode: "memories",
          limit,
          include: { forgottenMemories: false },
        },
        {
          signal: combineSignals(input.signal, this.timeoutMs),
          timeout: this.timeoutMs,
          maxRetries: this.maxReadRetries,
        },
      );
      const parsed = parseProviderResponse(searchResponseSchema, response);
      return parsed.results.flatMap((result) => {
        const text = result.memory ?? result.chunk;
        if (text === undefined || text.trim().length === 0) {
          return [];
        }
        return [
          {
            id: result.id,
            text,
            similarity: result.similarity,
            metadata: result.metadata ?? {},
            updatedAt: result.updatedAt,
          },
        ];
      });
    } catch (error) {
      throw providerError(error, input.signal);
    }
  }

  async createMemories(input: {
    containerTag: string;
    memories: CreateMemoryInput[];
    signal?: AbortSignal;
  }): Promise<CreatedMemory[]> {
    const tag = containerTagSchema.parse(input.containerTag);
    const memories = z
      .array(
        z.object({
          content: z.string().trim().min(1).max(10_000),
          isStatic: z.boolean(),
          metadata: metadataSchema,
        }),
      )
      .min(1)
      .max(100)
      .parse(input.memories);
    const response = await this.directRequest(
      "/v4/memories",
      {
        method: "POST",
        body: { memories, containerTag: tag },
        retryable: false,
      },
      input.signal,
    );
    const parsed = parseProviderResponse(createResponseSchema, response);
    return parsed.memories.map((memory) => ({
      id: memory.id,
      text: memory.memory,
      isStatic: memory.isStatic,
      createdAt: memory.createdAt,
    }));
  }

  async updateMemory(input: {
    containerTag: string;
    memoryId: string;
    content: string;
    metadata: MemoryMetadata;
    signal?: AbortSignal;
  }): Promise<CreatedMemory> {
    const tag = containerTagSchema.parse(input.containerTag);
    const memoryId = z.string().trim().min(1).max(512).parse(input.memoryId);
    const content = z.string().trim().min(1).max(10_000).parse(input.content);
    const metadata = metadataSchema.parse(input.metadata);
    try {
      const response = await this.sdk.memories.updateMemory(
        {
          containerTag: tag,
          id: memoryId,
          newContent: content,
          metadata,
        },
        {
          signal: combineSignals(input.signal, this.timeoutMs),
          timeout: this.timeoutMs,
          maxRetries: 0,
        },
      );
      const parsed = parseProviderResponse(updateResponseSchema, response);
      return {
        id: parsed.id,
        text: parsed.memory,
        isStatic: false,
        createdAt: parsed.createdAt,
      };
    } catch (error) {
      throw providerError(error, input.signal);
    }
  }

  async forgetMemory(input: {
    containerTag: string;
    memoryId: string;
    reason: string;
    signal?: AbortSignal;
  }): Promise<{ id: string; forgotten: true }> {
    const tag = containerTagSchema.parse(input.containerTag);
    const memoryId = z.string().trim().min(1).max(512).parse(input.memoryId);
    const reason = z.string().trim().min(1).max(500).parse(input.reason);
    try {
      const response = await this.sdk.memories.forget(
        { containerTag: tag, id: memoryId, reason },
        {
          signal: combineSignals(input.signal, this.timeoutMs),
          timeout: this.timeoutMs,
          maxRetries: 0,
        },
      );
      return parseProviderResponse(forgetResponseSchema, response);
    } catch (error) {
      if (
        error instanceof Supermemory.NotFoundError ||
        error instanceof Supermemory.ConflictError
      ) {
        return { id: memoryId, forgotten: true };
      }
      throw providerError(error, input.signal);
    }
  }

  async listMemories(input: {
    containerTag: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<ListedMemory[]> {
    const tag = containerTagSchema.parse(input.containerTag);
    const limit = z.number().int().min(1).max(100).parse(input.limit);
    const response = await this.directRequest(
      "/v4/memories/list",
      {
        method: "POST",
        body: { containerTags: [tag], limit, page: 1, sort: "updatedAt", order: "desc" },
        retryable: true,
      },
      input.signal,
    );
    const parsed = parseProviderResponse(listResponseSchema, response);
    return parsed.memoryEntries.map((memory) => ({
      id: memory.id,
      text: memory.memory,
      version: memory.version,
      isLatest: memory.isLatest,
      isForgotten: memory.isForgotten,
      isStatic: memory.isStatic,
      createdAt: memory.createdAt,
      updatedAt: memory.updatedAt,
      metadata: memory.metadata ?? {},
    }));
  }

  async deleteContainer(input: {
    containerTag: string;
    signal?: AbortSignal;
  }): Promise<DeleteContainerResult> {
    const tag = containerTagSchema.parse(input.containerTag);
    const response = await this.directRequest(
      `/v3/container-tags/${encodeURIComponent(tag)}`,
      { method: "DELETE", retryable: false, absentContainerTag: tag },
      input.signal,
    );
    const parsed = parseProviderResponse(deleteContainerResponseSchema, response);
    return {
      containerTag: parsed.containerTag,
      deletedDocumentsCount: parsed.deletedDocumentsCount,
      deletedMemoriesCount: parsed.deletedMemoriesCount,
    };
  }

  private async directRequest(
    path: string,
    options: {
      method: "DELETE" | "POST";
      body?: unknown;
      retryable: boolean;
      absentContainerTag?: string;
    },
    callerSignal?: AbortSignal,
  ): Promise<unknown> {
    const signal = combineSignals(callerSignal, this.timeoutMs);
    const attempts = options.retryable ? this.maxReadRetries + 1 : 1;
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const requestInit: RequestInit = {
          method: options.method,
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            "content-type": "application/json",
          },
          signal,
        };
        if (options.body !== undefined) {
          requestInit.body = JSON.stringify(options.body);
        }
        const response = await this.request(`${this.baseUrl}${path}`, requestInit);
        if (response.status === 404 && options.absentContainerTag !== undefined) {
          return {
            success: true,
            containerTag: options.absentContainerTag,
            deletedDocumentsCount: 0,
            deletedMemoriesCount: 0,
          };
        }
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            throw new MemoryProviderError(
              "MEMORY_PROVIDER_AUTH_FAILED",
              false,
              "Supermemory rejected its credentials or container access; verify the configured key and scopes.",
            );
          }
          if (response.status === 429) {
            throw new MemoryProviderError(
              "MEMORY_PROVIDER_RATE_LIMITED",
              true,
              "Supermemory rate-limited the request; retry after provider backoff.",
            );
          }
          throw new MemoryProviderError(
            response.status >= 500
              ? "MEMORY_PROVIDER_UNAVAILABLE"
              : "MEMORY_PROVIDER_REJECTED",
            response.status >= 500,
            "Supermemory rejected a request; verify provider availability and pinned API compatibility.",
          );
        }
        return await response.json();
      } catch (error) {
        lastError = providerError(error, callerSignal);
        if (
          attempt + 1 >= attempts ||
          !(lastError instanceof MemoryProviderError) ||
          !lastError.retryable ||
          signal.aborted
        ) {
          throw lastError;
        }
      }
    }

    throw providerError(lastError, callerSignal);
  }
}
