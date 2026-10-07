import { transitNetwork } from "./transit-network";
import { KvvEfaClient } from "./kvv-efa-client";
import { isWithinKvvArea } from "./kvv-area";
import { getTripInstanceId } from "./kvv-efa-parsers";
import type { KvvDeparture, KvvServiceNotice, KvvTrip, KvvTripLocator } from "./kvv-efa-parsers";
import type {
  DepartureBoard,
  DepartureBoardRequest,
  Departure,
  ServiceNotice,
  RunSequence,
  ServiceNoticeBoard,
  TransitStop,
  TransitNetwork,
  RunDiscoveryPost,
  RunDiscoveryReading,
} from "./transit-types";
import { RunReadingStore } from "./run-reading-store";
import { ReadingCache } from "./reading-cache";
import {
  DirectionCoverageCompleter,
  readDirectionCoverage,
  type DirectionCoverage,
} from "./direction-coverage";
import { createDepartureId, keepOneRowPerRun } from "./departure-runs";
import { kvvStopMappingByLocalStopId } from "./kvv-stop-mappings";
import { SharedRequests } from "./request-sharing";
import { DYNAMIC_STOP_ID_PATTERN, StopRegistry, hashProviderStopId } from "./stop-registry";
import { sortDeparturesByExpectedInstant } from "../lib/departure-order";
import { isBetterRunReading } from "../lib/trips";
import { createSortedKey } from "../lib/collections";
import { ObservedNetworkStore } from "./observed-network-store";
import type { ObservedNetwork } from "../lib/observed-network";

export type { DepartureBoardRequest };

/** What a line's own reading is asked for: which directions, and how stale an answer may be. */
export type LineDepartureBoardsRequest = {
  /** The provider's per-direction ids. Required: this reading is only ever one line's. */
  routeDirectionIds: readonly string[];
  maxAgeMs?: number;
  /**
   * How stale the runs' own re-reads may be, apart from `maxAgeMs`: the feed revises runs about
   * every 35 s, and a run read is a fraction of a board's size.
   */
  runMaxAgeMs?: number;
};
export type RunDiscoveryRequest = {
  maxAgeMs: number;
  runMaxAgeMs: number;
  topologyMaxAgeMs: number;
  horizonMs: number;
};
export { createDepartureId };

/**
 * The boundary the views talk to. Nothing above it knows about EFA, provider ids or HTTP.
 */
export interface TransitSource {
  getRunDiscoveryReading(
    posts: readonly RunDiscoveryPost[],
    options: RunDiscoveryRequest,
  ): Promise<RunDiscoveryReading>;
  /** Stops and lines: the local identities views address. */
  getNetwork(): TransitNetwork;
  /** Resolves both local core-network stops and any stop exposed by the KVV network. */
  resolveStop(stopId: string): Promise<TransitStop | undefined>;
  /**
   * `resolveStop` without the wait, for stops the session has already met, so a view need not
   * render a loading state for a stop it knows. `undefined` means only "not met yet".
   */
  getKnownStop(stopId: string): TransitStop | undefined;
  /** Stops matching a query. Rejects when the provider failed and nothing local matched. */
  searchStops(query: string): Promise<readonly TransitStop[]>;
  /** One stop's live board. Never rejects: failures resolve to an explicit unavailable state. */
  getDepartureBoard(stopId: string, request?: DepartureBoardRequest): Promise<DepartureBoard>;
  /**
   * Several stops of one line: rows from filtered boards, each run's calls read once rather than
   * once per stop. Never rejects.
   */
  getLineDepartureBoards(
    stopIds: readonly string[],
    request: LineDepartureBoardsRequest,
  ): Promise<DepartureBoard[]>;
  /**
   * A line-direction's route as local stop ids, addressed through one of its rows; kept for the
   * session. `undefined` where it could not be read.
   */
  getLineRoute(rowId: string): Promise<readonly string[] | undefined>;
  /**
   * One departure's complete calls, carrying the instant they were read so a cached reading is not
   * restated as fresh. `undefined` where it could not be read.
   */
  getRun(rowId: string, maxAgeMs?: number): Promise<Departure | undefined>;
  /** The synchronous half of `getRun`, from what is already read; views read runs through it. */
  findRun(rowId: string): Departure | undefined;
  /** This board with its rows as the store reads them now; the same object if nothing changed. */
  resolveBoard(board: DepartureBoard): DepartureBoard;
  /** Notifies when one of these rows' run readings changes. */
  subscribeToRuns(rowIds: readonly string[], listener: () => void): () => void;
  getRunVersion(rowIds: readonly string[]): string;
  /** Session topology learned from every live board, independent of the view that fetched it. */
  getObservedNetwork(): ObservedNetwork;
  subscribeToObservedNetwork(listener: () => void): () => void;
  /**
   * The operator's published notices. Never rejects: an unreadable feed is not "nothing reported".
   */
  getServiceNotices(): Promise<ServiceNoticeBoard>;
}

