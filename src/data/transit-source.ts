import { transitNetwork } from "./transit-network";
import { readTriasProxyUrl } from "./trias-proxy";
import { TriasClient } from "./trias-client";
import { network } from "../networks/network";
import { isWithinScopeBounds } from "./network-scope";
import {
  fetchStopPlaceBoard,
  type FeedStopEventBoard,
  type FeedStopEventBoardOptions,
  type FeedStopEvent,
  type Feed,
  type FeedTripInfo,
  type DatedJourneyRef,
  type RowCallRef,
} from "./feed";
import type {
  StopEventBoard,
  StopEventBoardRequest,
  StopEvent,
  DatedJourneyCalls,
  StopPlace,
  TransitNetwork,
  DatedJourneyDiscoveryPost,
  DatedJourneyDiscoveryReading,
} from "./transit-types";
import { DatedJourneyReadingStore } from "./dated-journey-reading-store";
import { StopEventBoardReadings, unavailableStopEventBoard } from "./stop-event-board-readings";
export { STOP_EVENT_BOARD_CACHE_CAPACITY } from "./stop-event-board-readings";
import {
  DirectionCoverageCompleter,
  readDirectionCoverage,
  type DirectionCoverage,
} from "./direction-coverage";
import { createStopEventId, keepOneRowPerDatedJourney } from "./stop-event-dated-journeys";
import { SharedRequests } from "./request-sharing";
import { DYNAMIC_STOP_ID_PATTERN, StopRegistry, hashProviderStopId } from "./stop-registry";
import { ServingDirections } from "./serving-directions";
import { sortStopEventsByExpectedInstant } from "../lib/stop-event-order";
import { isBetterDatedJourneyReading } from "../lib/journeys";
import { createSortedKey } from "../lib/collections";
import { ObservedNetworkStore } from "./observed-network-store";
import type { ObservedNetwork } from "../lib/observed-network";

export type { StopEventBoardRequest };

/** What a line's own reading is asked for: which directions, and how stale an answer may be. */
export type LineStopEventBoardsRequest = {
  /** The provider's per-direction ids. Required: this reading is only ever one line's. */
  lineRefs: readonly string[];
  maxAgeMs?: number;
  /**
   * How stale the dated journeys' own re-reads may be, apart from `maxAgeMs`: the feed revises
   * dated journeys about every 35 s, and a dated journey read is a fraction of a board's size.
   */
  datedJourneyMaxAgeMs?: number;
};
export type DatedJourneyDiscoveryRequest = {
  maxAgeMs: number;
  datedJourneyMaxAgeMs: number;
  topologyMaxAgeMs: number;
  horizonMs: number;
};
export { createStopEventId };

/**
 * The boundary the views talk to. Nothing above it knows about TRIAS, provider ids or HTTP.
 */
export interface TransitSource {
  getDatedJourneyDiscoveryReading(
    posts: readonly DatedJourneyDiscoveryPost[],
    options: DatedJourneyDiscoveryRequest,
  ): Promise<DatedJourneyDiscoveryReading>;
  /** Stops and lines: the local identities views address. */
  getNetwork(): TransitNetwork;
  /** Resolves both local core-network stops and any stop exposed by the KVV network. */
  resolveStop(stopId: string): Promise<StopPlace | undefined>;
  /**
   * `resolveStop` without the wait, for stops the session has already met, so a view need not
   * render a loading state for a stop it knows. `undefined` means only "not met yet".
   */
  getKnownStop(stopId: string): StopPlace | undefined;
  /** Stops matching a query. Rejects when the provider failed and nothing local matched. */
  searchStops(query: string): Promise<readonly StopPlace[]>;
  /** One stop's live board. Never rejects: failures resolve to an explicit unavailable state. */
  getStopEventBoard(stopId: string, request?: StopEventBoardRequest): Promise<StopEventBoard>;
  /**
   * Several stops of one line: rows from filtered boards, each dated journey's calls read once
   * rather than once per stop. Never rejects.
   */
  getLineStopEventBoards(
    stopIds: readonly string[],
    request: LineStopEventBoardsRequest,
  ): Promise<StopEventBoard[]>;
  /**
   * A line-direction's route as local stop ids, addressed through one of its rows; kept for the
   * session. `undefined` where it could not be read.
   */
  getLineRoute(rowId: string): Promise<readonly string[] | undefined>;
  /**
   * One departure's complete calls, carrying the instant they were read so a cached reading is not
   * restated as fresh. `undefined` where it could not be read.
   */
  getDatedJourney(rowId: string, maxAgeMs?: number): Promise<StopEvent | undefined>;
  /**
   * The synchronous half of `getDatedJourney`, from what is already read; views read dated journeys
   * through it.
   */
  findDatedJourney(rowId: string): StopEvent | undefined;
  /** This board with its rows as the store reads them now; the same object if nothing changed. */
  resolveBoard(board: StopEventBoard): StopEventBoard;
  /** Notifies when one of these rows' dated journey readings changes. */
  subscribeToDatedJourneys(rowIds: readonly string[], listener: () => void): () => void;
  getDatedJourneyVersion(rowIds: readonly string[]): string;
  /** Session topology learned from every live board, independent of the view that fetched it. */
  getObservedNetwork(): ObservedNetwork;
  subscribeToObservedNetwork(listener: () => void): () => void;
}

