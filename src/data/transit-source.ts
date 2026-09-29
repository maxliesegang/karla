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
} from "./transit-types";
import { RunReadingStore } from "./run-reading-store";
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
   * How stale the runs' own re-reads may be, where it is named apart from `maxAgeMs`.
   *
   * The boards state which runs exist; the calls a diagram places vehicles from are the runs' own
   * readings, and the feed revises those about every `FEED_REVISION_INTERVAL_MS` — so a line may ask
   * its runs for a fresher tolerance than the boards that name them, at a fraction of a board's
   * transfer. Unnamed, the runs keep the boards' freshness.
   */
  runMaxAgeMs?: number;
};
export { createDepartureId };

/**
 * The boundary the views talk to. Nothing above this line knows about EFA, provider ids, or HTTP;
 * a different provider is a different implementation of these methods.
 */
export interface TransitSource {
  /** Stops and lines: the stable local identities every view addresses a stop by. */
  getNetwork(): Promise<TransitNetwork>;
  /** Resolves both local core-network stops and any stop exposed by the KVV network. */
  resolveStop(stopId: string): Promise<TransitStop | undefined>;
  /**
   * The same answer where it is already in hand, without the wait.
   *
   * A stop the session has read a board or a run through is known here for the rest of it, and
   * asking for it again is a lookup rather than a load. The distinction is not an optimisation:
   * a view that has to await an answer it already holds has to render the not-knowing first, and
   * for a rider walking along a line diagram that is the whole view blanking between two stops of
   * the line they are reading. `undefined` means only that the session has not met the stop —
   * never that there is no such stop, which is `resolveStop`'s question to answer.
   */
  getKnownStop(stopId: string): TransitStop | undefined;
  /**
   * Stops matching what a reader typed. Views never reach past this for a provider search.
   * Rejects when the provider could not be read and the local stops answer nothing — a failed
   * search is not an empty one, and the caller has to be able to tell the two apart.
   */
  searchStops(query: string): Promise<readonly TransitStop[]>;
  /** One stop's live board. Never rejects: failures resolve to an explicit unavailable state. */
  getDepartureBoard(stopId: string, request?: DepartureBoardRequest): Promise<DepartureBoard>;
  /**
   * Several stops of one line, read as the rows they have and completed with each run's calls.
   *
   * The reading a line diagram is drawn from: it wants every stop of the line, and behind every row
   * the whole run. Asking each board for the runs as well is what that used to mean, and it made
   * the same run's calling sequence arrive once per stop it had yet to leave — fifteen times over
   * for a city line. Here the boards state which runs are running and each run states itself,
   * once. Never rejects, for the same reason `getDepartureBoard` does not.
   */
  getLineDepartureBoards(
    stopIds: readonly string[],
    request: LineDepartureBoardsRequest,
  ): Promise<DepartureBoard[]>;
  /**
   * Where a line-direction goes, as a route of our own local stop ids, or `undefined` where it
   * could not be read.
   *
   * Addressed by an observed departure because that is the only handle the provider offers — but
   * what comes back is the line's route and not that run's, so one row of a line answers for the
   * whole of it. Nothing about it is a departure: it is asked for once per line-direction and kept
   * for the session, since a route does not move.
   */
  getLineRoute(rowId: string): Promise<readonly string[] | undefined>;
  /**
   * The complete calls of one observed departure, with the instant that reading was taken;
   * `undefined` means it could not be read.
   *
   * The instant is part of the answer rather than something the caller stamps on arrival: a run
   * inside `maxAgeMs` is answered from the reading already held, and a caller that dated it by its
   * own clock would restate a kept reading as a fresh one every time it asked.
   */
  getRun(rowId: string, maxAgeMs?: number): Promise<Departure | undefined>;
  /**
   * What is known about a run right now, without asking the provider for anything.
   *
   * The synchronous half of `getRun`: the same reading, from the same evidence, answered from what
   * has already been read. A view holds run *ids* and reads the runs themselves through this on
   * every render, so a sequence that lands for one view is on every other view's next paint.
   */
  findRun(rowId: string): Departure | undefined;
  /** Notifies when one of these rows' run readings changes. */
  subscribeToRuns(rowIds: readonly string[], listener: () => void): () => void;
  getRunVersion(rowIds: readonly string[]): string;
  /** Session topology learned from every live board, independent of the view that fetched it. */
  getObservedNetwork(): ObservedNetwork;
  subscribeToObservedNetwork(listener: () => void): () => void;
  /**
   * What the operator has published about the network: planned closures, replacement services,
   * diversions. Never rejects — an unreadable notice feed is a state a view has to state, not an
   * empty one it may present as "nothing reported".
   */
  getServiceNotices(): Promise<ServiceNoticeBoard>;
}