/**
 * How stale a cached board may be by default. The innermost run lifetime (`RUN_ENDED_GRACE_MS`): a
 * cached board must not outlive its rows' records in the reading store.
 */
export const DEFAULT_BOARD_MAX_AGE_MS = 30_000;
export const DEPARTURE_BOARD_CACHE_CAPACITY = 256;
/** Topology and idle observation reads reuse boards for up to thirty minutes. */
const DEPARTURE_BOARD_CACHE_MAX_AGE_MS = 30 * 60_000;
/** How long the last live board stands in for failed refreshes. */
const RETAINED_DEPARTURE_BOARD_LIMIT_MS = 10 * 60_000;
/** Notices change over days and the answer covers the whole KVV area, so they are asked rarely. */
const SERVICE_NOTICE_CACHE_TTL_MS = 15 * 60_000;
const BASIC_BOARD_CACHE_VARIANT = "basic";
const DETAILED_BOARD_CACHE_VARIANT = "with-trip-calls";
const COVERED_BOARD_CACHE_VARIANT = "covered-directions";
const LINE_BOARD_CACHE_VARIANT = "line";
/**
 * Rows per board, the main bandwidth lever. Twenty reach about ten minutes at the busiest Zentrum
 * post; filtered to one line, about forty minutes of it.
 */
const DEFAULT_DEPARTURE_LIMIT = 20;
const SERVICE_NOTICE_REQUEST_KEY = "service-notices";
/** How many local and remote matches a typed query is answered with. */
const STOP_SEARCH_LIMIT = 8;

/**
 * How soon a run's next call must be for its calls to be read. Every stop of the line is read, so a
 * vehicle under way is minutes from some row; one hours away has not set out.
 */
const RUN_UNDER_WAY_MINUTES = 30;

/** Core-network stops are local data; every other stop is resolved from KVV on request. */
export class KvvTransitSource implements TransitSource {
  /** Keyed by stop and variant. Boards date themselves. */
  private readonly departureBoardCache = new ReadingCache<DepartureBoard>(
    DEPARTURE_BOARD_CACHE_CAPACITY,
    DEPARTURE_BOARD_CACHE_MAX_AGE_MS,
  );
  private readonly boardRequests = new SharedRequests<DepartureBoard>();
  private readonly runRequests = new SharedRequests<RunSequence | undefined>();
  private readonly lineRouteRequests = new SharedRequests<readonly string[] | undefined>();
  /** One route per line-direction, kept for the session: routes are timetable data. */
  private readonly lineRoutes = new Map<string, readonly string[]>();
  private readonly noticeRequests = new SharedRequests<ServiceNoticeBoard>();
  private readonly runReadings = new RunReadingStore();
  private readonly observedNetwork = new ObservedNetworkStore();
  private readonly coverage = new DirectionCoverageCompleter();
  private readonly stops: StopRegistry;
  private serviceNoticeCache: { board: ServiceNoticeBoard; expiresAt: number } | null = null;

  private readonly client: KvvEfaClient;
  private readonly network: TransitNetwork;

