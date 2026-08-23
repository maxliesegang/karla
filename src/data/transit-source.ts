import { transitNetwork } from "./transit-network";
import { KvvEfaClient } from "./kvv-efa-client";
import { isWithinKvvArea } from "./kvv-area";
import { getTripInstanceId } from "./kvv-efa-parsers";
import type {
  KvvDeparture,
  KvvServiceNotice,
  KvvTrip,
  KvvTripCall,
  KvvTripLocator,
} from "./kvv-efa-parsers";
import { kvvStopMappingByLocalStopId } from "./kvv-stop-mappings";
import type {
  DepartureBoard,
  Departure,
  ServiceNotice,
  ServiceNoticeBoard,
  TransitStop,
  TransitNetwork,
  TripCall,
  TripReading,
} from "./transit-types";
import { createStopSlug } from "../lib/stop-slug";
import { getExpectedDepartureTime, sortDeparturesByExpectedTime } from "../lib/departure-order";
import { createSortedKey } from "../lib/collections";
import { findFinalCallInstant } from "../lib/trip-calls";

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

/**
 * What a caller wants of a board, beyond which stop it is.
 *
 * Both fields exist because a board is a hundred kilobytes and this app reads several of them a
 * minute. Neither is a hint: a caller that states neither is answered with the smallest board and
 * the freshest reading, which is the safe pair and the expensive one.
 */
export type DepartureBoardRequest = {
  /**
   * The complete calling sequence behind every departure — twenty trips of forty calls. Batched
   * observations use it to discover the network; selected-line trips at the visible stop use the
   * one-trip endpoint instead. It is also the whole weight of a board: the same board without it is
   * a fraction of the size.
   */
  includeTripCalls?: boolean;
  /**
   * How old a board already in hand may be and still answer this request. A view refreshing every
   * ninety seconds has no use for a request of its own when the board the rider's own stop fetched
   * ten seconds ago says the same thing. Zero is a reader that will take nothing but the feed.
   */
  maxAgeMs?: number;
  /**
   * Fill sparse line-directions with filtered live reads. This is for the stop overview only: the
   * ordinary board remains the provider's first forty departures and topology reads stay detailed.
   */
  minimumDeparturesPerDirection?: number;
  /** Only supplemented departures expected inside this live window may be added. */
  coverageHorizonMs?: number;
  /**
   * Restrict the board to these `routeDirectionId`s — the provider's own per-direction line ids,
   * which every departure already carries.
   *
   * A stop's forty rows are shared by every line calling there, so a Zentrum post spends them on
   * about twenty minutes of everything. Asked for one line, the same forty rows are spent on that
   * line alone and reach an hour and a half ahead — which is what lets a diagram see a vehicle
   * still out at the end of its run instead of only the ones already near the middle.
   */
  lineIds?: readonly string[];
};

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
/** One supplement answers for every sparse direction at once, so its rows are shared far wider. */
const DIRECTION_SUPPLEMENT_LIMIT = 40;
/**
 * How many filtered passes a completion may spend. Every pass after the first carries only the
 * directions the full answer before it still starved, so it asks for fewer lines than the one
 * before it; the cap is what stops a feed that keeps answering with the wrong rows from being
 * asked forever.
 */
const MAX_DIRECTION_SUPPLEMENT_PASSES = 3;
/**
 * How long a coverage supplement stands. What runs here is not a countdown: an hourly bus found
 * once is still leaving at the same minute five minutes later, and asking again every thirty
 * seconds spent more on rarely-read rows than on the board the rider is reading.
 */
const DIRECTION_SUPPLEMENT_TTL_MS = 5 * 60_000;
const DEFAULT_DIRECTION_COVERAGE_HORIZON_MS = 2 * 60 * 60_000;

/**
 * The completion a request asks for, read once so that the reading kept under a key and the passes
 * that produced it can never disagree about what was asked. A request that wants no completion, or
 * whose calling sequences make one far too heavy to widen, answers nothing here.
 */
type DirectionCoverage = { minimum: number; horizonMs: number; key: string };

