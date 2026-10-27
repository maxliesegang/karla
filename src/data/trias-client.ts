/**
 * Reads KVV's TRIAS interface through KARLA's proxy (`proxy/README.md`), which holds the requestor
 * ref and caches each reply briefly.
 */
import {
  joinStopEventBoards,
  type FeedStopEventBoard,
  type FeedStopEventBoardOptions,
  type Feed,
  type JourneyLocator,
} from "./feed";
import {
  TriasError,
  parseTriasLocations,
  parseTriasStopEvents,
  parseTriasTripInfo,
} from "./trias-parsers";
import { SharedRequests } from "./request-sharing";

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_STOP_EVENT_LIMIT = 20;
/** The most line refs, and rows, one proxy request takes (`proxy/public/api/stop-events.php`). */
const PROXY_LINE_LIMIT = 16;
const PROXY_ROW_LIMIT = 60;

export type TriasClientOptions = {
  /** The proxy's `api/` directory, absolute or relative to the page. */
  proxyUrl: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
};

export class TriasClient implements Feed {
  private readonly proxyUrl: URL;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private rateLimitedUntil = 0;
  private readonly tripInfoRequests = new SharedRequests<{ body: string; ageMs: number }>();

  constructor(options: TriasClientOptions) {
    this.proxyUrl = new URL(options.proxyUrl, globalThis.location?.href ?? "http://localhost/");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  /** A line filter longer than the proxy takes is asked in groups, and the answers joined. */
  async fetchStopEventBoard(
    stopPointId: string,
    { limit = DEFAULT_STOP_EVENT_LIMIT, ...options }: FeedStopEventBoardOptions = {},
  ): Promise<FeedStopEventBoard> {
    const lineGroups = options.lineIds?.length
      ? chunk(options.lineIds, PROXY_LINE_LIMIT)
      : [undefined];
    const boards = await Promise.all(
      lineGroups.map((lineIds) =>
        this.fetchStopEvents(stopPointId, { ...options, limit, lineIds }),
      ),
    );
    return joinStopEventBoards(boards, limit);
  }

  async fetchTripInfo(locator: JourneyLocator) {
    const parameters = {
      journey: `${locator.lineRef}:${locator.journeyCode}`,
      day: locator.operatingDayRef ?? formatOperatingDay(locator.date),
    };
    // A run's reading and its direction's route ask for the same trip at once; one request answers
    // both. The reply is shared, not the parse: each locator marks its own row's call.
    const key = `${parameters.journey}|${parameters.day}`;
    const { body, ageMs } = await (this.tripInfoRequests.find(key) ??
      this.tripInfoRequests.share(key, () =>
        this.request(`Fahrt ${locator.journeyCode}`, "trip-info.php", parameters),
      ));
    const journey = parseTriasTripInfo(body, locator);
    return { ...journey, serverTime: advance(journey.serverTime, ageMs) };
  }

  /**
   * The dated journey's calls: a direction's route is what its dated journeys call at
   * (`docs/trias-api.md`).
   */
  async fetchLineRoute(locator: JourneyLocator) {
    return (await this.fetchTripInfo(locator)).calls;
  }

  async searchStops(query: string) {
    const { body } = await this.request("Haltestellensuche", "locations.php", { q: query });
    return parseTriasLocations(body);
  }

  private async fetchStopEvents(
    stopId: string,
    {
      limit = DEFAULT_STOP_EVENT_LIMIT,
      includeCalls,
      lineIds,
      eventKind,
    }: FeedStopEventBoardOptions,
  ): Promise<FeedStopEventBoard> {
    const { body, ageMs } = await this.request(`Abfahrtstafel ${stopId}`, "stop-events.php", {
      stop: stopId,
      rows: String(Math.min(limit, PROXY_ROW_LIMIT)),
      calls: includeCalls ? "1" : "0",
      ...(eventKind === "arrival" ? { kind: "arrival" } : {}),
      ...(lineIds?.length ? { lines: lineIds.join(",") } : {}),
    });
    const board = parseTriasStopEvents(body, stopId, eventKind);
    return { ...board, serverTime: advance(board.serverTime, ageMs) };
  }

  /** One GET to the proxy, with how long the proxy had cached the reply (`Age`). */
  private async request(
    requestDescription: string,
    endpoint: string,
    parameters: Record<string, string>,
  ): Promise<{ body: string; ageMs: number }> {
    if (Date.now() < this.rateLimitedUntil) throw new TriasError(RATE_LIMIT_MESSAGE);
    const url = new URL(endpoint, this.proxyUrl);
    url.search = new URLSearchParams(parameters).toString();
    let response: Response;
    try {
      response = await this.fetchFn(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      throw new TriasError(`${requestDescription} konnte nicht geladen werden`, {
        cause: error,
      });
    }
    if (response.status === 429) {
      // Paused until the proxy's `Retry-After`, so a rate-limited client stops asking.
      this.rateLimitedUntil = Math.max(this.rateLimitedUntil, getRetryAt(response));
      throw new TriasError(RATE_LIMIT_MESSAGE);
    }
    if (!response.ok) throw new TriasError(`${requestDescription}: HTTP ${response.status}`);
    let body: string;
    try {
      body = await response.text();
    } catch (cause) {
      throw new TriasError(`${requestDescription} konnte nicht geladen werden`, { cause });
    }
    const ageSeconds = Number(response.headers.get("Age"));
    return {
      body,
      ageMs: Number.isFinite(ageSeconds) && ageSeconds > 0 ? ageSeconds * 1_000 : 0,
    };
  }
}

const RATE_LIMIT_MESSAGE = "TRIAS-Anfragelimit erreicht; erneuter Versuch später";

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
