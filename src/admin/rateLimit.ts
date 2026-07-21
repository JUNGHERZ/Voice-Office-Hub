/**
 * Kleiner Sliding-Window-Rate-Limiter (in-memory, pro Prozess) für die öffentlichen
 * Widget-Endpoints. Bewusst ohne Dependency und mit injizierbarer Uhr (Tests).
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** true = erlaubt (und gezählt), false = Limit im Fenster erreicht. */
  allow(key: string): boolean {
    const t = this.now();
    const fresh = (this.hits.get(key) ?? []).filter((ts) => t - ts < this.windowMs);
    if (fresh.length >= this.limit) {
      this.hits.set(key, fresh);
      return false;
    }
    fresh.push(t);
    this.hits.set(key, fresh);
    // Speicher begrenzen: abgelaufene Schlüssel gelegentlich abräumen.
    if (this.hits.size > 1000) {
      for (const [k, arr] of this.hits) {
        if (!arr.length || t - (arr[arr.length - 1] ?? 0) >= this.windowMs) this.hits.delete(k);
      }
    }
    return true;
  }
}