function readDirectionCoverage(request: DepartureBoardRequest): DirectionCoverage | undefined {
  const requested = request.minimumDeparturesPerDirection ?? 0;
  if (request.includeTripCalls || requested <= 0) return undefined;
  const minimum = Math.max(1, Math.floor(requested));
  const horizonMs = Math.max(0, request.coverageHorizonMs ?? DEFAULT_DIRECTION_COVERAGE_HORIZON_MS);
  return { minimum, horizonMs, key: `${minimum}:${horizonMs}` };
}

/** Provider locators are short-lived board state, never an unbounded timetable cache. */
const TRIP_LOCATOR_CAPACITY = 1_024;

/** A dynamic stop id is its name slug plus a short digest of the provider id: `hbf--1a2b3c`. */
const DYNAMIC_STOP_ID_PATTERN = /^(.*?)--([a-z0-9]+)$/;

/**
 * Provider stop point -> local stop id, inverted once. A trip sequence resolves one entry per
 * calling point, which is far too often to be scanning the mapping table each time.
 *
 * Every stop point of a place is inverted, not only the one its board is requested for: a place is
 * one local stop however many platforms the operator numbers it across, and a trip must resolve to
 * it from whichever of them it calls at.
 */
const localStopIdByProviderId: ReadonlyMap<string, string> = new Map(
  Object.entries(kvvStopMappingByLocalStopId).flatMap(([localId, mapping]) =>
    [mapping.providerStopId, ...(mapping.otherProviderStopIds ?? [])].map(
      (providerStopId) => [providerStopId, localId] as const,
    ),
  ),
);

/** One provider reading of a trip's sequence, with the instant it was taken. */
type CachedTrip = { receivedAt: number; trip: KvvTrip };

/** Core-network stops are stable local data; every other stop is resolved from KVV when requested. */
export class KvvTransitSource implements TransitSource {
  /** Keyed by stop and variant. Every board dates itself, so how old one is needs no second field. */
  private readonly departureBoardCache = new Map<string, DepartureBoard>();
  private readonly inFlightRequests = new Map<string, Promise<DepartureBoard>>();
  /** Query candidates from EFA's monitor metadata; they are never rendered without a live row. */
  private readonly servingDirectionIdsByStopId = new Map<string, readonly string[]>();
  /** Latest stop-specific row and its private EFA locator, keyed by the row identity views know. */
  private readonly departureById = new Map<string, Departure>();
  private readonly tripLocatorByDepartureId = new Map<string, KvvTripLocator>();
  private readonly tripCache = new Map<string, CachedTrip>();
  /**
   * When each remembered row was read, so a row answered from memory can state its real age.
   *
   * A detailed board's row carries its own calls and is never re-requested, so without this the
   * only date it could be given is the instant it was asked for — which is how a frozen reading
   * comes to claim it was just taken.
   */
  private readonly departureReadAtById = new Map<string, number>();
  /**
   * When each remembered run is expected to be over, wherever a reading has stated its calls.
   *
   * What this decides is eviction order, never freshness: a sequence does not move, but the
   * deviations along it do, so a kept reading is still only served while `maxAgeMs` allows. Held
   * apart from `tripCache` because a detailed board's row arrives with its sequence already on it
   * and never becomes a cache entry, and those rows are worth protecting on the same terms.
   */
  private readonly runEndByDepartureId = new Map<string, number>();
  /** The rare directions a live board could not reach, kept as their own short-lived reading. */
  private readonly directionSupplementCache = new Map<
    string,
    { receivedAt: number; departures: readonly Departure[] }
  >();
  private readonly tripRequests = new Map<string, Promise<CachedTrip | undefined>>();
  private readonly dynamicStops = new Map<string, TransitStop>();
  private serviceNoticeCache: { board: ServiceNoticeBoard; expiresAt: number } | null = null;
  private pendingServiceNotices: Promise<ServiceNoticeBoard> | null = null;
  /** Both directions of the dynamic id <-> provider id pairing, so neither lookup has to scan. */
  private readonly providerIdByDynamicStopId = new Map<string, string>();
  private readonly dynamicStopIdByProviderId = new Map<string, string>();

  private readonly client: KvvEfaClient;
  private readonly network: TransitNetwork;
  private readonly stopsById: ReadonlyMap<string, TransitStop>;

