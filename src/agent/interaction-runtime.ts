import type { Usage } from "@openai/codex-sdk";

import {
  interactionDecisionSchema,
  type InteractionDecision,
} from "./schemas.js";
import type { ModelProfile } from "../config/model-profiles.js";
import {
  buildPrompt,
  type PromptSection,
} from "./prompt-builder.js";
import type { ThreadStore } from "./thread-store.js";

export interface InteractionRuntimeRequest {
  ownerId: string;
  spaceId: string;
  modelProfile: ModelProfile;
  workingDirectory: string;
  sections: readonly PromptSection[];
  recoverySummary?: string;
  signal?: AbortSignal;
}

export interface InteractionRuntimeResult {
  decision: InteractionDecision;
  threadId: string;
  promptSha256: string;
  usage: Usage | null;
  recovered: boolean;
}

export class InteractionRuntime {
  public constructor(private readonly threads: ThreadStore) {}

  public async run(
    request: InteractionRuntimeRequest,
  ): Promise<InteractionRuntimeResult> {
    // Interaction threads are read-only decision makers; repository execution
    // remains in separately permissioned execution threads.
    const prompt = buildPrompt({
      title: "Private iMessage interaction turn",
      sections: request.sections,
    });
    const turn = await this.threads.run({
      scope: {
        kind: "interaction",
        ownerId: request.ownerId,
        spaceId: request.spaceId,
      },
      prompt: prompt.content,
      outputSchema: interactionDecisionSchema,
      modelProfile: request.modelProfile,
      permissionProfile: "read",
      workingDirectory: request.workingDirectory,
      skipGitRepoCheck: true,
      ...(request.recoverySummary === undefined
        ? {}
        : { recoverySummary: request.recoverySummary }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    return {
      decision: turn.output,
      threadId: turn.threadId,
      promptSha256: prompt.sha256,
      usage: turn.usage,
      recovered: turn.recovered,
    };
  }
}
