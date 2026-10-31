/** Serializes receiver changes while immediately cancelling an obsolete connection attempt. */
export class ReceiverCommandQueue<Command> {
  private latest: AbortController | undefined;
  private pending = Promise.resolve();

  constructor(
    private readonly execute: (command: Command, signal: AbortSignal) => Promise<void>,
    private readonly onError: (error: unknown, cancelled: boolean) => Promise<void>,
  ) {}

  submit(command: Command): Promise<void> {
    this.latest?.abort();
    const controller = new AbortController();
    this.latest = controller;
    this.pending = this.pending.then(async () => {
      if (controller.signal.aborted) return;
      try { await this.execute(command, controller.signal); }
      catch (error) { await this.onError(error, controller.signal.aborted); }
    });
    return this.pending;
  }
}
