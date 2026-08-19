import { ChatGptAuthStateMachine } from "./chatgpt-auth-state-machine.js";
import type { CodexAppServerConnectionFactory } from "./codex-app-server/transport.js";
import { StdioCodexAppServerConnection } from "./codex-app-server/transport.js";

export { CHATGPT_SETUP_ERROR_CODES } from "./chatgpt-auth-state-machine.js";
export type {
  ChatGptSetupController,
  ChatGptSetupErrorCode,
  ChatGptSetupStatus,
} from "./chatgpt-auth-state-machine.js";
export type {
  CodexAppServerConnection,
  CodexAppServerConnectionFactory,
} from "./codex-app-server/transport.js";

export interface CodexAppServerAuthOptions {
  codexHome: string;
  parentEnvironment: Readonly<NodeJS.ProcessEnv>;
  /** Test seam for a compatible executable; production uses the pinned package. */
  executablePath?: string;
  requestTimeoutMs?: number;
  connectionFactory?: CodexAppServerConnectionFactory;
}

export class CodexAppServerAuth extends ChatGptAuthStateMachine {
  public constructor(options: CodexAppServerAuthOptions) {
    super({
      codexHome: options.codexHome,
      connectionFactory:
        options.connectionFactory ??
        (() =>
          StdioCodexAppServerConnection.connect({
            codexHome: options.codexHome,
            parentEnvironment: options.parentEnvironment,
            ...(options.executablePath === undefined
              ? {}
              : { executablePath: options.executablePath }),
            ...(options.requestTimeoutMs === undefined
              ? {}
              : { requestTimeoutMs: options.requestTimeoutMs }),
          })),
    });
  }
}
