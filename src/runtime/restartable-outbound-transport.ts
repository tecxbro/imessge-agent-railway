import type {
  OutboundTransport,
  OutboundTransportReceipt,
  OutboundTransportRequest,
} from "../queue/handlers/outbound-send.js";

/** One-time workers target this stable port while Spectrum intake swaps runs. */
export class RestartableOutboundTransport implements OutboundTransport {
  #runId: string | undefined;
  #delegate: OutboundTransport | undefined;

  public attach(runId: string, delegate: OutboundTransport): void {
    if (this.#runId !== undefined && this.#runId !== runId) {
      throw new Error("A second Spectrum outbound transport cannot become active.");
    }
    this.#runId = runId;
    this.#delegate = delegate;
  }

  public detach(runId: string): void {
    if (this.#runId !== runId) return;
    this.#runId = undefined;
    this.#delegate = undefined;
  }

  public async send(
    request: OutboundTransportRequest,
  ): Promise<OutboundTransportReceipt> {
    const delegate = this.#delegate;
    if (delegate === undefined) {
      throw new Error(
        "Spectrum intake is inactive; retain the durable outbound job for recovery.",
      );
    }
    return await delegate.send(request);
  }
}
