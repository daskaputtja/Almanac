/**
 * Counts failures per key (an IP address or a username) in a sliding window.
 * Kept in memory: a restart clears it, which is acceptable for a small
 * self-hosted app, and an attacker can't fill the database with it.
 */
export class FailureLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly maxFailures: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  /** Seconds until `key` may try again, or 0 if it isn't blocked. */
  retryAfter(key: string, now = Date.now()): number {
    const recent = this.recent(key, now);
    if (recent.length < this.maxFailures) return 0;
    return Math.max(1, Math.ceil((recent[0]! + this.windowMs - now) / 1000));
  }

  fail(key: string, now = Date.now()): void {
    const recent = this.recent(key, now);
    recent.push(now);
    this.failures.set(key, recent);
    if (this.failures.size > this.maxKeys) {
      // Drop the oldest key rather than grow without limit.
      const first = this.failures.keys().next().value;
      if (first !== undefined) this.failures.delete(first);
    }
  }

  reset(key: string): void {
    this.failures.delete(key);
  }

  private recent(key: string, now: number): number[] {
    const list = (this.failures.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }
}
