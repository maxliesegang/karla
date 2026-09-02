/**
 * One in-flight request per key, shared by everyone who asks for it while it is out.
 *
 * Every read behind the boundary is a network round trip that several views ask for at once — the
 * same board from the shell and a panel, the same trip from a diagram and a ride. Sharing is not
 * caching: the promise is dropped the moment it settles, so what happens to the answer afterwards
 * stays the caller's decision.
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
