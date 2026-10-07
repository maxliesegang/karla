/** Age-bounded readings, with least-recently-used eviction at capacity. */
export class ReadingCache<Value> {
  private readonly readings = new Map<string, { value: Value; readAt: number }>();
  private readonly capacity: number;
  private readonly maxAgeMs: number;

  constructor(capacity: number, maxAgeMs: number) {
    this.capacity = capacity;
    this.maxAgeMs = maxAgeMs;
  }

  get(key: string): Value | undefined {
    this.prune(Date.now());
    const reading = this.readings.get(key);
    if (!reading) return undefined;
    this.readings.delete(key);
    this.readings.set(key, reading);
    return reading.value;
  }

  set(key: string, value: Value, readAt = Date.now()): void {
    const now = Date.now();
    this.prune(now);
    this.readings.delete(key);
    if (now - readAt >= this.maxAgeMs) return;
    this.readings.set(key, { value, readAt });
    while (this.readings.size > this.capacity) {
      const oldest = this.readings.keys().next().value;
      if (oldest === undefined) return;
      this.readings.delete(oldest);
    }
  }

  private prune(now: number): void {
    for (const [key, reading] of this.readings) {
      if (now - reading.readAt >= this.maxAgeMs) this.readings.delete(key);
    }
  }
}