/** How fresh a kept board must be for a caller that states no tolerance of its own. */
/**
 * How stale a cached board may be before it is read again.
 *
 * The innermost of the four lifetimes a run has (`RUN_ENDED_GRACE_MS`): a board served from cache
 * carries rows that were remembered when it was fetched, so it must never outlive their records in
 * the reading store — past that its rows are no longer addressable as runs and every stop of one
 * would ask for it separately.
 */
export const DEFAULT_BOARD_MAX_AGE_MS = 30_000;
/**
 * Notices are written by hand and published for days or weeks at a time, so they are worth far less
 * frequent asking than a board — and the answer is a large one, covering the whole KVV area.
 */
const SERVICE_NOTICE_CACHE_TTL_MS = 15 * 60_000;
const BASIC_BOARD_CACHE_VARIANT = "basic";
const DETAILED_BOARD_CACHE_VARIANT = "with-trip-calls";
const COVERED_BOARD_CACHE_VARIANT = "covered-directions";
const LINE_BOARD_CACHE_VARIANT = "line";
/**
 * The rows a board is allowed, which is the whole bandwidth budget: every row of a detailed board
 * carries a complete calling sequence, and every row of a basic one still repeats the operator's
 * notice blob. Twenty reach about ten minutes at the busiest Zentrum post and hours at a quiet
 * stop. A view that needs to see further asks for one line rather than for more rows — filtered,
 * the same twenty reach some forty minutes of that line.
 */
const DEFAULT_DEPARTURE_LIMIT = 20;
/** The one key the whole-network notice board is shared under; there is only ever the one read. */
const SERVICE_NOTICE_REQUEST_KEY = "service-notices";
/** How many local and remote matches a typed query is answered with. */
const STOP_SEARCH_LIMIT = 8;

/**
 * How soon a run's own next call must be for its calls to be worth reading.
 *
 * Every stop of a line is read, so a vehicle out on it is a few minutes from *somewhere*: its next
 * call is the nearest row it has anywhere on the line. A run whose nearest row is hours away has
 * not set out — a departure a rider can read on a board, and no vehicle anybody can draw. Forty
 * rows at each of seventy stops name some 250 runs, a dozen of which are on the line.
 *
 * Half an hour is generous for that: it covers a run about to leave its origin and one crossing a
 * stretch where the stops are far apart, and still leaves the small hours out.
 */
const RUN_UNDER_WAY_MINUTES = 30;

/** Core-network stops are stable local data; every other stop is resolved from KVV when requested. */
export class KvvTransitSource implements TransitSource {
  /** Keyed by stop and variant. Every board dates itself, so how old one is needs no second field. */
  private readonly departureBoardCache = new Map<string, DepartureBoard>();
  private readonly boardRequests = new SharedRequests<DepartureBoard>();
  private readonly runRequests = new SharedRequests<RunSequence | undefined>();
  private readonly lineRouteRequests = new SharedRequests<readonly string[] | undefined>();
  /**
   * One route per line-direction, kept for the session.
   *
   * A route is timetable data — it is not a countdown, and nothing in a visit makes it wrong — so
   * unlike a board this has no refresh cycle and no age. A diversion published mid-visit is the one
   * thing it would miss, which is what the reload it survives is for.
   */
  private readonly lineRoutes = new Map<string, readonly string[]>();
  private readonly noticeRequests = new SharedRequests<ServiceNoticeBoard>();
  private readonly runReadings = new RunReadingStore();
  private readonly observedNetwork = new ObservedNetworkStore();
  private readonly coverage = new DirectionCoverageCompleter();
  private readonly stops: StopRegistry;
  private serviceNoticeCache: { board: ServiceNoticeBoard; expiresAt: number } | null = null;