  // Fields rather than constructor parameter properties, for the type-stripping test runner.
  constructor(client: KvvEfaClient = new KvvEfaClient(), network: TransitNetwork = transitNetwork) {
    this.client = client;
    this.network = network;
    this.stops = new StopRegistry(network.stops);
  }

  getNetwork(): TransitNetwork {
    return this.network;
  }

  async getRunDiscoveryReading(
    posts: readonly RunDiscoveryPost[],
    { maxAgeMs, runMaxAgeMs, topologyMaxAgeMs, horizonMs }: RunDiscoveryRequest,
  ): Promise<RunDiscoveryReading> {
    const bases = await Promise.all(
      posts.map((post) => this.getDiscoveryEventBoard(post, topologyMaxAgeMs)),
    );
    const railLines = new Set(
      bases.flatMap((board) => [
        ...(board.servingLines ?? []).flatMap(({ lineId, transportMode }) =>
          lineId && (transportMode === "tram" || transportMode === "lightRail") ? [lineId] : [],
        ),
        ...board.departures
          .filter(({ transportMode }) => transportMode === "tram" || transportMode === "lightRail")
          .map(({ lineId }) => lineId),
      ]),
    );
    const boards = (
      await Promise.all(
        bases.map((base, index) =>
          this.getDiscoveryBoards(posts[index], base, railLines, { maxAgeMs, horizonMs }),
        ),
      )
    ).flat();
    const rows = boards.flatMap((board) => board.departures);
    const rowsByRun = new Map<string, Departure>();
    for (const row of rows) {
      if (!this.runReadings.canReadRun(row.id)) continue;
      const key = this.runReadings.findRunRecordKey(row.id);
      const known = rowsByRun.get(key);
      if (!known || isBetterRunReading(row, known)) rowsByRun.set(key, row);
    }
    await Promise.all(
      [...rowsByRun.values()]
        .filter(
          (row) => railLines.has(row.lineId) && row.minutesUntilDeparture <= RUN_UNDER_WAY_MINUTES,
        )
        .map((row) => this.getRun(row.id, runMaxAgeMs)),
    );
    return {
      runDepartures: [...rowsByRun.values()].flatMap((row) => {
        const run = this.findRun(row.id);
        return run?.tripCalls?.length && railLines.has(run.lineId) ? [run] : [];
      }),
      clockBoard: boards
        .filter((board) => board.dataStatus === "live")
        .reduce<DepartureBoard | null>(
          (latest, board) => (!latest || board.receivedAt > latest.receivedAt ? board : latest),
          null,
        ),
      failedStopIds: [
        ...new Set(
          boards
            .filter((board) => board.dataStatus !== "live" || board.refreshFailedAt)
            .map(({ stopId }) => stopId),
        ),
      ],
    };
  }

  private async getDiscoveryBoards(
    post: RunDiscoveryPost,
    base: DepartureBoard,
    railLines: ReadonlySet<string>,
    { maxAgeMs, horizonMs }: Pick<RunDiscoveryRequest, "maxAgeMs" | "horizonMs">,
  ): Promise<DepartureBoard[]> {
    const directions = [
      ...new Set([
        ...(base.servingLines ?? [])
          .filter(({ lineId }) => lineId && railLines.has(lineId))
          .map(({ directionId }) => directionId),
        ...base.departures
          .filter(({ lineId }) => railLines.has(lineId))
          .flatMap(({ routeDirectionId }) => (routeDirectionId ? [routeDirectionId] : [])),
      ]),
    ];
    if (directions.length === 0) return [base];
    const filtered = await this.getDiscoveryEventBoard(post, maxAgeMs, directions);
    if (filtered.dataStatus !== "live") return [filtered, base];
    const horizon = Date.parse(filtered.feedUpdatedAt) + horizonMs;
    const limit =
      kvvStopMappingByLocalStopId[base.stopId]?.departureLimit ?? DEFAULT_DEPARTURE_LIMIT;
    let sparse: string[] = [];
    if (filtered.departures.length >= limit && directions.length > 1) {
      const covered = new Set(
        filtered.departures
          .filter(
            (row) =>
              Date.parse(row.predictedDepartureTime ?? row.scheduledDepartureTime) >= horizon,
          )
          .map(({ routeDirectionId }) => routeDirectionId),
      );
      sparse = directions.filter((direction) => !covered.has(direction));
    }
    const supplements = await Promise.all(
      sparse.map((direction) => this.getDiscoveryEventBoard(post, maxAgeMs, [direction])),
    );
    return [filtered, ...supplements];
  }

