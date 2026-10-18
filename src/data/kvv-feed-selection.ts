/** Which KVV feed the app reads: TRIAS through the proxy while it answers, EFA otherwise. */
import { KvvEfaClient } from "./kvv-efa-client";
import type { KvvDepartureBoardOptions, KvvFeed, KvvLiveFeed, KvvTripLocator } from "./kvv-feed";
import { KvvTriasClient } from "./kvv-trias-client";
import { FeedChangedError, TriasRateLimitError, TriasUnavailableError } from "./kvv-feed-errors";
import { resolveTriasProxyUrl } from "./kvv-proxy-config";

/** How long EFA serves alone after the proxy failed, before TRIAS is tried again. */
export const TRIAS_RETRY_AFTER_MS = 5 * 60_000;

/** A reading remains usable only while its feed session is current. */
export type KvvFeedSession = {
  readonly id: number;
  readonly isCurrent: boolean;
  assertCurrent(): void;
};

export type KvvFeedReading<T> = { readonly value: T; readonly session: KvvFeedSession };

/** Selects timed readings and owns their validity across fallback and recovery. */
export class KvvFeedSelection {
  private unavailableUntil: number | undefined;
  private consecutiveFailures = 0;
  private probing = false;
  private currentSession = this.createSession(0);
  private readonly efa: KvvFeed;
  private readonly trias: KvvLiveFeed | undefined;

  constructor(efa: KvvFeed, trias?: KvvLiveFeed) {
    this.efa = efa;
    this.trias = trias;
  }

  get session(): KvvFeedSession {
    return this.currentSession;
  }

  private publish<T>(value: T, session = this.session): KvvFeedReading<T> {
    session.assertCurrent();
    return { value, session };
  }

  private createSession(id: number): KvvFeedSession {
    const isCurrent = () => this.session === session;
    const session: KvvFeedSession = {
      id,
      get isCurrent() {
        return isCurrent();
      },
      assertCurrent() {
        if (!session.isCurrent) throw new FeedChangedError();
      },
    };
    return session;
  }

  private changeSession(): void {
    this.currentSession = this.createSession(this.currentSession.id + 1);
  }

  fetchDepartureBoard(stopPointId: string, options?: KvvDepartureBoardOptions) {
    return this.read((feed) => feed.fetchDepartureBoard(stopPointId, options));
  }

  fetchTrip(locator: KvvTripLocator) {
    return this.read((feed) => feed.fetchTrip(locator));
  }

  // These endpoints always use EFA and say nothing about TRIAS availability.
  fetchLineRoute(locator: KvvTripLocator) {
    return this.efa.fetchLineRoute(locator);
  }

  fetchServiceNotices() {
    return this.efa.fetchServiceNotices();
  }

  searchStops(query: string) {
    return this.read((feed) => feed.searchStops(query));
  }

  private async read<T>(reading: (feed: KvvLiveFeed) => Promise<T>): Promise<KvvFeedReading<T>> {
    const session = this.session;
    if (!this.trias) return this.publish(await reading(this.efa), session);
    if (this.unavailableUntil !== undefined) {
      if (Date.now() >= this.unavailableUntil && !this.probing) {
        return this.probe(reading, session);
      }
      return this.publish(await reading(this.efa), session);
    }
    try {
      const result = await reading(this.trias);
      session.assertCurrent();
      this.consecutiveFailures = 0;
      return this.publish(result, session);
    } catch (error) {
      session.assertCurrent();
      if (!(error instanceof TriasUnavailableError)) {
        this.consecutiveFailures = 0;
        throw error;
      }
      this.consecutiveFailures += 1;
      if (!error.accessDenied && this.consecutiveFailures < 2) throw error;
      this.unavailableUntil = Date.now() + TRIAS_RETRY_AFTER_MS;
      this.changeSession();
      const fallbackSession = this.session;
      const result = await reading(this.efa);
      return this.publish(result, fallbackSession);
    }
  }

  private async probe<T>(
    reading: (feed: KvvLiveFeed) => Promise<T>,
    session: KvvFeedSession,
  ): Promise<KvvFeedReading<T>> {
    this.probing = true;
    try {
      let result: T;
      try {
        result = await reading(this.trias ?? this.efa);
      } catch (error) {
        session.assertCurrent();
        this.unavailableUntil = Math.max(
          Date.now() + TRIAS_RETRY_AFTER_MS,
          error instanceof TriasRateLimitError ? error.retryAt : 0,
        );
        return this.publish(await reading(this.efa), session);
      }
      session.assertCurrent();
      this.unavailableUntil = undefined;
      this.consecutiveFailures = 0;
      this.changeSession();
      return this.publish(result);
    } finally {
      this.probing = false;
    }
  }
}

/**
 * The app's feed. `VITE_TRIAS_PROXY_URL` points it at another proxy (`/api/` with `npm run proxy`
 * in development); set empty, EFA alone is read.
 */
export function createKvvFeed(): KvvFeedSelection {
  const efa = new KvvEfaClient();
  const proxyUrl = resolveTriasProxyUrl(import.meta.env ?? {});
  if (!proxyUrl) return new KvvFeedSelection(efa);
  return new KvvFeedSelection(efa, new KvvTriasClient({ proxyUrl, efa }));
}