  private readonly client: KvvEfaClient;
  private readonly network: TransitNetwork;

  // Written out rather than declared as constructor parameters so the boundary can be exercised
  // with a recording client under the type-stripping test runner.
  constructor(client: KvvEfaClient = new KvvEfaClient(), network: TransitNetwork = transitNetwork) {
    this.client = client;
    this.network = network;
    this.stops = new StopRegistry(network.stops);
  }

  async getNetwork() {
    return this.network;
  }

  getKnownStop(stopId: string): TransitStop | undefined {
    return this.stops.findStop(stopId);
  }

  async resolveStop(stopId: string): Promise<TransitStop | undefined> {
    const local = this.getKnownStop(stopId);
    if (local) return local;

    // A deep link may name a stop the session has not resolved yet, so the id is searched for by
    // name. When it carries a digest, only the stop point that digest was made from will do.
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
   * Stops matching a typed query, registered as they are found so the ids they are offered under
   * resolve later without a second search. The authored stops are matched first and locally: they
   * are the ones a reader is most likely to want, and answering them costs no request at all.
   * The provider searches the whole country, so remote matches only survive if they stand inside
   * the network's area — a match without a stated position cannot be placed there and is dropped.
   */
  async searchStops(query: string): Promise<readonly TransitStop[]> {
    const trimmed = query.trim();
    if (trimmed.length < 2) return [];

    const normalized = trimmed.toLowerCase();
    const local = this.network.stops.filter((stop) =>
      [stop.name, stop.alias].some((name) => name?.toLowerCase().includes(normalized)),
    );

    // A provider read that failed is not an answer of "nothing": with local matches in hand the
    // search still answers with them, and without any it fails so the caller can say so.
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
    // Sorted and joined so two callers asking for the same lines share one request whatever order
    // they name them in. A filtered board answers a different question from the whole board at the
    // same stop, so it is never allowed to stand in for it.
    const lineFilterKey = request.routeDirectionIds?.length
      ? createSortedKey(request.routeDirectionIds)
      : undefined;
    const cacheKey = this.getDepartureBoardCacheKey(
      stopId,
      includeTripCalls,
      coverage?.key,
      lineFilterKey,
    );
    // A detailed board carries every row a basic one does and the same number of them, so a basic
    // reader is answered from it rather than asking the stop twice. A filtered or coverage-completed
    // board answers a different question and is never allowed to stand in for the whole board.
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
      ).then((fetched) => {
        // Only a board that could be read is kept: an unavailable feed is asked again next refresh.
        if (fetched.dataStatus === "live") this.departureBoardCache.set(cacheKey, fetched);
        return this.publishBoard(fetched);
      }),
    );
  }

  async getLineDepartureBoards(
    stopIds: readonly string[],
    { routeDirectionIds, maxAgeMs, runMaxAgeMs = maxAgeMs }: LineDepartureBoardsRequest,
  ): Promise<DepartureBoard[]> {
    // The rows first, and only the rows. A board filtered to named directions cannot hold another
    // line, so it needs none of the mode macros — and without them it answers without the calling
    // sequences too, which is the whole saving: one line's stop read this way is a fifth of the
    // board it used to be.
    const boards = await Promise.all(
      stopIds.map((stopId) => this.getDepartureBoard(stopId, { routeDirectionIds, maxAgeMs })),
    );

    // One request per *run*, not per row: the same run is listed at every stop it has yet to leave,
    // and its calls are the same wherever they are asked for. The source's record key is used on
    // both sides: a filtered row cannot state the dated mark identity a completed one does, while
    // its private locator already names the record that owns its evidence and request.
    const rows = boards.flatMap((board) => board.departures);
    const rowByRunRecordKey = new Map<string, Departure>();
    for (const row of rows) {
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

    // Read back out of the store rather than merged again here. The store has already merged every
    // row of every run these requests answered, and merging a second time beside it would publish a
    // second object for the one reading — equal in content, different in identity, and identity is
    // what every view downstream memoises on. A row whose record was evicted meanwhile is answered
    // by the board's own row, which is what the boards stated and still stands.
    return boards.map((board) =>
      this.publishBoard({
        ...board,
        departures: board.departures.map((row) => this.findRun(row.id) ?? row),
      }),
    );
  }

  getLineRoute(rowId: string): Promise<readonly string[] | undefined> {
    const locator = this.runReadings.findRow(rowId)?.locator;
    if (!locator) return Promise.resolve(undefined);
    // Keyed by the line-direction and not by the row, because every run of a direction answers
    // with the same route: the second row of a line asks for nothing.
    const kept = this.lineRoutes.get(locator.line);
    if (kept) return Promise.resolve(kept);

    return (
      this.lineRouteRequests.find(locator.line) ??
      this.lineRouteRequests.share(locator.line, () =>
        this.client
          .fetchLineRoute(locator)
          .then((route) => {
            // Resolved through the registry like any other calling point, so a stop first met out
            // along a line is registered with its position and has a page of its own from then on.
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
          // A route that could not be read is asked for again; the reading falls back to what the
          // runs in hand describe, which is where it stood before this existed.
          .catch(() => undefined),
      )
    );
  }

  /**
   * This row completed by the run behind it: the stop's own facts, and the whole calling sequence.
   *
   * The two halves are readings on two clocks and the answer states both (`Departure.readAt`), so
   * whatever is drawn from it can tell which half is the later evidence without being told.
   */
  getRun(rowId: string, maxAgeMs = DEFAULT_BOARD_MAX_AGE_MS): Promise<Departure | undefined> {
    const row = this.runReadings.findRow(rowId);
    if (!row) return Promise.resolve(undefined);
    const cached = this.runReadings.findSequence(rowId)?.sequence;
    // Answered from the store rather than merged here, so the reading a caller awaits and the one
    // every view reads on its next paint are the same object.
    const current = () => (cached ? this.findRun(rowId) : undefined);

    // A detailed board is itself a complete run observation. Without a locator it is the only
    // observation this run can ever have; with one it competes with individual reads by age below.
    if (!row.locator) return Promise.resolve(current());

    // One record is shared by every stop row of the same dated run. A sequence still inside the
    // caller's tolerance answers all of those aliases, and concurrent aliases share one request.
    //
    // The tolerance is asked of the calls alone (`getSequenceReadInstant`) and never of the reading as
    // a whole: what a caller here is deciding is whether to re-read the sequence, and a row re-read
    // beside it on a board's own faster cadence is not an answer to that question.
    const readAt = cached?.readAt;
    if (readAt !== undefined && Date.now() - readAt < maxAgeMs) return Promise.resolve(current());
    const read =
      this.runRequests.find(this.runReadings.findRunRecordKey(rowId)) ??
      this.requestRun(rowId, row.locator);
    // A run that could not be read is answered by nothing, not by the row it was asked about: the
    // caller backs off on a failure, and a row restated as an answer is not one.
    return read.then((sequence) => (sequence ? this.findRun(rowId) : undefined));
  }

  // Every answer is the one reading store's, shared by every view.
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
          // Only a reading that succeeded is worth keeping: an unreadable feed is retried next time
          // rather than remembered as an answer for the next quarter of an hour.
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

  /**
   * A notice as the app addresses it: the operator's stop ids resolved to the stop pages we can
   * actually open. A stop the session has never met stays a name, because a link that cannot be
   * opened is worse than the name it was made from.
   */
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
      });
      const receivedAt = Date.now();
      // A filtered board saw only the lines it asked about, so it must never be recorded as the
      // stop's full set of serving directions — that set is what the coverage pass reads, and what
      // the line crawl reads to name the direction a terminus lists no row for.
      const isWholeStop = !lineIds?.length;
      if (isWholeStop) {
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
        // The feed answers in schedule order, but every countdown counted off this board contains
        // its deviation — so the board is published in the order a rider catches the vehicles.
        departures: sortDeparturesByExpectedInstant(
          keepOneRowPerRun(
            board.departures.map((departure) => this.toDeparture(departure, stopId, receivedAt)),
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

  /** The stop's live board completed for its sparse directions — see `direction-coverage.ts`. */
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

  /** Every board leaves the source through the canonical run objects and teaches session topology. */
  private publishBoard(board: DepartureBoard): DepartureBoard {
    if (board.dataStatus !== "live") return board;
    const departures = board.departures.map((row) => this.findRun(row.id) ?? row);
    const published = departures.every((departure, index) => departure === board.departures[index])
      ? board
      : { ...board, departures };
    this.observedNetwork.rememberBoard(published);
    return published;
  }

  private toDeparture(departure: KvvDeparture, stopId: string, receivedAt: number): Departure {
    // One board request can cover several physical stop points. Keep the page being read on its
    // DepartureBoard, but let each row retain the provider stop it actually leaves from; otherwise
    // a surface departure returned by an underground stop-complex board cannot match its own call
    // in the trip sequence.
    const departureStopId = this.stops.findLocalStopId(departure.stopPointId) ?? stopId;
    const id = createDepartureId(departure, departureStopId);
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
      // The boundary is where a reading is dated, and every departure published from here is dated
      // here: a row that arrived carrying its own calls is one reading and states one instant
      // twice. A row that carries none dates only itself — there is no sequence reading here to
      // date, and a clock for one would be read as a sequence just taken. Everything downstream
      // ranks, retains and places by this and never by a clock of its own (`Departure.readAt`).
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
          // A request outlives the record it was shared under — the sweep and the cap do not wait
          // for the provider — and a reading with nowhere to land is a reading nobody took. Said so
          // rather than swallowed: answered with the row it was asked about, the caller counted a
          // failure as a success, stopped backing off, and went on never re-reading the run.
          return sequence && this.runReadings.rememberSequence(requestKey, sequence, receivedAt)
            ? sequence
            : undefined;
        })
        // Only a run that could be read is kept: a failed one is asked again on the next refresh.
        .catch(() => undefined),
    );
  }

  /**
   * A single-run response as the one thing it actually is: this run's calls, at this instant.
   *
   * A row of the run is still consulted, because the provider's trip response names no timetable
   * trip of its own and the dated identity is derived from one. But nothing of that row survives
   * into the reading. The response is evidence about the *run*, read on behalf of every stop of it,
   * and shaping it like the one row that happened to discover it puts that row's id, stop, platform
   * and countdown onto a copy every other stop then reads — facts about somewhere else, on the only
   * object in the store that no single stop owns.
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
      // Derived exactly as a board derives it. A single-run reading times its calls to the second
      // and a board row publishes the same call to the minute, so an id built here from the raw
      // timestamp named the same run differently from every board's reading of it.
      ...(tripInstanceId ? { tripInstanceId } : {}),
      status: trip.status ?? departure.status,
      // One instant, and it is the calls'. The row this was discovered through has a clock of its
      // own and keeps it; a sequence that inherited it is how a stale prediction passed for a
      // correction, and the type no longer has anywhere to put one.
      readAt: receivedAt,
    };
  }
}

export const transitSource: TransitSource = new KvvTransitSource();