  private getDiscoveryEventBoard(
    post: RunDiscoveryPost,
    maxAgeMs: number,
    directionIds?: readonly string[],
  ): Promise<DepartureBoard> {
    if (post.eventKind === "departure") {
      return this.getDepartureBoard(post.stopId, { maxAgeMs, routeDirectionIds: directionIds });
    }
    const key = `arrival:${this.getDepartureBoardCacheKey(
      post.stopId,
      false,
      undefined,
      directionIds?.length ? createSortedKey(directionIds) : undefined,
    )}`;
    const cached = this.departureBoardCache.get(key);
    if (cached && Date.now() - cached.receivedAt < maxAgeMs)
      return Promise.resolve(this.publishBoard(cached));
    return this.boardRequests.share(key, async () => {
      const board = await this.fetchDepartureBoard(post.stopId, false, directionIds, "arrival");
      return this.retainAndPublishBoard(key, board);
    });
  }

  getKnownStop(stopId: string): TransitStop | undefined {
    return this.stops.findStop(stopId);
  }

  async resolveStop(stopId: string): Promise<TransitStop | undefined> {
    const local = this.getKnownStop(stopId);
    if (local) return local;

    // A deep link may name a stop not yet resolved, so it is searched by name; a digest pins the
    // stop point.
    const [, slug = stopId, digest] = DYNAMIC_STOP_ID_PATTERN.exec(stopId) ?? [];
    const matches = await this.client.searchStops(slug.replace(/-/g, " "));
    const match = digest
      ? matches.find((candidate) => hashProviderStopId(candidate.providerId) === digest)
      : matches[0];
    return match
      ? this.stops.register({
          providerId: match.providerId,
          name: match.name,
          placeName: match.placeName,
          preferredId: stopId,
        })
      : undefined;
  }

  /**
   * Stops matching a query, local first (no request), then provider matches inside the network
   * area. Matches are registered so their ids resolve later.
   */
  async searchStops(query: string): Promise<readonly TransitStop[]> {
    const trimmed = query.trim();
    if (trimmed.length < 2) return [];

    const normalized = trimmed.toLowerCase();
    const local = this.network.stops.filter((stop) =>
      [stop.name, stop.alias].some((name) => name?.toLowerCase().includes(normalized)),
    );

    // A failed provider read is not "nothing": answer with local matches, or fail.
    const matches = await this.client.searchStops(trimmed).catch((error) => {
      if (local.length > 0) return [];
      throw error;
    });
    const remote = matches.flatMap((match) => {
      if (match.latitude === undefined || match.longitude === undefined) return [];
      if (!isWithinKvvArea(match.latitude, match.longitude)) return [];
      return [
        this.stops.register({
          providerId: match.providerId,
          name: match.name,
          placeName: match.placeName,
          latitude: match.latitude,
          longitude: match.longitude,
        }),
      ];
    });

    const byId = new Map(local.map((stop) => [stop.id, stop]));
    for (const stop of remote) if (!byId.has(stop.id)) byId.set(stop.id, stop);
    return [...byId.values()].slice(0, STOP_SEARCH_LIMIT);
  }

