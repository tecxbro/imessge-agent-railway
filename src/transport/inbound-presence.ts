import type { ReadReceiptDispatcherPort } from "./read-receipts.js";

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted ?? false;
}

export interface InboundPresenceSequence {
  beginTyping(): Promise<void>;
  read(): Promise<void>;
}

export interface InboundPresenceDispatcherOptions {
  readDelayMs: number;
  readReceiptDispatcher: ReadReceiptDispatcherPort;
  typingStartDelayMs: number;
  wait(milliseconds: number, signal?: AbortSignal): Promise<void>;
  signal?: AbortSignal;
}

/** Dispatches the ordered cosmetic sequence without returning it to intake. */
export class InboundPresenceDispatcher {
  public constructor(
    private readonly options: InboundPresenceDispatcherOptions,
  ) {}

  public dispatch(sequence: InboundPresenceSequence): boolean {
    return this.options.readReceiptDispatcher.dispatch(async () => {
      await this.options.wait(this.options.readDelayMs, this.options.signal);
      if (isAborted(this.options.signal)) return;
      try {
        await sequence.read();
      } finally {
        await this.options.wait(
          this.options.typingStartDelayMs,
          this.options.signal,
        );
        if (!isAborted(this.options.signal)) {
          await sequence.beginTyping();
        }
      }
    });
  }

  public close(): Promise<void> {
    return this.options.readReceiptDispatcher.close();
  }
}
