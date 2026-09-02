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
  ServiceNoticeBoard,
  TransitStop,
  TransitNetwork,
  TripReading,
} from "./transit-types";
import { DepartureMemory, type CachedTrip } from "./departure-memory";
import {
  DirectionCoverageCompleter,
  readDirectionCoverage,
  type DirectionCoverage,
} from "./direction-coverage";
import { createDepartureId, keepOneRowPerRun } from "./departure-runs";
import { SharedRequests } from "./request-sharing";
import { DYNAMIC_STOP_ID_PATTERN, StopRegistry, hashProviderStopId } from "./stop-registry";
import { sortDeparturesByExpectedTime } from "../lib/departure-order";
import { createSortedKey } from "../lib/collections";

export type { DepartureBoardRequest };
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
   * A stop the session has read a board or a trip through is known here for the rest of it, and
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
   * The complete calls of one observed departure, with the instant that reading was taken;
   * `undefined` means it could not be read.
   *
   * The instant is part of the answer rather than something the caller stamps on arrival: a trip
   * inside `maxAgeMs` is answered from the reading already held, and a caller that dated it by its
   * own clock would restate a kept reading as a fresh one every time it asked.
   */
  getTrip(departureId: string, maxAgeMs?: number): Promise<TripReading | undefined>;
  /**
   * What the operator has published about the network: planned closures, replacement services,
   * diversions. Never rejects — an unreadable notice feed is a state a view has to state, not an
   * empty one it may present as "nothing reported".
   */
  getServiceNotices(): Promise<ServiceNoticeBoard>;
}

/** How fresh a kept board must be for a caller that states no tolerance of its own. */
const DEFAULT_BOARD_MAX_AGE_MS = 30_000;
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
const BOARD_DEPARTURE_LIMIT = 20;
/** The one key the whole-network notice board is shared under; there is only ever the one read. */
const SERVICE_NOTICE_REQUEST_KEY = "service-notices";
/** How many local and remote matches a typed query is answered with. */
const STOP_SEARCH_LIMIT = 8;

/** Core-network stops are stable local data; every other stop is resolved from KVV when requested. */
export class KvvTransitSource implements TransitSource {
  /** Keyed by stop and variant. Every board dates itself, so how old one is needs no second field. */
  private readonly departureBoardCache = new Map<string, DepartureBoard>();
  private readonly boardRequests = new SharedRequests<DepartureBoard>();
  private readonly tripRequests = new SharedRequests<CachedTrip | undefined>();
  private readonly noticeRequests = new SharedRequests<ServiceNoticeBoard>();
  private readonly departures = new DepartureMemory();
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
    const lineFilterKey = request.lineIds?.length ? createSortedKey(request.lineIds) : undefined;
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
    if (cached) return Promise.resolve(cached);

    const pending = this.boardRequests.find(...reusableKeys);
    if (pending) return pending;

