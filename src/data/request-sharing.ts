/**
 * One in-flight request per key, shared by concurrent askers. Not a cache: dropped once settled.
 */
export class SharedRequests<T> {
  private readonly inFlight = new Map<string, Promise<T>>();

  /** The request already out under any of these keys, if one is. */
  find(...keys: readonly string[]): Promise<T> | undefined {
    for (const key of keys) {
      const pending = this.inFlight.get(key);
      if (pending) return pending;
    }
    return undefined;
  }

  /** Starts a request under this key and keeps it shareable until it settles. */
  share(key: string, run: () => Promise<T>): Promise<T> {
    const request = run().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, request);
    return request;
  }
}