/**
 * How stale a cached board may be by default. The innermost dated journey lifetime
 * (`DATED_JOURNEY_ENDED_GRACE_MS`): a cached board must not outlive its rows' records in the
 * reading store.
 */
export const DEFAULT_BOARD_MAX_AGE_MS = 30_000;
const BASIC_BOARD_CACHE_VARIANT = "basic";
const DETAILED_BOARD_CACHE_VARIANT = "with-trip-calls";
const COVERED_BOARD_CACHE_VARIANT = "covered-directions";
const LINE_BOARD_CACHE_VARIANT = "line";
/**
 * Rows per board, the main bandwidth lever. Twenty reach about ten minutes at the busiest Zentrum
 * post; filtered to one line, about forty minutes of it.
 */
const DEFAULT_STOP_EVENT_LIMIT = 20;
/** How many local and remote matches a typed query is answered with. */
const STOP_SEARCH_LIMIT = 8;

/**
 * How soon a dated journey's next call must be for its calls to be read. Every stop of the line is
 * read, so a vehicle under way is minutes from some row; one hours away has not set out.
 */
const DATED_JOURNEY_UNDER_WAY_MINUTES = 30;

export function createFeed(environment = import.meta.env ?? {}): Feed {
  return new TriasClient({ proxyUrl: readTriasProxyUrl(environment) });
}

/** Core-network stops are local data; every other stop is resolved from KVV on request. */
/** The dated journey a row can request, where it names both halves. */
const getDatedJourneyRef = ({
  journeyRef,
  operatingDayRef,
}: StopEvent): DatedJourneyRef | undefined =>
  journeyRef && operatingDayRef ? { journeyRef, operatingDayRef } : undefined;

export class TriasTransitSource implements TransitSource {
  private readonly boards = new StopEventBoardReadings();
  private readonly datedJourneyRequests = new SharedRequests<DatedJourneyCalls | undefined>();
  private readonly lineRouteRequests = new SharedRequests<readonly string[] | undefined>();
  /** One route per line-direction, kept for the session: routes are timetable data. */
  private readonly lineRoutes = new Map<string, readonly string[]>();
  private readonly datedJourneyReadings = new DatedJourneyReadingStore();
  private readonly observedNetwork = new ObservedNetworkStore();
  private readonly coverage = new DirectionCoverageCompleter();
  private readonly servingDirections = new ServingDirections();
  private readonly stops: StopRegistry;

  private readonly client: Feed;
  private readonly network: TransitNetwork;

  // Fields rather than constructor parameter properties, for the type-stripping test runner.
  constructor(client: Feed = createFeed(), network: TransitNetwork = transitNetwork) {
    this.client = client;
    this.network = network;
    this.stops = new StopRegistry(network.stops);
  }

  getNetwork(): TransitNetwork {
    return this.network;
  }