    return this.boardRequests.share(cacheKey, () =>
      (coverage
        ? this.fetchDirectionCoveredBoard(stopId, request.maxAgeMs, coverage)
        : this.fetchDepartureBoard(stopId, includeTripCalls, request.lineIds)
      ).then((fetched) => {
        // Only a board that could be read is kept: an unavailable feed is asked again next refresh.
        if (fetched.dataStatus === "live") this.departureBoardCache.set(cacheKey, fetched);
        return fetched;
      }),
    );
  }

  getTrip(
    departureId: string,
    maxAgeMs = DEFAULT_BOARD_MAX_AGE_MS,
  ): Promise<TripReading | undefined> {
    const departure = this.departures.findDeparture(departureId);
    const locator = this.departures.findLocator(departureId);
    // A row read from a detailed board already carries its sequence and needs no request at all.
    // It is dated when its board was read, not now: nothing about it has been re-read, and a row
    // whose board has stopped being refreshed may be answering from minutes ago.
    if (!departure || !locator) {
      if (!departure?.tripCalls?.length) return Promise.resolve(undefined);
      const receivedAt = this.departures.findReadAt(departureId) ?? Date.now();
      return Promise.resolve({ trip: departure, receivedAt });
    }

    // A sequence does not move, so a reading still inside the caller's tolerance answers it, and
    // one request is shared by everyone asking for the same trip while it is in flight.
    const cached = this.departures.findTrip(departureId);
    const read =
      cached && Date.now() - cached.receivedAt < maxAgeMs
        ? Promise.resolve(cached)
        : (this.tripRequests.find(departureId) ?? this.requestTrip(departureId, locator));
    return read.then((trip) => {
      if (!trip) return undefined;
      const merged = this.mergeTrip(departureId, trip.trip);
      // The merged row states what the sequence reading said, so it is dated by that reading.
      return merged && { trip: merged, receivedAt: trip.receivedAt };
    });
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
        limit: BOARD_DEPARTURE_LIMIT,
        ...(lineIds?.length ? { lineIds } : {}),
      });
      // A filtered board saw only the lines it asked about, so it must never be recorded as the
      // stop's full set of serving directions — that set is what the coverage pass reads.
      if (!lineIds?.length) {
        this.coverage.rememberServingDirections(stopId, board.servingDirectionIds);
      }
      return {
        stopId,
        dataStatus: "live",
        feedUpdatedAt: board.serverTime,
        receivedAt: Date.now(),
        // The feed answers in schedule order, but every countdown counted off this board contains
        // its deviation — so the board is published in the order a rider catches the vehicles.
        departures: sortDeparturesByExpectedTime(
          keepOneRowPerRun(
            board.departures.map((departure) => this.toDeparture(departure, stopId)),
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
      return {
        departures: supplement.departures.map((departure) => this.toDeparture(departure, stopId)),
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

  private toDeparture(departure: KvvDeparture, stopId: string): Departure {
    // One board request can cover several physical stop points. Keep the page being read on its
    // DepartureBoard, but let each row retain the provider stop it actually leaves from; otherwise
    // a surface departure returned by an underground stop-complex board cannot match its own call
    // in the trip sequence.
    const departureStopId = this.stops.findLocalStopId(departure.stopPointId) ?? stopId;
    const id = createDepartureId(departure, departureStopId);
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
      platformName: departure.platformName,
      platformKind: departure.platformKind,
      boardingStopId: departureStopId,
      status: departure.status,
      scheduledDepartureTime: departure.scheduledDepartureTime,
      predictedDepartureTime: departure.predictedDepartureTime,
      serviceNote: departure.serviceNote,
      vehicleAccess: departure.vehicleAccess,
      tripCalls: departure.tripCalls && this.stops.toTripCalls(departure.tripCalls),
    };
    this.departures.remember(mapped, departure.tripLocator);
    return mapped;
  }

  private requestTrip(
    departureId: string,
    locator: KvvTripLocator,
  ): Promise<CachedTrip | undefined> {
    return this.tripRequests.share(departureId, () =>
      this.client
        .fetchTrip(locator)
        .then((trip) => {
          const read: CachedTrip = { receivedAt: Date.now(), trip };
          // The fetched sequence is the fuller statement of where this run ends; the row it was
          // asked for may have carried no calls at all.
          this.departures.rememberTrip(departureId, read);
          return read;
        })
        // Only a trip that could be read is kept: a failed one is asked again on the next refresh.
        .catch(() => undefined),
    );
  }

  /** Keep the live DM row as the departure fact and add only the single-trip facts it lacks. */
  private mergeTrip(departureId: string, trip: KvvTrip): Departure | undefined {
    const departure = this.departures.findDeparture(departureId);
    if (!departure) return undefined;
    const tripCalls = this.stops.toTripCalls(trip.tripCalls);
    return {
      ...departure,
      // Derived exactly as a board derives it. A single-trip reading times its calls to the second
      // and a board row publishes the same call to the minute, so an id built here from the raw
      // timestamp named the same vehicle differently from every board's reading of it — and the
      // line diagram, which follows one mark per dated identity, drew the trip twice.
      tripInstanceId: getTripInstanceId(departure.tripId, tripCalls) ?? departure.tripInstanceId,
      status: trip.status ?? departure.status,
      tripCalls,
    };
  }
}

export const transitSource: TransitSource = new KvvTransitSource();
