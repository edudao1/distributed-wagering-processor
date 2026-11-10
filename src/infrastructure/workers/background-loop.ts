import { describeError } from "../../application/errors";
import type { Logger } from "../../application/ports/infrastructure";

export class BackgroundLoop {
  private running = false;
  private current: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly tick: () => Promise<number>,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.current = this.loop();
    this.logger.info({ worker: this.name }, "background worker started");
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.wake?.();
    await this.current;
    this.logger.info({ worker: this.name }, "background worker stopped");
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let processed = 0;
      try {
        processed = await this.tick();
      } catch (error) {
        this.logger.error({ worker: this.name, err: describeError(error) }, "background worker iteration failed");
      }
      if (processed === 0 && this.running) {
        await this.pause();
      }
    }
  }

  private pause(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, this.intervalMs);
      function done(): void {
        clearTimeout(timer);
        resolve();
      }
      this.wake = done;
    });
  }
}