  getDepartureBoard(stopId: string, request: DepartureBoardRequest = {}): Promise<DepartureBoard> {
    const includeTripCalls = Boolean(request.includeTripCalls);
    const maxAgeMs = request.maxAgeMs ?? DEFAULT_BOARD_MAX_AGE_MS;
    const coverage = readDirectionCoverage(request);
    // Sorted so callers naming the same lines in any order share one request.
    const lineFilterKey = request.routeDirectionIds?.length
      ? createSortedKey(request.routeDirectionIds)
      : undefined;
    const cacheKey = this.getDepartureBoardCacheKey(
      stopId,
      includeTripCalls,
      coverage?.key,
      lineFilterKey,
    );
    // A detailed board also answers a basic request. Filtered or coverage-completed boards never
    // stand in for the whole board.
    const reusableKeys =
      includeTripCalls || lineFilterKey || coverage
        ? [cacheKey]
        : [this.getDepartureBoardCacheKey(stopId, true), cacheKey];

    const now = Date.now();
    const cached = reusableKeys
      .map((key) => this.departureBoardCache.get(key))
      .find((board) => board && now - board.receivedAt < maxAgeMs);
    if (cached) return Promise.resolve(this.publishBoard(cached));

    const pending = this.boardRequests.find(...reusableKeys);
    if (pending) return pending.then((board) => this.publishBoard(board));

    return this.boardRequests.share(cacheKey, () =>
      (coverage
        ? this.fetchDirectionCoveredBoard(stopId, request.maxAgeMs, coverage)
        : this.fetchDepartureBoard(stopId, includeTripCalls, request.routeDirectionIds)
      ).then((fetched) => this.retainAndPublishBoard(cacheKey, fetched)),
    );
  }

  async getLineDepartureBoards(
    stopIds: readonly string[],
    { routeDirectionIds, maxAgeMs, runMaxAgeMs = maxAgeMs }: LineDepartureBoardsRequest,
  ): Promise<DepartureBoard[]> {
    // Rows only: a direction-filtered board needs no mode macros and so no calling sequences, about
    // a fifth of a detailed board.
    const boards = await Promise.all(
      stopIds.map((stopId) => this.getDepartureBoard(stopId, { routeDirectionIds, maxAgeMs })),
    );

    // One request per run, not per row. Grouped by record key, since filtered rows carry no calls.
    const rows = boards.flatMap((board) => board.departures);
    const rowByRunRecordKey = new Map<string, Departure>();
    for (const row of rows) {
      if (!this.runReadings.canReadRun(row.id)) continue;
      const recordKey = this.runReadings.findRunRecordKey(row.id);
      const known = rowByRunRecordKey.get(recordKey);
      if (!known || isBetterRunReading(row, known)) rowByRunRecordKey.set(recordKey, row);
    }
    const activeRunRecordKeys = new Set(
      rows
        .filter((row) => row.minutesUntilDeparture <= RUN_UNDER_WAY_MINUTES)
        .map((row) => this.runReadings.findRunRecordKey(row.id)),
    );
    await Promise.all(
      [...rowByRunRecordKey]
        .filter(([recordKey]) => activeRunRecordKeys.has(recordKey))
        .map(([, row]) => this.getRun(row.id, runMaxAgeMs).catch(() => undefined)),
    );

    // Published again so each row carries its run's sequence.
    return boards.map((board) => this.publishBoard(board));
  }

  getLineRoute(rowId: string): Promise<readonly string[] | undefined> {
    const locator = this.runReadings.findRow(rowId)?.locator;
    if (!locator) return Promise.resolve(undefined);
    // Every run of a direction has the same route.
    const kept = this.lineRoutes.get(locator.line);
    if (kept) return Promise.resolve(kept);

    return (
      this.lineRouteRequests.find(locator.line) ??
      this.lineRouteRequests.share(locator.line, () =>
        this.client
          .fetchLineRoute(locator)
          .then((route) => {
            // Resolved through the registry, so a stop first met along a line gets its own page.
            const stopIds = [
              ...new Set(
                this.stops
                  .toTripCalls(route)
                  .map(({ localStopId }) => localStopId)
                  .filter((stopId): stopId is string => Boolean(stopId)),
              ),
            ];
            if (stopIds.length > 0) this.lineRoutes.set(locator.line, stopIds);
            return stopIds;
          })
          // Asked again next time; the reading falls back to the runs in hand.
          .catch(() => undefined),
      )
    );
  }

