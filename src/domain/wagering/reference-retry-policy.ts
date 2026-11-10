import { InvalidRetryPolicyError } from "../errors";

export interface ReferenceRetryPolicyProps {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export class ReferenceRetryPolicy {
  private constructor(
    public readonly maxAttempts: number,
    public readonly baseDelayMs: number,
    public readonly maxDelayMs: number,
  ) {
    Object.freeze(this);
  }

  static create(props: ReferenceRetryPolicyProps): ReferenceRetryPolicy {
    const values = [props.maxAttempts, props.baseDelayMs, props.maxDelayMs];
    if (values.some((value) => !Number.isInteger(value) || value <= 0)) {
      throw new InvalidRetryPolicyError("retry policy values must be positive integers");
    }
    if (props.maxDelayMs < props.baseDelayMs) {
      throw new InvalidRetryPolicyError("maxDelayMs must be greater than or equal to baseDelayMs");
    }
    return new ReferenceRetryPolicy(props.maxAttempts, props.baseDelayMs, props.maxDelayMs);
  }

  isExhausted(attempt: number): boolean {
    return attempt >= this.maxAttempts;
  }

  delayFor(attempt: number): number {
    const exponent = Math.max(0, attempt - 1);
    return Math.min(this.baseDelayMs * 2 ** exponent, this.maxDelayMs);
  }

  nextAttemptAt(attempt: number, now: Date): Date {
    return new Date(now.getTime() + this.delayFor(attempt));
  }
}
