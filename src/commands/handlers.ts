import type { ModelSelection } from "../agent/model-selection.js";
import type {
  ApprovalActor,
  ApprovalService,
} from "../security/approvals.js";
import type {
  AuthorizedCommandInterceptor,
  AuthorizedSenderContext,
  InternalSpaceLookup,
} from "../security/authorize-sender.js";
import type { InboundTextForAuthorization } from "../transport/message-loop.js";
import type { ParsedSlashCommand } from "./parse.js";

export interface CommandContext {
  deploymentId: string;
  ownerId: string;
  spaceId: string;
  currentChainId?: string;
}

export type ComponentStatus = "ready" | "degraded" | "unavailable" | "unknown";

export interface CommandStatusSnapshot {
  messaging: ComponentStatus;
  signIn: ComponentStatus;
  work: ComponentStatus;
  memory: ComponentStatus | "disabled";
  activeTaskCount: number;
  modelSelection: ModelSelection;
}

export interface NamedAgentSummary {
  name: string;
  status: "active" | "idle" | "reset" | "disabled";
  summary?: string;
}

export interface CommandHandlersDependencies {
  getStatus(context: CommandContext): Promise<CommandStatusSnapshot>;
  getModelSelection(context: CommandContext): Promise<ModelSelection>;
  cancelActive(context: CommandContext): Promise<{ canceledCount: number }>;
  resetInteractionThread(context: CommandContext): Promise<void>;
  listAgents(context: CommandContext): Promise<readonly NamedAgentSummary[]>;
}

export interface CommandResult {
  handled: true;
  message: string;
}

function noArguments(
  command: ParsedSlashCommand,
  usage: string,
): CommandResult | undefined {
  if (command.args.length === 0) {
    return undefined;
  }
  return { handled: true, message: `usage: ${usage}` };
}

function statusLabel(value: ComponentStatus | "disabled"): string {
  switch (value) {
    case "ready":
      return "ready";
    case "degraded":
      return "limited";
    case "unavailable":
      return "unavailable";
    case "disabled":
      return "off";
    case "unknown":
      return "checking";
  }
}

function safeDisplayText(value: string, maximum: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximum);
}

function helpMessage(): string {
  return [
    "i can answer directly or do bounded work in an approved workspace",
    "",
    "/status — check service readiness and active work",
    "/model — view the deployment model selected in the dashboard",
    "/cancel — cancel active work in this conversation",
    "/new — start a fresh conversation thread while keeping your saved memory",
    "/agents — list your named work contexts",
    "",
    "external sends, destructive changes, purchases, and permission changes still require exact approval",
  ].join("\n");
}

export async function handleSlashCommand(
  command: ParsedSlashCommand,
  context: CommandContext,
  dependencies: CommandHandlersDependencies,
): Promise<CommandResult> {
  switch (command.name) {
    case "help": {
      const usage = noArguments(command, "/help");
      return usage ?? { handled: true, message: helpMessage() };
    }
    case "status": {
      const usage = noArguments(command, "/status");
      if (usage !== undefined) {
        return usage;
      }
      const status = await dependencies.getStatus(context);
      const activeTaskCount = Math.max(0, Math.trunc(status.activeTaskCount));
      return {
        handled: true,
        message: [
          `messaging: ${statusLabel(status.messaging)}`,
          `sign-in: ${statusLabel(status.signIn)}`,
          `work: ${statusLabel(status.work)}${activeTaskCount === 0 ? "" : ` (${activeTaskCount} active)`}`,
          `memory: ${statusLabel(status.memory)}`,
          `model: ${formatModelName(status.modelSelection.modelId)} · ${status.modelSelection.reasoningEffort}`,
        ].join("\n"),
      };
    }
    case "model": {
      const current = await dependencies.getModelSelection(context);
      return {
        handled: true,
        message: [
          `model: ${formatModelName(current.modelId)} · ${current.reasoningEffort}`,
          "change it under Advanced in your dashboard",
        ].join("\n"),
      };
    }
    case "cancel": {
      const usage = noArguments(command, "/cancel");
      if (usage !== undefined) {
        return usage;
      }
      const { canceledCount } = await dependencies.cancelActive(context);
      return {
        handled: true,
        message:
          canceledCount > 0
            ? "canceled it"
            : "nothing active to cancel",
      };
    }
    case "new": {
      const usage = noArguments(command, "/new");
      if (usage !== undefined) {
        return usage;
      }
      await dependencies.resetInteractionThread(context);
      return {
        handled: true,
        message: "started a fresh conversation. saved memory is unchanged",
      };
    }
    case "agents": {
      const usage = noArguments(command, "/agents");
      if (usage !== undefined) {
        return usage;
      }
      const agents = (await dependencies.listAgents(context)).slice(0, 20);
      if (agents.length === 0) {
        return {
          handled: true,
          message: "no named work contexts yet",
        };
      }
      const rows = agents.map((agent) => {
        const name = safeDisplayText(agent.name, 80) || "unnamed";
        const summary =
          agent.summary === undefined
            ? ""
            : ` — ${safeDisplayText(agent.summary, 160)}`;
        return `• ${name} (${agent.status})${summary}`;
      });
      return {
        handled: true,
        message: ["named work contexts:", ...rows].join("\n"),
      };
    }
    case "unknown":
      return {
        handled: true,
        message: "unknown command. try /help",
      };
  }
}