  /** This row completed by its run; both halves keep their own clock (`readAt`). */
  getRun(rowId: string, maxAgeMs = DEFAULT_BOARD_MAX_AGE_MS): Promise<Departure | undefined> {
    const row = this.runReadings.findRow(rowId);
    if (!row || !this.runReadings.canReadRun(rowId)) return Promise.resolve(undefined);
    const cached = this.runReadings.findSequence(rowId)?.sequence;
    const current = () => (cached ? this.findRun(rowId) : undefined);

    // Without a locator the board's own sequence is the only reading.
    if (!row.locator) return Promise.resolve(current());

    // Rows of a run share one record and request. Staleness is the calls' own clock, not the row's.
    const readAt = cached?.readAt;
    if (readAt !== undefined && Date.now() - readAt < maxAgeMs) return Promise.resolve(current());
    const read =
      this.runRequests.find(this.runReadings.findRunRecordKey(rowId)) ??
      this.requestRun(rowId, row.locator);
    // A failed read answers nothing, so the caller backs off.
    return read.then((sequence) => (sequence ? this.findRun(rowId) : undefined));
  }

  findRun(rowId: string): Departure | undefined {
    return this.runReadings.findRun(rowId);
  }

  subscribeToRuns(rowIds: readonly string[], listener: () => void): () => void {
    return this.runReadings.subscribe(rowIds, listener);
  }

  getRunVersion(rowIds: readonly string[]): string {
    return this.runReadings.getVersion(rowIds);
  }

  getObservedNetwork(): ObservedNetwork {
    return this.observedNetwork.getSnapshot();
  }

  subscribeToObservedNetwork(listener: () => void): () => void {
    return this.observedNetwork.subscribe(listener);
  }

  getServiceNotices(): Promise<ServiceNoticeBoard> {
    const cached = this.serviceNoticeCache;
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.board);