  // Written out rather than declared as constructor parameters so the boundary can be exercised
  // with a recording client under the type-stripping test runner.
  constructor(client: KvvEfaClient = new KvvEfaClient(), network: TransitNetwork = transitNetwork) {
    this.client = client;
    this.network = network;
    this.stopsById = new Map(network.stops.map((stop) => [stop.id, stop]));
  }

  async getNetwork() {
    return this.network;
  }

  getKnownStop(stopId: string): TransitStop | undefined {
    return this.stopsById.get(stopId) ?? this.dynamicStops.get(stopId);
  }

  async resolveStop(stopId: string): Promise<TransitStop | undefined> {
    const local = this.getKnownStop(stopId);
    if (local) return local;

    // A deep link may name a stop the session has not resolved yet, so the id is searched for by
    // name. When it carries a digest, only the stop point that digest was made from will do.
    const [, slug = stopId, digest] = DYNAMIC_STOP_ID_PATTERN.exec(stopId) ?? [];
    const matches = await this.client.searchStops(slug.replace(/-/g, " "));
    const match = digest
      ? matches.find((candidate) => this.createProviderIdHash(candidate.providerId) === digest)
      : matches[0];
    return match
      ? this.registerStop({
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
        this.registerStop({
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
    return [...byId.values()].slice(0, 8);
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

    const pending = reusableKeys
      .map((key) => this.inFlightRequests.get(key))
      .find((inFlight): inFlight is Promise<DepartureBoard> => Boolean(inFlight));
    if (pending) return pending;

    // Only a board that could be read is kept: an unavailable feed is asked again next refresh.
    const board = (
      coverage
        ? this.fetchDirectionCoveredBoard(stopId, request.maxAgeMs, coverage)
        : this.fetchDepartureBoard(stopId, includeTripCalls, request.lineIds)
    )
      .then((fetched) => {
        if (fetched.dataStatus === "live") this.departureBoardCache.set(cacheKey, fetched);
        return fetched;
      })
      .finally(() => this.inFlightRequests.delete(cacheKey));
    this.inFlightRequests.set(cacheKey, board);
    return board;
  }

  getTrip(
    departureId: string,
    maxAgeMs = DEFAULT_BOARD_MAX_AGE_MS,
  ): Promise<TripReading | undefined> {
    const departure = this.departureById.get(departureId);
    const locator = this.tripLocatorByDepartureId.get(departureId);
    // A row read from a detailed board already carries its sequence and needs no request at all.
    // It is dated when its board was read, not now: nothing about it has been re-read, and a row
    // whose board has stopped being refreshed may be answering from minutes ago.
    if (!departure || !locator) {
      if (!departure?.tripCalls?.length) return Promise.resolve(undefined);
      const receivedAt = this.departureReadAtById.get(departureId) ?? Date.now();
      return Promise.resolve({ trip: departure, receivedAt });
    }

    // A sequence does not move, so a reading still inside the caller's tolerance answers it, and
    // one request is shared by everyone asking for the same trip while it is in flight.
    const cached = this.tripCache.get(departureId);
    const read =
      cached && Date.now() - cached.receivedAt < maxAgeMs
        ? Promise.resolve(cached)
        : (this.tripRequests.get(departureId) ?? this.requestTrip(departureId, locator));
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
    if (this.pendingServiceNotices) return this.pendingServiceNotices;

    const request = this.fetchServiceNotices()
      .then((board) => {
        // Only a reading that succeeded is worth keeping: an unreadable feed is retried next time
        // rather than remembered as an answer for the next quarter of an hour.
        if (board.dataStatus === "live") {
          this.serviceNoticeCache = { board, expiresAt: Date.now() + SERVICE_NOTICE_CACHE_TTL_MS };
        }
        return board;
      })
      .finally(() => {
        this.pendingServiceNotices = null;
      });
    this.pendingServiceNotices = request;
    return request;
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
      (stop) => (stop.providerId && this.findLocalStopId(stop.providerId)) || [],
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
    const providerId = this.findProviderStopId(stopId);
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
      if (!lineIds?.length) this.servingDirectionIdsByStopId.set(stopId, board.servingDirectionIds);
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

  /**
   * Completes a basic board just far enough for the stop's line overview to answer "what runs
   * here?". Candidate ids come from the same monitor response, but only returned departure rows
   * become visible facts.
   *
   * The completion is a reading of its own with its own life (`DIRECTION_SUPPLEMENT_TTL_MS`), not
   * part of the thirty-second cycle. It has to be, or it never stops: a stop whose rare lines run
   * hourly is under-covered on every single refresh, so a pass tied to the board's cadence asks
   * again forever and spends more than the board it completes.
   *
   * Held rows are published only for departures further away than the reading is old, so a delay
   * that has moved since cannot mislead a rider about something imminent. Anything nearer than that
   * is the fresh board's to state — and at a stop busy enough for this to matter, the fresh board
   * already reaches it. A supplement past its life is dropped rather than aged further, and a
   * failed pass adds nothing at all.
   */
  private async fetchDirectionCoveredBoard(
    stopId: string,
    maxAgeMs: number | undefined,
    { minimum, horizonMs, key: coverageKey }: DirectionCoverage,
  ): Promise<DepartureBoard> {
    const base = await this.getDepartureBoard(stopId, { maxAgeMs });
    if (base.dataStatus !== "live") return base;

    const providerId = this.findProviderStopId(stopId);
    const feedNow = Date.parse(base.feedUpdatedAt);
    if (!providerId || !Number.isFinite(feedNow)) return base;

    const candidates = [
      ...new Set([
        ...(this.servingDirectionIdsByStopId.get(stopId) ?? []),
        ...base.departures.flatMap(({ routeDirectionId }) =>
          routeDirectionId ? [routeDirectionId] : [],
        ),
      ]),
    ];
    if (candidates.length === 0) return base;

    const held = this.directionSupplementCache.get(`${stopId}:${coverageKey}`);
    const heldAgeMs = held ? Date.now() - held.receivedAt : Number.POSITIVE_INFINITY;
    const isHeldReadable = heldAgeMs < DIRECTION_SUPPLEMENT_TTL_MS;
    const departureById = new Map<string, Departure>();
    // The live board is the fresher statement wherever both saw the same trip, so it is laid down
    // first and nothing completing it may state one of its runs a second time — under the trip id
    // a filtered reading happens to have given that run, it would stand beside itself.
    const runKeys = new Set<string>();
    for (const departure of base.departures) {
      departureById.set(departure.id, departure);
      const runKey = findRunKey(departure);
      if (runKey) runKeys.add(runKey);
    }
    const completeWith = (departure: Departure): boolean => {
      const runKey = findRunKey(departure);
      if (runKey) {
        if (runKeys.has(runKey)) return false;
        runKeys.add(runKey);
      }
      departureById.set(departure.id, departure);
      return true;
    };
    if (isHeldReadable && held) {
      for (const departure of held.departures) {
        if (isWithin(departure, feedNow + heldAgeMs, feedNow + horizonMs)) completeWith(departure);
      }
    }

    // Counted in one pass over the departures rather than one pass per direction: a busy post
    // answers with forty rows and serves twenty directions, and this is re-asked after every read.
    const getMissing = () => {
      const coveredByDirection = new Map<string, number>();
      for (const departure of departureById.values()) {
        const directionId = departure.routeDirectionId;
        if (!directionId || !isWithin(departure, feedNow, feedNow + horizonMs)) continue;
        coveredByDirection.set(directionId, (coveredByDirection.get(directionId) ?? 0) + 1);
      }
      return candidates.filter(
        (directionId) => (coveredByDirection.get(directionId) ?? 0) < minimum,
      );
    };

    if (isHeldReadable) return this.toCoveredBoard(base, departureById, feedNow, horizonMs);

    let missing = getMissing();
    if (missing.length === 0) return base;

    const supplemented: Departure[] = [];
    try {
      // The limit applies to the combined filtered answer, not once per line. A full answer that
      // still starves some directions earns another pass carrying only those: one retry does not
      // always settle the skew that spends a busy stop's rows on the lines needing them least.
      // A pass runs only after progress, so each one is a smaller ask, never a wider one.
      for (let pass = 0; pass < MAX_DIRECTION_SUPPLEMENT_PASSES && missing.length > 0; pass += 1) {
        const limit = Math.min(
          DIRECTION_SUPPLEMENT_LIMIT,
          Math.max(minimum, missing.length * minimum),
        );
        const supplement = await this.client.fetchDepartureBoard(providerId, {
          lineIds: missing,
          limit,
        });
        for (const rawDeparture of supplement.departures) {
          const departure = this.toDeparture(rawDeparture, stopId);
          if (!isWithin(departure, feedNow, feedNow + horizonMs)) continue;
          if (!completeWith(departure)) continue;
          supplemented.push(departure);
        }
        const nextMissing = getMissing();
        if (supplement.departures.length < limit || nextMissing.length === missing.length) break;
        missing = nextMissing;
      }
    } catch {
      return base;
    }

    this.directionSupplementCache.set(`${stopId}:${coverageKey}`, {
      receivedAt: Date.now(),
      departures: supplemented,
    });
    return this.toCoveredBoard(base, departureById, feedNow, horizonMs);
  }

  /** The completed reading: the live board's own facts, in one order, inside the stated window. */
  private toCoveredBoard(
    base: DepartureBoard,
    departureById: ReadonlyMap<string, Departure>,
    feedNow: number,
    horizonMs: number,
  ): DepartureBoard {
    return {
      ...base,
      departures: sortDeparturesByExpectedTime(
        [...departureById.values()].filter((departure) =>
          isWithin(departure, feedNow, feedNow + horizonMs),
        ),
        feedNow,
      ),
    };
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
    const departureStopId = this.findLocalStopId(departure.stopPointId) ?? stopId;
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
      tripCalls: departure.tripCalls && this.toTripCalls(departure.tripCalls),
    };
    this.rememberDeparture(mapped, departure.tripLocator);
    return mapped;
  }

  private requestTrip(
    departureId: string,
    locator: KvvTripLocator,
  ): Promise<CachedTrip | undefined> {
    const request = this.client
      .fetchTrip(locator)
      .then((trip) => {
        const read: CachedTrip = { receivedAt: Date.now(), trip };
        this.tripCache.set(departureId, read);
        // The fetched sequence is the fuller statement of where this run ends; the row it was
        // asked for may have carried no calls at all.
        this.rememberRunEnd(departureId, trip.tripCalls);
        return read;
      })
      // Only a trip that could be read is kept: a failed one is asked again on the next refresh.
      .catch(() => undefined)
      .finally(() => this.tripRequests.delete(departureId));
    this.tripRequests.set(departureId, request);
    return request;
  }

  /** The provider stop point behind a local stop, whether it is authored or dynamically resolved. */
  private findProviderStopId(stopId: string): string | undefined {
    return (
      kvvStopMappingByLocalStopId[stopId]?.providerStopId ??
      this.providerIdByDynamicStopId.get(stopId)
    );
  }

  /** Provider calling points as the app states them: every one resolved to a local stop of ours. */
  private toTripCalls(tripCalls: readonly KvvTripCall[]): TripCall[] {
    return tripCalls.map(({ providerId, ...tripStop }) => ({
      ...tripStop,
      localStopId: providerId
        ? this.resolveTripCallStopId(providerId, tripStop)
        : createStopSlug(tripStop.stopName),
    }));
  }

  private rememberDeparture(departure: Departure, locator: KvvTripLocator | undefined): void {
    // Refresh insertion order so active rows are evicted last.
    this.departureById.delete(departure.id);
    this.departureById.set(departure.id, departure);
    this.departureReadAtById.set(departure.id, Date.now());
    if (locator) this.tripLocatorByDepartureId.set(departure.id, locator);
    else this.tripLocatorByDepartureId.delete(departure.id);
    this.rememberRunEnd(departure.id, departure.tripCalls);

    const now = Date.now();
    while (this.departureById.size > TRIP_LOCATOR_CAPACITY) {
      const evictedId = this.findEvictableDepartureId(now);
      if (evictedId === undefined) break;
      this.forgetDeparture(evictedId);
    }
  }

  /** The end of a run is only ever learned, never unlearned: a later row may carry no calls. */
  private rememberRunEnd(departureId: string, calls: readonly TripCall[] | undefined): void {
    const runEnd = findFinalCallInstant(calls);
    if (runEnd !== undefined) this.runEndByDepartureId.set(departureId, runEnd);
  }

  /**
   * Which remembered row the cap should take next: the oldest one whose run is over, or that
   * nothing is known about.
   *
   * Insertion order alone used to decide this, which spent the cap on exactly the wrong rows. A
   * board the rider leaves keeps being re-read and stays young, while a trip fetched once and
   * still out on its route ages quietly at the front — so board churn evicted running vehicles,
   * and the diagram asked for their sequences again. A run whose last call has passed is finished
   * evidence and nobody will ask for it; a row nothing is known about is a board row that costs
   * one board to have back. Both go before a vehicle still on its way. Where every remembered run
   * is still going the oldest is taken regardless: the cap is a bound, not a preference.
   */
  private findEvictableDepartureId(now: number): string | undefined {
    let oldestId: string | undefined;
    for (const departureId of this.departureById.keys()) {
      oldestId ??= departureId;
      const runEnd = this.runEndByDepartureId.get(departureId);
      if (runEnd === undefined || runEnd <= now) return departureId;
    }
    return oldestId;
  }

  private forgetDeparture(departureId: string): void {
    this.departureById.delete(departureId);
    this.departureReadAtById.delete(departureId);
    this.tripLocatorByDepartureId.delete(departureId);
    this.tripCache.delete(departureId);
    this.runEndByDepartureId.delete(departureId);
  }

  /** Keep the live DM row as the departure fact and add only the single-trip facts it lacks. */
  private mergeTrip(departureId: string, trip: KvvTrip): Departure | undefined {
    const departure = this.departureById.get(departureId);
    if (!departure) return undefined;
    const tripCalls = this.toTripCalls(trip.tripCalls);
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

  /**
   * The local id for one calling point of a trip. The feed states where every calling point is, so
   * a stop first met inside a trip is registered with its position — that is what lets a rider be
   * placed against stops the authored network never listed. A stop already met through the name
   * search carries no position, so the first call that states one fills it in.
   */
  private resolveTripCallStopId(
    providerId: string,
    tripStop: Omit<KvvTripCall, "providerId">,
  ): string {
    const knownId = this.findLocalStopId(providerId);
    if (!knownId) {
      return this.registerStop({
        providerId,
        name: tripStop.stopName,
        placeName: tripStop.placeName,
        latitude: tripStop.latitude,
        longitude: tripStop.longitude,
      }).id;
    }

    const known = this.dynamicStops.get(knownId);
    if (known && known.latitude === undefined && tripStop.latitude !== undefined) {
      this.dynamicStops.set(knownId, {
        ...known,
        latitude: tripStop.latitude,
        longitude: tripStop.longitude,
      });
    }
    return knownId;
  }

  /**
   * A stop the session has met but the authored network does not list. Registered once and kept for
   * the session, so the same provider stop resolves to the same local id wherever it turns up.
   */
  private registerStop({
    providerId,
    name,
    placeName,
    latitude,
    longitude,
    preferredId,
  }: {
    providerId: string;
    name: string;
    placeName?: string;
    latitude?: number;
    longitude?: number;
    /** The id a deep link already used, so resolving that link does not mint a second one. */
    preferredId?: string;
  }): TransitStop {
    const id = preferredId ?? this.createDynamicStopId(name, providerId);
    // A stop outside the core is shown with the municipality beside its name, which is the second
    // name a rider knows it by — the same slot a local stop states a colloquial name in.
    const stop: TransitStop = {
      id,
      name,
      alias: placeName,
      latitude,
      longitude,
    };
    this.dynamicStops.set(id, stop);
    this.providerIdByDynamicStopId.set(id, providerId);
    this.dynamicStopIdByProviderId.set(providerId, id);
    return stop;
  }

  private createDynamicStopId(name: string, providerId: string): string {
    return `${createStopSlug(name)}--${this.createProviderIdHash(providerId)}`;
  }

  private createProviderIdHash(providerId: string): string {
    let hash = 2166136261;
    for (const character of providerId) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  /** A supported local page for this provider stop, preferring the fixed mapping over a dynamic one. */
  private findLocalStopId(providerId: string): string | undefined {
    return (
      localStopIdByProviderId.get(providerId) ?? this.dynamicStopIdByProviderId.get(providerId)
    );
  }
}

/** Whether a departure is expected inside a window, read against the feed's clock. */
function isWithin(departure: Departure, from: number, until: number): boolean {
  const expected = getExpectedDepartureTime(departure, from);
  return expected >= from && expected <= until;
}

/**
 * One row per run, keeping the reading that carries a prediction.
 *
 * The monitor answers with the same run twice, under two trip ids differing in a single segment
 * and stating the same operator train number — the S5 to Pforzheim published at 12:05 from Gleis 2
 * comes back once as scheduled and once running six minutes down. Both are the same vehicle, so
 * left as they are the board publishes two times for it, which is the one thing a row may never do.
 * The reading with a prediction is the statement about the vehicle and is the one kept; where
 * neither has one there is nothing to choose between them, and the feed's own order decides.
 */
function keepOneRowPerRun(departures: readonly Departure[]): Departure[] {
  const indexByRunKey = new Map<string, number>();
  const kept: Departure[] = [];
  for (const departure of departures) {
    const runKey = findRunKey(departure);
    const knownIndex = runKey === undefined ? undefined : indexByRunKey.get(runKey);
    if (knownIndex === undefined) {
      if (runKey !== undefined) indexByRunKey.set(runKey, kept.length);
      kept.push(departure);
      continue;
    }
    if (kept[knownIndex].delayMinutes === undefined && departure.delayMinutes !== undefined) {
      kept[knownIndex] = departure;
    }
  }
  return kept;
}

/**
 * What names one run across two readings of it, where the feed states enough to be sure.
 *
 * The trip id cannot answer this: a line-filtered completion comes back with the same run under a
 * trip id differing from the plain board's in a single segment, so a merge keyed by it publishes
 * that run twice — once with a prediction and once without, which is one vehicle claiming two
 * times on one board. What both readings agree on is the operator's own train number, and with the
 * line, the destination, the platform and the published minute beside it that names the run rather
 * than the reading of it.
 *
 * Deliberately answers nothing where the feed numbered no run, so such a departure is merged by its
 * id exactly as before rather than by a description `createDepartureId` has already refused. Joined
 * portions share a train number but never a destination, so they are never folded into one row.
 */
function findRunKey(departure: Departure): string | undefined {
  if (!departure.trainNumber) return undefined;
  return [
    departure.trainNumber,
    departure.lineId,
    departure.destination,
    departure.platformName,
    departure.scheduledDepartureTime,
  ].join("|");
}

/**
 * What makes one departure on a board different from every other one on it.
 *
 * The trip is the identity, and the feed's own trip id is the only thing that carries it: a line,
 * a platform, a destination and a scheduled minute do not. Two S8 to Tullastraße leave Augartenstraße
 * Gleis 2 scheduled on the same minute — one delayed three minutes, one not — and describing them
 * by what they look like gave both the same id. That is a rider selecting one and lighting both,
 * a cancelled trip finding itself as its own replacement, and two React rows under one key, which
 * is how a row ends up drawn somewhere its time does not put it.
 *
 * The trip id is used rather than `tripInstanceId` because the latter is refined by the trip's
 * first call, which only a detailed board carries: an id must not change when the same board is
 * fetched with calling sequences. The scheduled minute stays in it so a trip id the operator reuses
 * later in the day is still two departures. Where the feed names no trip at all, the description is
 * all there is, and it is kept as the fallback it always was.
 */
export function createDepartureId(departure: KvvDeparture, stopId: string): string {
  const tripIdentity =
    departure.tripId ?? `${departure.lineId}-${departure.platformName}-${departure.destination}`;
  return `${stopId}-${tripIdentity}-${departure.scheduledDepartureTime}`;
}

export const transitSource: TransitSource = new KvvTransitSource();