function formatModelName(modelId: string): string {
  const match = /^gpt-([0-9.]+)(?:-(.+))?$/iu.exec(modelId);
  if (match !== null) {
    const suffix = match[2]
      ?.split("-")
      .map((part) => part[0]!.toUpperCase() + part.slice(1))
      .join(" ");
    return `GPT-${match[1]}${suffix === undefined ? "" : ` ${suffix}`}`;
  }
  return modelId;
}

const explicitApprovalPattern = /^\/(approve|reject)\s+([a-f0-9-]{36})$/iu;
const naturalApprove = new Set(["yes", "approve", "yes, approve"]);
const naturalReject = new Set(["no", "reject", "no, reject"]);

export interface AuthorizedCommandResult {
  handled: boolean;
  /** Safe deterministic response; never model-generated. */
  response?: string;
  approvalChanged?: "approved" | "rejected";
  canceled?: boolean;
}

export interface CancelCurrentChain {
  cancel(ownerId: string, spaceId: string, identityId: string): Promise<boolean>;
}

export interface AuthorizedCommandHandlerOptions {
  approvals: Pick<ApprovalService, "listPending" | "respond">;
  cancellation?: CancelCurrentChain;
}

export class AuthorizedCommandHandler {
  public constructor(private readonly options: AuthorizedCommandHandlerOptions) {}

  public async handle(
    actor: ApprovalActor,
    spaceId: string,
    text: string,
  ): Promise<AuthorizedCommandResult> {
    const normalized = text.trim();
    const lower = normalized.toLowerCase();
    if (lower === "/cancel") {
      if (this.options.cancellation === undefined) {
        return { handled: true, response: "nothing is configured to cancel" };
      }
      const canceled = await this.options.cancellation.cancel(
        actor.ownerId,
        spaceId,
        actor.identityId,
      );
      return {
        handled: true,
        canceled,
        response: canceled
          ? "canceled it"
          : "nothing active to cancel",
      };
    }

    const explicit = explicitApprovalPattern.exec(normalized);
    const naturalStatus = naturalApprove.has(lower)
      ? "approved"
      : naturalReject.has(lower)
        ? "rejected"
        : undefined;
    if (
      (explicit !== null || naturalStatus !== undefined) &&
      (actor.role !== "owner" || !actor.canApprove)
    ) {
      return {
        handled: true,
        response: "only the active owner may approve or reject actions",
      };
    }
    if (explicit?.[1] !== undefined && explicit[2] !== undefined) {
      return this.respond(
        actor,
        spaceId,
        explicit[2],
        explicit[1].toLowerCase() === "approve" ? "approved" : "rejected",
      );
    }
    if (naturalStatus !== undefined) {
      const pending = await this.options.approvals.listPending(actor, spaceId);
      if (pending.length !== 1) {
        return {
          handled: true,
          response:
            pending.length === 0
              ? "no live approval request in this conversation"
              : "more than one approval is pending. reply with /approve <id> or /reject <id>",
        };
      }
      return this.respond(
        actor,
        spaceId,
        pending[0]!.id,
        naturalStatus,
      );
    }

    if (normalized.startsWith("/")) {
      return {
        handled: true,
        response:
          "unknown command. use /approve <id>, /reject <id>, or /cancel",
      };
    }
    return { handled: false };
  }

  private async respond(
    actor: ApprovalActor,
    spaceId: string,
    approvalId: string,
    status: "approved" | "rejected",
  ): Promise<AuthorizedCommandResult> {
    const changed = await this.options.approvals.respond(
      actor,
      spaceId,
      approvalId,
      status,
    );
    return {
      handled: true,
      ...(changed ? { approvalChanged: status } : {}),
      response: changed
        ? status === "approved"
          ? `approved ${approvalId} for one exact execution`
          : `rejected ${approvalId}. no action will run`
        : "that approval is unavailable, expired, already answered, or outside this conversation",
    };
  }
}

export interface AuthorizedInboundCommandInterceptorOptions {
  deploymentId: string;
  spaces: InternalSpaceLookup;
  handler: AuthorizedCommandHandler;
  respond(
    inbound: InboundTextForAuthorization,
    safeResponse: string,
    context: { signal?: AbortSignal },
  ): Promise<void>;
}

/** Runs recognized commands before normal ingest can supersede their chain. */
export class AuthorizedInboundCommandInterceptor
  implements AuthorizedCommandInterceptor
{
  public constructor(
    private readonly options: AuthorizedInboundCommandInterceptorOptions,
  ) {}

  public async interceptAuthorized(
    inbound: InboundTextForAuthorization,
    sender: AuthorizedSenderContext,
    context: { signal?: AbortSignal },
  ): Promise<boolean> {
    const spaceId = await this.options.spaces.findInternalSpaceId(
      this.options.deploymentId,
      inbound,
    );
    if (spaceId === undefined) {
      return false;
    }
    const result = await this.options.handler.handle(
      {
        ownerId: sender.ownerId,
        identityId: sender.identityId,
        role: sender.role,
        canApprove: sender.canApprove,
      },
      spaceId,
      inbound.text,
    );
    if (!result.handled) {
      return false;
    }
    if (result.response !== undefined) {
      await this.options.respond(inbound, result.response, context);
    }
    return true;
  }
}