    return (
      this.noticeRequests.find(SERVICE_NOTICE_REQUEST_KEY) ??
      this.noticeRequests.share(SERVICE_NOTICE_REQUEST_KEY, () =>
        this.fetchServiceNotices().then((board) => {
          // Only live readings are cached.
          if (board.dataStatus === "live") {
            this.serviceNoticeCache = {
              board,
              expiresAt: Date.now() + SERVICE_NOTICE_CACHE_TTL_MS,
            };
          }
          return board;
        }),
      )
    );
  }

  private async fetchServiceNotices(): Promise<ServiceNoticeBoard> {
    try {
      const notices = await this.client.fetchServiceNotices();
      return {
        dataStatus: "live",
        receivedAt: Date.now(),
        notices: notices.map((notice) => this.toServiceNotice(notice)),
      };
    } catch (error) {
      return {
        dataStatus: "unavailable",
        receivedAt: Date.now(),
        notices: [],
        errorMessage: error instanceof Error ? error.message : "Betriebsmeldungen nicht erreichbar",
      };
    }
  }

  /** A notice with stop ids resolved to our stop pages; unknown stops stay names. */
  private toServiceNotice(notice: KvvServiceNotice): ServiceNotice {
    const stopIds = notice.concernedStops.flatMap(
      (stop) => (stop.providerId && this.stops.findLocalStopId(stop.providerId)) || [],
    );
    return {
      id: notice.id,
      title: notice.title,
      lineIds: notice.lineNumbers,
      stopIds: [...new Set(stopIds)],
      stopNames: [...new Set(notice.concernedStops.map((stop) => stop.name))],
      details: notice.details,
      validFrom: notice.validFrom,
      validUntil: notice.validUntil,
      priority: notice.priority,
    };
  }

  private async fetchDepartureBoard(
    stopId: string,
    includeTripCalls: boolean,
    lineIds?: readonly string[],
    eventKind: "departure" | "arrival" = "departure",
  ): Promise<DepartureBoard> {
    const providerId = this.stops.findProviderStopId(stopId);
    if (!providerId)
      return this.createUnavailableDepartureBoard(
        stopId,
        "Haltestelle konnte im KVV-Netz nicht aufgelöst werden",
      );

    try {
      const board = await this.client.fetchDepartureBoard(providerId, {
        includeTripCalls,
        limit: kvvStopMappingByLocalStopId[stopId]?.departureLimit ?? DEFAULT_DEPARTURE_LIMIT,
        ...(lineIds?.length ? { lineIds } : {}),
        ...(eventKind === "arrival" ? { eventKind } : {}),
      });
      const receivedAt = Date.now();
      // A filtered board saw only its lines, so it is never recorded as the stop's serving
      // directions.
      const isWholeStop = !lineIds?.length;
      if (isWholeStop && eventKind === "departure") {
        this.coverage.rememberServingDirections(
          stopId,
          board.servingLines.map(({ directionId }) => directionId),
        );
      }
      return {
        stopId,
        dataStatus: "live",
        feedUpdatedAt: board.serverTime,
        receivedAt,
        ...(isWholeStop ? { servingLines: board.servingLines } : {}),
        // Published in expected-departure order, not the feed's schedule order.
        departures: sortDeparturesByExpectedInstant(
          keepOneRowPerRun(
            board.departures.map((departure) =>
              this.toDeparture(departure, stopId, receivedAt, eventKind),
            ),
          ),
          Date.parse(board.serverTime) || undefined,
        ),
      };
    } catch (error) {
      return this.createUnavailableDepartureBoard(
        stopId,
        error instanceof Error ? error.message : "Feed nicht erreichbar",
      );
    }
  }

  /** The stop's board completed for sparse directions (`direction-coverage.ts`). */
  private async fetchDirectionCoveredBoard(
    stopId: string,
    maxAgeMs: number | undefined,
    coverage: DirectionCoverage,
  ): Promise<DepartureBoard> {
    const base = await this.getDepartureBoard(stopId, { maxAgeMs });
    if (base.dataStatus !== "live") return base;

    const providerId = this.stops.findProviderStopId(stopId);
    if (!providerId) return base;

    return this.coverage.complete(base, coverage, async (lineIds, limit) => {
      const supplement = await this.client.fetchDepartureBoard(providerId, { lineIds, limit });
      const receivedAt = Date.now();
      return {
        departures: supplement.departures.map((departure) =>
          this.toDeparture(departure, stopId, receivedAt),
        ),
        rowLimitReached: supplement.departures.length >= limit,
      };
    });
  }

  private getDepartureBoardCacheKey(
    stopId: string,
    includeTripCalls: boolean,
    directionCoverageKey?: string,
    lineFilterKey?: string,
  ): string {
    const variant = directionCoverageKey
      ? `${COVERED_BOARD_CACHE_VARIANT}:${directionCoverageKey}`
      : includeTripCalls
        ? DETAILED_BOARD_CACHE_VARIANT
        : BASIC_BOARD_CACHE_VARIANT;
    return lineFilterKey
      ? `${stopId}:${LINE_BOARD_CACHE_VARIANT}:${lineFilterKey}:${variant}`
      : `${stopId}:${variant}`;
  }

  private createUnavailableDepartureBoard(stopId: string, error: string): DepartureBoard {
    return {
      stopId,
      dataStatus: "unavailable",
      receivedAt: Date.now(),
      departures: [],
      errorMessage: error,
    };
  }

  resolveBoard(board: DepartureBoard): DepartureBoard {
    if (board.dataStatus !== "live") return board;
    const departures = board.departures.map((row) => this.findRun(row.id) ?? row);
    return departures.every((departure, index) => departure === board.departures[index])
      ? board
      : { ...board, departures };
  }

  private retainAndPublishBoard(cacheKey: string, fetched: DepartureBoard): DepartureBoard {
    if (fetched.dataStatus === "live") {
      this.departureBoardCache.set(cacheKey, fetched, fetched.receivedAt);
      return this.publishBoard(fetched);
    }
    const lastLive = this.departureBoardCache.get(cacheKey);
    return lastLive?.dataStatus === "live" &&
      fetched.receivedAt - lastLive.receivedAt <= RETAINED_DEPARTURE_BOARD_LIMIT_MS
      ? this.publishBoard({ ...lastLive, refreshFailedAt: fetched.receivedAt })
      : fetched;
  }

  /** Every board is resolved through the store and teaches session topology on its way out. */
  private publishBoard(board: DepartureBoard): DepartureBoard {
    const published = this.resolveBoard(board);
    if (published.dataStatus === "live") this.observedNetwork.rememberBoard(published);
    return published;
  }

  private toDeparture(
    departure: KvvDeparture,
    stopId: string,
    receivedAt: number,
    eventKind: "departure" | "arrival" = "departure",
  ): Departure {
    // A board can cover several stop points; each row keeps the one it leaves from, so it can match
    // its own call in the sequence.
    const departureStopId = this.stops.findLocalStopId(departure.stopPointId) ?? stopId;
    const rowId = createDepartureId(departure, departureStopId);
    const id = eventKind === "arrival" ? `arrival:${rowId}` : rowId;
    const tripCalls = departure.tripCalls && this.stops.toTripCalls(departure.tripCalls);
    const mapped: Departure = {
      id,
      tripId: departure.tripId,
      tripInstanceId: departure.tripInstanceId,
      trainNumber: departure.trainNumber,
      lineId: departure.lineId,
      routeDirectionId: departure.routeDirectionId,
      transportMode: departure.transportMode,
      destination: departure.destination,
      minutesUntilDeparture: departure.minutesUntilDeparture,
      delayMinutes: departure.delayMinutes,
      platformCode: departure.platformCode,
      platformKind: departure.platformKind,
      boardingLocalStopId: departureStopId,
      boardingProviderStopPointId: departure.stopPointId,
      boardingProviderStopPointName: departure.stopPointName,
      status: departure.status,
      scheduledDepartureTime: departure.scheduledDepartureTime,
      predictedDepartureTime: departure.predictedDepartureTime,
      serviceNote: departure.serviceNote,
      vehicleAccess: departure.vehicleAccess,
      tripCalls,
      // Dated here, once. A row without calls gets no sequence clock.
      readAt: {
        rowReadAt: receivedAt,
        ...(tripCalls?.length ? { sequenceReadAt: receivedAt } : {}),
      },
    };
    this.runReadings.rememberRow(mapped, departure.tripLocator, receivedAt);
    return mapped;
  }

  private requestRun(rowId: string, locator: KvvTripLocator): Promise<RunSequence | undefined> {
    const requestKey = this.runReadings.findRunRecordKey(rowId);
    return this.runRequests.share(requestKey, () =>
      this.client
        .fetchTrip(locator)
        .then((trip) => {
          const receivedAt = Date.now();
          const sequence = this.createSequenceReading(requestKey, trip, receivedAt);
          // An answer whose record was evicted is reported as a failure (`rememberSequence`).
          return sequence && this.runReadings.rememberSequence(requestKey, sequence, receivedAt)
            ? sequence
            : undefined;
        })
        // Only readable runs are kept.
        .catch(() => undefined),
    );
  }

  /**
   * A single-run response as this run's calls at this instant. The row supplies only the timetable
   * trip for the dated id; the reading is shared by every stop of the run.
   */
  private createSequenceReading(
    runKey: string,
    trip: KvvTrip,
    receivedAt: number,
  ): RunSequence | undefined {
    const departure = this.runReadings.findRunRow(runKey)?.departure;
    if (!departure) return undefined;
    const tripCalls = this.stops.toTripCalls(trip.tripCalls);
    const tripInstanceId =
      getTripInstanceId(departure.tripId, tripCalls) ?? departure.tripInstanceId;
    return {
      tripCalls,
      // Derived as a board derives it, so one run gets one dated id.
      ...(tripInstanceId ? { tripInstanceId } : {}),
      status: trip.status ?? departure.status,
      // The calls' own clock.
      readAt: receivedAt,
    };
  }
}

export const transitSource: TransitSource = new KvvTransitSource();
