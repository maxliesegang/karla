/**
 * Reads KVV's TRIAS interface through KARLA's proxy (`proxy/README.md`), which holds the requestor
 * ref and caches each reply briefly. Serving lines supplement its boards from EFA.
 */
import type {
  KvvDepartureBoard,
  KvvDepartureBoardOptions,
  KvvFeed,
  KvvLiveFeed,
  KvvServingLine,
  KvvTripLocator,
} from "./kvv-feed";
import { findComplexProviderStopIds } from "./kvv-stop-mappings";
import {
  KvvTriasError,
  parseTriasLocations,
  parseTriasStopEvents,
  parseTriasTrip,
} from "./kvv-trias-parsers";
import { TriasRateLimitError, TriasUnavailableError } from "./kvv-feed-errors";
import { ReadingCache } from "./reading-cache";

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_DEPARTURE_LIMIT = 20;
/** The most line refs, and rows, one proxy request takes (`proxy/public/api/stop-events.php`). */
const PROXY_LINE_LIMIT = 16;
const PROXY_ROW_LIMIT = 60;
/** Serving lines are timetable data; one reading per stop serves a session's day. */
const SERVING_LINES_TTL_MS = 6 * 60 * 60_000;

export type KvvTriasClientOptions = {
  /** The proxy's `api/` directory, absolute or relative to the page. */
  proxyUrl: string;
  /** Answers what TRIAS does not state. */
  efa: Pick<KvvFeed, "fetchDepartureBoard">;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
};

export class KvvTriasClient implements KvvLiveFeed {
  private readonly proxyUrl: URL;
  private readonly efa: Pick<KvvFeed, "fetchDepartureBoard">;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly servingLines = new ReadingCache<Promise<KvvServingLine[]>>(
    256,
    SERVING_LINES_TTL_MS,
  );
  private rateLimitedUntil = 0;

  constructor(options: KvvTriasClientOptions) {
    this.proxyUrl = new URL(options.proxyUrl, globalThis.location?.href ?? "http://localhost/");
    this.efa = options.efa;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * TRIAS answers one stop of a complex at a time where EFA answers all, so each is asked and the
   * rows joined.
   */
  async fetchDepartureBoard(
    stopPointId: string,
    options: KvvDepartureBoardOptions = {},
  ): Promise<KvvDepartureBoard> {
    const isWholeStop = !options.lineIds?.length;
    const lineGroups = isWholeStop ? [undefined] : chunk(options.lineIds ?? [], PROXY_LINE_LIMIT);
    const [boards, servingLines] = await Promise.all([
      Promise.all(
        findComplexProviderStopIds(stopPointId).flatMap((stopId) =>
          lineGroups.map((lineIds) => this.fetchStopEvents(stopId, { ...options, lineIds })),
        ),
      ),
      isWholeStop ? this.getServingLines(stopPointId) : [],
    ]);
    return {
      stopPointId,
      stopName: boards[0].stopName,
      serverTime: boards[0].serverTime,
      servingLines,
      departures: boards.flatMap((board) => board.departures),
    };
  }

  async fetchTrip(locator: KvvTripLocator) {
    const { body, ageMs } = await this.request(`Fahrt ${locator.tripCode}`, "trip-info.php", {
      journey: `${locator.line}:${locator.tripCode}`,
      day: locator.operatingDay ?? formatOperatingDay(locator.date),
    });
    const trip = parseTriasTrip(body, locator);
    return { ...trip, serverTime: advance(trip.serverTime, ageMs) };
  }

  async searchStops(query: string) {
    const { body } = await this.request("Haltestellensuche", "locations.php", { q: query });
    return parseTriasLocations(body);
  }

  private async fetchStopEvents(
    stopId: string,
    {
      limit = DEFAULT_DEPARTURE_LIMIT,
      includeTripCalls,
      lineIds,
      eventKind,
    }: KvvDepartureBoardOptions,
  ): Promise<KvvDepartureBoard> {
    const { body, ageMs } = await this.request(`Abfahrtstafel ${stopId}`, "stop-events.php", {
      stop: stopId,
      rows: String(Math.min(limit, PROXY_ROW_LIMIT)),
      calls: includeTripCalls ? "1" : "0",
      ...(eventKind === "arrival" ? { kind: "arrival" } : {}),
      ...(lineIds?.length ? { lines: lineIds.join(",") } : {}),
    });
    const board = parseTriasStopEvents(body, stopId, eventKind);
    return { ...board, serverTime: advance(board.serverTime, ageMs) };
  }

  /**
   * A stop's serving lines from a one-row EFA board, kept for hours. A failed reading is not kept,
   * and answers none rather than failing the board.
   */
  private getServingLines(stopPointId: string): Promise<KvvServingLine[]> {
    const kept = this.servingLines.get(stopPointId);
    if (kept) return kept;
    const lines = this.efa
      .fetchDepartureBoard(stopPointId, { limit: 1 })
      .then((board) => board.servingLines)
      .catch(() => {
        this.servingLines.delete(stopPointId);
        return [];
      });
    this.servingLines.set(stopPointId, lines);
    return lines;
  }

  /** One GET to the proxy, with how long the proxy had cached the reply (`Age`). */
  private async request(
    requestDescription: string,
    endpoint: string,
    parameters: Record<string, string>,
  ): Promise<{ body: string; ageMs: number }> {
    if (Date.now() < this.rateLimitedUntil) throw new TriasRateLimitError(this.rateLimitedUntil);
    const url = new URL(endpoint, this.proxyUrl);
    url.search = new URLSearchParams(parameters).toString();
    let response: Response;
    try {
      response = await this.fetchFn(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      throw new TriasUnavailableError(`${requestDescription} konnte nicht geladen werden`, {
        cause: error,
      });
    }
    if (response.status === 429) {
      this.rateLimitedUntil = Math.max(this.rateLimitedUntil, getRetryAt(response));
      throw new TriasRateLimitError(this.rateLimitedUntil);
    }
    if (!response.ok) {
      const message = `${requestDescription}: HTTP ${response.status}`;
      const accessDenied = response.status === 401 || response.status === 403;
      if (accessDenied || response.status >= 500 || response.status === 408) {
        throw new TriasUnavailableError(message, { accessDenied });
      }
      throw new KvvTriasError(message);
    }
    let body: string;
    try {
      body = await response.text();
    } catch (cause) {
      throw new TriasUnavailableError(`${requestDescription} konnte nicht geladen werden`, {
        cause,
      });
    }
    const ageSeconds = Number(response.headers.get("Age"));
    return {
      body,
      ageMs: Number.isFinite(ageSeconds) && ageSeconds > 0 ? ageSeconds * 1_000 : 0,
    };
  }
}

/** The provider's clock reading advanced by the reply's time in the proxy's cache. */
const advance = (serverTime: string, ageMs: number): string =>
  ageMs > 0 ? new Date(Date.parse(serverTime) + ageMs).toISOString() : serverTime;

/** `YYYYMMDD` as TRIAS's `YYYY-MM-DD`. */
const formatOperatingDay = (date: string): string =>
  `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;

function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function getRetryAt(response: Response): number {
  const retryAfter = response.headers.get("Retry-After");
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Date.now() + seconds * 1_000;
  const retryDate = Date.parse(retryAfter ?? "");
  const serverDate = Date.parse(response.headers.get("Date") ?? "");
  if (Number.isFinite(retryDate)) {
    return Number.isFinite(serverDate)
      ? Date.now() + Math.max(0, retryDate - serverDate)
      : Math.max(Date.now(), retryDate);
  }
  return Date.now() + 60_000;
}