  async getDatedJourneyDiscoveryReading(
    posts: readonly DatedJourneyDiscoveryPost[],
    { maxAgeMs, datedJourneyMaxAgeMs, topologyMaxAgeMs, horizonMs }: DatedJourneyDiscoveryRequest,
  ): Promise<DatedJourneyDiscoveryReading> {
    const bases = await Promise.all(
      posts.map((post) => this.getDiscoveryEventBoard(post, topologyMaxAgeMs)),
    );
    const railLines = new Set(
      bases.flatMap((board) => [
        ...(board.servingLines ?? []).flatMap(({ lineId, ptMode }) =>
          lineId && (ptMode === "tram" || ptMode === "lightRail") ? [lineId] : [],
        ),
        ...board.stopEvents
          .filter(({ ptMode }) => ptMode === "tram" || ptMode === "lightRail")
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
    const rows = boards.flatMap((board) => board.stopEvents);
    const rowsByDatedJourney = new Map<string, StopEvent>();
    for (const row of rows) {
      if (!this.datedJourneyReadings.canReadDatedJourney(row.id)) continue;
      const key = this.datedJourneyReadings.findJourneyRecordKey(row.id);
      const known = rowsByDatedJourney.get(key);
      if (!known || isBetterDatedJourneyReading(row, known)) rowsByDatedJourney.set(key, row);
    }
    await Promise.all(
      [...rowsByDatedJourney.values()]
        .filter(
          (row) =>
            railLines.has(row.lineId) &&
            row.minutesUntilDeparture <= DATED_JOURNEY_UNDER_WAY_MINUTES,
        )
        .map((row) => this.getDatedJourney(row.id, datedJourneyMaxAgeMs)),
    );
    return {
      datedJourneyStopEvents: [...rowsByDatedJourney.values()].flatMap((row) => {
        const datedJourney = this.findDatedJourney(row.id);
        return datedJourney?.calls?.length && railLines.has(datedJourney.lineId)
          ? [datedJourney]
          : [];
      }),
      clockBoard: boards
        .filter((board) => board.dataStatus === "live")
        .reduce<StopEventBoard | null>(
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
    post: DatedJourneyDiscoveryPost,
    base: StopEventBoard,
    railLines: ReadonlySet<string>,
    { maxAgeMs, horizonMs }: Pick<DatedJourneyDiscoveryRequest, "maxAgeMs" | "horizonMs">,
  ): Promise<StopEventBoard[]> {
    const directions = [
      ...new Set([
        ...(base.servingLines ?? [])
          .filter(({ lineId }) => lineId && railLines.has(lineId))
          .map(({ lineRef }) => lineRef),
        ...base.stopEvents
          .filter(({ lineId }) => railLines.has(lineId))
          .flatMap(({ lineRef }) => (lineRef ? [lineRef] : [])),
      ]),
    ];
    if (directions.length === 0) return [base];
    const filtered = await this.getDiscoveryEventBoard(post, maxAgeMs, directions);
    if (filtered.dataStatus !== "live") return [filtered, base];
    const horizon = Date.parse(filtered.feedUpdatedAt) + horizonMs;
    let sparse: string[] = [];
    if (filtered.stopEvents.length >= DEFAULT_STOP_EVENT_LIMIT && directions.length > 1) {
      const covered = new Set(
        filtered.stopEvents
          .filter(
            (row) =>
              Date.parse(row.estimatedDepartureTime ?? row.timetabledDepartureTime) >= horizon,
          )
          .map(({ lineRef }) => lineRef),
      );
      sparse = directions.filter((direction) => !covered.has(direction));
    }
    const supplements = await Promise.all(
      sparse.map((direction) => this.getDiscoveryEventBoard(post, maxAgeMs, [direction])),
    );
    return [filtered, ...supplements];
  }

  private getDiscoveryEventBoard(
    post: DatedJourneyDiscoveryPost,
    maxAgeMs: number,
    lineRefs?: readonly string[],
  ): Promise<StopEventBoard> {
    if (post.eventKind === "departure") {
      return this.getStopEventBoard(post.stopId, { maxAgeMs, lineRefs });
    }
    const key = `arrival:${this.getStopEventBoardCacheKey(
      post.stopId,
      false,
      undefined,
      lineRefs?.length ? createSortedKey(lineRefs) : undefined,
    )}`;
    return this.boards
      .get(key, { maxAgeMs }, () =>
        this.fetchStopEventBoard(post.stopId, false, lineRefs, "arrival"),
      )
      .then((board) => this.publishBoard(board));
  }

  getKnownStop(stopId: string): StopPlace | undefined {
    return this.stops.findStop(stopId);
  }

  async resolveStop(stopId: string): Promise<StopPlace | undefined> {
    const local = this.getKnownStop(stopId);
    if (local) return local;

    // A deep link's digest pins the stop point; the name only supplies the search query.
    const [, slug, digest] = DYNAMIC_STOP_ID_PATTERN.exec(stopId) ?? [];
    if (!slug || !digest) return undefined;
    const matches = await this.client.searchStops(slug.replace(/-/g, " "));
    const match = matches.find((candidate) => hashProviderStopId(candidate.providerId) === digest);
    return match
      ? this.stops.register({
          providerId: match.providerId,
          name: match.name,
          placeName: match.placeName,
          latitude: match.latitude,
          longitude: match.longitude,
          preferredId: stopId,
        })
      : undefined;
  }

  /**
   * Stops matching a query, local first (no request), then provider matches inside the network
   * area. Matches are registered so their ids resolve later.
   */
  async searchStops(query: string): Promise<readonly StopPlace[]> {
    const trimmed = query.trim();
    if (trimmed.length < 2) return [];

    const normalized = trimmed.toLowerCase();
    const local = this.network.stops.filter((stop) =>
      [stop.name, stop.alias].some((name) => name?.toLowerCase().includes(normalized)),
    );

    // A failed provider read is not "nothing": answer with local matches, or fail.
    const matches = await this.client.searchStops(trimmed).catch((error) => {
      if (local.length > 0) return undefined;
      throw error;
    });
    if (!matches) return local.slice(0, STOP_SEARCH_LIMIT);
    const remote = matches.flatMap((match) => {
      if (match.latitude === undefined || match.longitude === undefined) return [];
      if (!isWithinScopeBounds(network.scope, match.latitude, match.longitude)) return [];
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

  getStopEventBoard(stopId: string, request: StopEventBoardRequest = {}): Promise<StopEventBoard> {
    const includeCalls = Boolean(request.includeCalls);
    const maxAgeMs = request.maxAgeMs ?? DEFAULT_BOARD_MAX_AGE_MS;
    const coverage = readDirectionCoverage(request);
    // Sorted so callers naming the same lines in any order share one request.
    const lineFilterKey = request.lineRefs?.length ? createSortedKey(request.lineRefs) : undefined;
    const { stopPointId } = request;
    // One part's board is cached apart from the place's.
    const cacheStopId = stopPointId ? `${stopId}@${stopPointId}` : stopId;
    const cacheKey = this.getStopEventBoardCacheKey(
      cacheStopId,
      includeCalls,
      coverage?.key,
      lineFilterKey,
    );
    // A detailed board also answers a basic request. Filtered or coverage-completed boards never
    // stand in for the whole board.
    const reusableKeys =
      includeCalls || lineFilterKey || coverage
        ? [cacheKey]
        : [this.getStopEventBoardCacheKey(cacheStopId, true), cacheKey];

    return this.boards
      .get(cacheKey, { maxAgeMs, reusableKeys }, () =>
        coverage
          ? this.fetchDirectionCoveredBoard(stopId, request.maxAgeMs, coverage, stopPointId)
          : this.fetchStopEventBoard(
              stopId,
              includeCalls,
              request.lineRefs,
              "departure",
              stopPointId,
            ),
      )
      .then((board) => this.publishBoard(board));
  }

  async getLineStopEventBoards(
    stopIds: readonly string[],
    { lineRefs, maxAgeMs, datedJourneyMaxAgeMs = maxAgeMs }: LineStopEventBoardsRequest,
  ): Promise<StopEventBoard[]> {
    // Rows only: a direction-filtered board needs no mode macros and so no calling sequences, about
    // a fifth of a detailed board.
    const boards = await Promise.all(
      stopIds.map((stopId) => this.getStopEventBoard(stopId, { lineRefs, maxAgeMs })),
    );

    // One request per dated journey, not per row. Grouped by record key, since filtered rows carry
    // no calls.
    const rows = boards.flatMap((board) => board.stopEvents);
    const rowByDatedJourneyRecordKey = new Map<string, StopEvent>();
    for (const row of rows) {
      if (!this.datedJourneyReadings.canReadDatedJourney(row.id)) continue;
      const recordKey = this.datedJourneyReadings.findJourneyRecordKey(row.id);
      const known = rowByDatedJourneyRecordKey.get(recordKey);
      if (!known || isBetterDatedJourneyReading(row, known))
        rowByDatedJourneyRecordKey.set(recordKey, row);
    }
    const activeDatedJourneyRecordKeys = new Set(
      rows
        .filter((row) => row.minutesUntilDeparture <= DATED_JOURNEY_UNDER_WAY_MINUTES)
        .map((row) => this.datedJourneyReadings.findJourneyRecordKey(row.id)),
    );
    await Promise.all(
      [...rowByDatedJourneyRecordKey]
        .filter(([recordKey]) => activeDatedJourneyRecordKeys.has(recordKey))
        .map(([, row]) =>
          this.getDatedJourney(row.id, datedJourneyMaxAgeMs).catch(() => undefined),
        ),
    );

    // Published again so each row carries its dated journey's sequence.
    return boards.map((board) => this.publishBoard(board));
  }

  getLineRoute(rowId: string): Promise<readonly string[] | undefined> {
    const stopEvent = this.datedJourneyReadings.findRow(rowId)?.stopEvent;
    const journey = stopEvent && getDatedJourneyRef(stopEvent);
    const lineRef = stopEvent?.lineRef;
    if (!journey || !lineRef) return Promise.resolve(undefined);
    // Every dated journey of a direction has the same route.
    const kept = this.lineRoutes.get(lineRef);
    if (kept) return Promise.resolve(kept);

    return (
      this.lineRouteRequests.find(lineRef) ??
      this.lineRouteRequests.share(lineRef, () =>
        this.client
          .fetchLineRoute(journey)
          .then((route) => {
            // Resolved through the registry, so a stop first met along a line gets its own page.
            const stopIds = [
              ...new Set(
                this.stops
                  .toCalls(route)
                  .map(({ localStopId }) => localStopId)
                  .filter((stopId): stopId is string => Boolean(stopId)),
              ),
            ];
            if (stopIds.length > 0) this.lineRoutes.set(lineRef, stopIds);
            return stopIds;
          })
          // Asked again next time; the reading falls back to the dated journeys in hand.
          .catch(() => undefined),
      )
    );
  }

  /** This row completed by its dated journey; both halves keep their own clock (`readAt`). */
  getDatedJourney(
    rowId: string,
    maxAgeMs = DEFAULT_BOARD_MAX_AGE_MS,
  ): Promise<StopEvent | undefined> {
    const row = this.datedJourneyReadings.findRow(rowId);
    if (!row || !this.datedJourneyReadings.canReadDatedJourney(rowId))
      return Promise.resolve(undefined);
    const cached = this.datedJourneyReadings.findSequence(rowId);
    const current = () => (cached ? this.findDatedJourney(rowId) : undefined);

    // Without its journey and day the dated journey cannot be requested, and a board's calls are
    // not its reading.
    const journey = getDatedJourneyRef(row.stopEvent);
    if (!journey) return Promise.resolve(undefined);

    // Rows of a dated journey share one record and request. Staleness is the calls' own clock, not
    // the row's.
    const readAt = cached?.readAt;
    if (readAt !== undefined && Date.now() - readAt < maxAgeMs) return Promise.resolve(current());
    const read =
      this.datedJourneyRequests.find(this.datedJourneyReadings.findJourneyRecordKey(rowId)) ??
      this.requestDatedJourney(rowId, journey, {
        stopPointId: row.stopEvent.boardingProviderStopPointId,
        timetabledTime: row.stopEvent.timetabledDepartureTime,
      });
    // A failed read answers nothing, so the caller backs off.
    return read.then((sequence) => (sequence ? this.findDatedJourney(rowId) : undefined));
  }

  findDatedJourney(rowId: string): StopEvent | undefined {
    return this.datedJourneyReadings.findDatedJourney(rowId);
  }

  subscribeToDatedJourneys(rowIds: readonly string[], listener: () => void): () => void {
    return this.datedJourneyReadings.subscribe(rowIds, listener);
  }

  getDatedJourneyVersion(rowIds: readonly string[]): string {
    return this.datedJourneyReadings.getVersion(rowIds);
  }

  getObservedNetwork(): ObservedNetwork {
    return this.observedNetwork.getSnapshot();
  }

  subscribeToObservedNetwork(listener: () => void): () => void {
    return this.observedNetwork.subscribe(listener);
  }

  private async fetchStopEventBoard(
    stopId: string,
    includeCalls: boolean,
    lineIds?: readonly string[],
    eventKind: "departure" | "arrival" = "departure",
    stopPointId?: string,
  ): Promise<StopEventBoard> {
    if (this.stops.findStopPoints(stopId).length === 0)
      return unavailableStopEventBoard(
        stopId,
        `Haltestelle konnte im ${network.operator.name}-Netz nicht aufgelöst werden`,
      );

    try {
      const board = await this.readStopPlace(
        stopId,
        {
          includeCalls,
          ...(lineIds?.length ? { lineIds } : {}),
          ...(eventKind === "arrival" ? { eventKind } : {}),
        },
        stopPointId,
      );
      const receivedAt = Date.now();
      const stopEvents = board.stopEvents.map((stopEvent) =>
        this.toStopEvent(stopEvent, stopId, receivedAt, eventKind),
      );
      this.servingDirections.remember(stopEvents, receivedAt);
      // A filtered or one-part board saw only some lines, so it never states the stop's serving
      // directions.
      const isWholeStop = !lineIds?.length && !stopPointId;
      const servingLines = isWholeStop ? this.servingDirections.find(stopId) : [];
      if (isWholeStop && eventKind === "departure" && servingLines.length > 0) {
        this.coverage.rememberServingDirections(
          stopId,
          servingLines.map(({ lineRef }) => lineRef),
        );
      }
      return {
        stopId,
        dataStatus: "live",
        feedUpdatedAt: board.serverTime,
        receivedAt,
        ...(isWholeStop ? { servingLines } : {}),
        // Published in expected-departure order, not the feed's schedule order.
        stopEvents: sortStopEventsByExpectedInstant(
          keepOneRowPerDatedJourney(stopEvents),
          Date.parse(board.serverTime),
        ),
      };
    } catch (error) {
      return unavailableStopEventBoard(
        stopId,
        error instanceof Error ? error.message : "Feed nicht erreichbar",
      );
    }
  }

  /**
   * What the feed states the stop serves, and what dated journeys read this session were seen to
   * serve.
   */

  /** The stop's board completed for sparse directions (`direction-coverage.ts`). */
  private async fetchDirectionCoveredBoard(
    stopId: string,
    maxAgeMs: number | undefined,
    coverage: DirectionCoverage,
    stopPointId?: string,
  ): Promise<StopEventBoard> {
    const base = await this.getStopEventBoard(stopId, { maxAgeMs, stopPointId });
    if (base.dataStatus !== "live") return base;

    if (this.stops.findStopPoints(stopId).length === 0) return base;

    return this.coverage.complete(base, coverage, async (lineIds, limit) => {
      const supplement = await this.readStopPlace(stopId, { lineIds, limit }, stopPointId);
      const receivedAt = Date.now();
      return {
        stopEvents: supplement.stopEvents.map((stopEvent) =>
          this.toStopEvent(stopEvent, stopId, receivedAt),
        ),
        rowLimitReached: supplement.stopEvents.length >= limit,
      };
    });
  }

  /** The place's board, or one of its stop points' alone. */
  private readStopPlace(
    stopId: string,
    { limit = DEFAULT_STOP_EVENT_LIMIT, ...options }: FeedStopEventBoardOptions,
    stopPointId?: string,
  ): Promise<FeedStopEventBoard> {
    const stopPoints = this.stops.findStopPoints(stopId);
    const read = stopPointId && stopPoints.includes(stopPointId) ? [stopPointId] : stopPoints;
    return fetchStopPlaceBoard(this.client, read, {
      ...options,
      limit,
    });
  }

  private getStopEventBoardCacheKey(
    stopId: string,
    includeCalls: boolean,
    directionCoverageKey?: string,
    lineFilterKey?: string,
  ): string {
    const variant = directionCoverageKey
      ? `${COVERED_BOARD_CACHE_VARIANT}:${directionCoverageKey}`
      : includeCalls
        ? DETAILED_BOARD_CACHE_VARIANT
        : BASIC_BOARD_CACHE_VARIANT;
    return lineFilterKey
      ? `${stopId}:${LINE_BOARD_CACHE_VARIANT}:${lineFilterKey}:${variant}`
      : `${stopId}:${variant}`;
  }

  resolveBoard(board: StopEventBoard): StopEventBoard {
    if (board.dataStatus !== "live") return board;
    // A row keeps its board's calls as that board's observation until its dated journey has been
    // requested.
    const stopEvents = board.stopEvents.map((row) =>
      this.datedJourneyReadings.findSequence(row.id) ? (this.findDatedJourney(row.id) ?? row) : row,
    );
    if (stopEvents.every((stopEvent, index) => stopEvent === board.stopEvents[index])) return board;
    return { ...board, stopEvents };
  }

  private publishBoard(board: StopEventBoard): StopEventBoard {
    const published = this.resolveBoard(board);
    this.observedNetwork.rememberBoard(published);
    return published;
  }

  private toStopEvent(
    stopEvent: FeedStopEvent,
    stopId: string,
    receivedAt: number,
    eventKind: "departure" | "arrival" = "departure",
  ): StopEvent {
    // A board can cover several stop points; each row keeps the one it leaves from, so it can match
    // its own call in the sequence.
    const eventStopId = this.stops.findLocalStopId(stopEvent.stopPointId) ?? stopId;
    const rowId = createStopEventId(stopEvent, eventStopId);
    const id = eventKind === "arrival" ? `arrival:${rowId}` : rowId;
    const calls = stopEvent.calls && this.stops.toCalls(stopEvent.calls);
    const mapped: StopEvent = {
      id,
      journeyRef: stopEvent.journeyRef,
      operatingDayRef: stopEvent.operatingDayRef,
      datedJourneyId: stopEvent.datedJourneyId,
      publishedJourneyNumber: stopEvent.publishedJourneyNumber,
      lineId: stopEvent.lineId,
      lineRef: stopEvent.lineRef,
      ptMode: stopEvent.ptMode,
      destinationText: stopEvent.destinationText,
      minutesUntilDeparture: stopEvent.minutesUntilDeparture,
      delayMinutes: stopEvent.delayMinutes,
      bay: stopEvent.bay,
      bayKind: stopEvent.bayKind,
      boardingLocalStopId: eventStopId,
      boardingProviderStopPointId: stopEvent.stopPointId,
      boardingProviderStopPointName: stopEvent.stopPointName,
      status: stopEvent.status,
      timetabledDepartureTime: stopEvent.timetabledDepartureTime,
      estimatedDepartureTime: stopEvent.estimatedDepartureTime,
      ...(stopEvent.isEstimatedToTheSecond ? { isEstimatedToTheSecond: true } : {}),
      serviceNote: stopEvent.serviceNote,
      vehicleAccess: stopEvent.vehicleAccess,
      calls,
      // Dated here, once. A row without calls gets no sequence clock.
      readAt: {
        rowReadAt: receivedAt,
        ...(calls?.length ? { sequenceReadAt: receivedAt } : {}),
      },
    };
    this.datedJourneyReadings.rememberRow(mapped, receivedAt);
    return mapped;
  }

  private requestDatedJourney(
    rowId: string,
    journey: DatedJourneyRef,
    rowCall: RowCallRef,
  ): Promise<DatedJourneyCalls | undefined> {
    const requestKey = this.datedJourneyReadings.findJourneyRecordKey(rowId);
    const requestedAt = Date.now();
    return this.datedJourneyRequests.share(requestKey, () =>
      this.client
        .fetchTripInfo(journey, rowCall)
        .then((journey) => {
          const receivedAt = Date.now();
          const sequence = this.createSequenceReading(requestKey, journey, receivedAt);
          // An answer whose record was evicted is reported as a failure (`rememberSequence`).
          if (
            sequence &&
            this.datedJourneyReadings.rememberSequence(requestKey, sequence, receivedAt)
          ) {
            const datedJourney = this.findDatedJourney(rowId);
            if (datedJourney) {
              this.observedNetwork.rememberJourneys([datedJourney], receivedAt);
              this.servingDirections.remember([datedJourney], receivedAt);
            }
            return sequence;
          }
          this.datedJourneyReadings.markSequenceRefreshFailed(requestKey, receivedAt, requestedAt);
          return undefined;
        })
        // Only readable dated journeys are kept.
        .catch(() => {
          this.datedJourneyReadings.markSequenceRefreshFailed(requestKey, Date.now(), requestedAt);
          return undefined;
        }),
    );
  }

  /**
   * A single-journey response as this dated journey's calls at this instant, shared by every stop
   * of the dated journey.
   */
  private createSequenceReading(
    datedJourneyKey: string,
    journey: FeedTripInfo,
    receivedAt: number,
  ): DatedJourneyCalls | undefined {
    const stopEvent = this.datedJourneyReadings.findDatedJourneyRow(datedJourneyKey)?.stopEvent;
    if (!stopEvent) return undefined;
    const calls = this.stops.toCalls(journey.calls);
    return {
      calls,
      ...(stopEvent.datedJourneyId ? { datedJourneyId: stopEvent.datedJourneyId } : {}),
      status: journey.status ?? stopEvent.status,
      // The calls' own clock.
      readAt: receivedAt,
    };
  }
}

export const transitSource: TransitSource = new TriasTransitSource();
