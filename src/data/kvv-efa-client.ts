import {
  KvvEfaError,
  formatNetworkCalendarDay,
  parseDepartureBoardResponse,
  parseLineRouteResponse,
  parseServiceNoticeResponse,
  parseStopSearchResponse,
  parseTripResponse,
  type KvvDepartureBoard,
  type KvvServiceNotice,
  type KvvStopSearchResult,
  type KvvTrip,
  type KvvTripCall,
  type KvvTripLocator,
} from "./kvv-efa-parsers";

const DEFAULT_DEPARTURE_ENDPOINT = "https://projekte.kvv-efa.de/sl3-alone/XSLT_DM_REQUEST";
const DEFAULT_TRIP_ENDPOINT = "https://projekte.kvv-efa.de/sl3-alone/XML_TRIPSTOPTIMES_REQUEST";
/** A line's whole route, which no board states — see `docs/kvv-efa-api.md`. */
const DEFAULT_LINE_ROUTE_ENDPOINT =
  "https://projekte.kvv-efa.de/sl3-alone/XML_STOPSEQCOORD_REQUEST";
const DEFAULT_STOP_SEARCH_ENDPOINT =
  "https://projekte.kvv-efa.de/sl3-alone/XSLT_STOPFINDER_REQUEST";
/** The operator's published notices — planned closures, replacement services, diversions. */
const DEFAULT_SERVICE_NOTICE_ENDPOINT =
  "https://projekte.kvv-efa.de/sl3-alone/XSLT_ADDINFO_REQUEST";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_DEPARTURE_LIMIT = 20;
/** Lets the feed answer in longitude,latitude instead of its own projected grid. */
const WGS84_COORDINATE_FORMAT = "WGS84[DD.ddddd]";

/**
 * The modes a board is asked for: Stadtbahn/S-Bahn, tram, and bus — the network KARLA reads.
 *
 * Without them a Hauptbahnhof board spends its rows on ICE, IC, TGV and Flixbus, none of which a
 * rider opens this app for. The macros come from the operator's own departure-monitor form and
 * filter by mode *group*, not by `motType`: the train group would bring long-distance rail back
 * with the regional trains, and the bus group carries long-distance coaches along with the city
 * buses. The coaches are therefore dropped again when the answer is read
 * (`kvv-efa-parsers.ts`), which is the only place their `motType` is visible.
 *
 * They are sent only where they answer something. A board asked for named line-directions cannot
 * contain another mode at all — the filter is the narrower statement of the same thing — and the
 * macros are not free: they make the monitor answer in its own form, which ignores the row cap and
 * returns every row's complete calling sequence whether or not one was asked for. On a filtered
 * board that is the difference between 21 kB and 108 kB on the wire for the same twenty rows.
 */
/**
 * How many rows a board may answer with — under both names the endpoint knows.
 *
 * `limit` is exact only where it is sent *before* the mode macros below; after them the monitor
 * ignores it and answers with its own forty rows, and nothing in the answer says which happened.
 * The order in this object is therefore load-bearing, which is exactly what a later tidy-up would
 * undo. `depSequence` caps the same set in either position, so both are sent — and never below
 * two, because `depSequence=1` answers with no rows at all. Measurements: `docs/kvv-efa-api.md`.
 */
const toRowLimitParameters = (limit: number) => {
  const rows = String(Math.max(2, limit));
  return { limit: rows, depSequence: rows };
};

const LOCAL_NETWORK_MODE_PARAMETERS = {
  std3_commonMacro: "dm",
  includedMeans: "checkbox",
  std3_inclMOT_1Macro: "true",
  std3_inclMOT_4Macro: "true",
  std3_inclMOT_5Macro: "true",
} as const;

export type KvvEfaClientOptions = {
  departureEndpoint?: string;
  tripEndpoint?: string;
  lineRouteEndpoint?: string;
  stopSearchEndpoint?: string;
  serviceNoticeEndpoint?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
};

/**
 * Read-only transport for the KVV EFA departure monitor.
 *
 * The endpoint answers cross-origin requests with an `Access-Control-Allow-Origin` header that
 * mirrors the caller, so a static GitHub Pages build may read it directly. Only simple request
 * headers are used: browsers forbid setting `User-Agent`, and adding custom headers would force a
 * preflight this endpoint does not need. What the answers *mean* is decided by the parsers in
 * `kvv-efa-parsers.ts`, which is also where the wire types live.
 */
export class KvvEfaClient {
  private readonly departureEndpoint: string;
  private readonly tripEndpoint: string;
  private readonly lineRouteEndpoint: string;
  private readonly stopSearchEndpoint: string;
  private readonly serviceNoticeEndpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  constructor(options: KvvEfaClientOptions = {}) {
    this.departureEndpoint = options.departureEndpoint ?? DEFAULT_DEPARTURE_ENDPOINT;
    this.tripEndpoint = options.tripEndpoint ?? DEFAULT_TRIP_ENDPOINT;
    this.lineRouteEndpoint = options.lineRouteEndpoint ?? DEFAULT_LINE_ROUTE_ENDPOINT;
    this.stopSearchEndpoint = options.stopSearchEndpoint ?? DEFAULT_STOP_SEARCH_ENDPOINT;
    this.serviceNoticeEndpoint = options.serviceNoticeEndpoint ?? DEFAULT_SERVICE_NOTICE_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  async fetchDepartureBoard(
    stopPointId: string,
    options: {
      limit?: number;
      includeTripCalls?: boolean;
      /** Opaque `servingLine.stateless` ids. EFA accepts this parameter more than once. */
      lineIds?: readonly string[];
    } = {},
  ): Promise<KvvDepartureBoard> {
    const payload = await this.requestJson(this.departureEndpoint, `Abfahrtstafel ${stopPointId}`, {
      type_dm: "stopID",
      name_dm: stopPointId,
      mode: "direct",
      useRealtime: "1",
      useProxFootSearch: "0",
      itdDateTimeDepArr: "dep",
      ...toRowLimitParameters(options.limit ?? DEFAULT_DEPARTURE_LIMIT),
      ...(options.lineIds?.length ? {} : LOCAL_NETWORK_MODE_PARAMETERS),
      // Without this the feed answers in its own projected grid (MRCV), which no map shares.
      coordOutputFormat: WGS84_COORDINATE_FORMAT,
      ...(options.lineIds?.length ? { line: options.lineIds } : {}),
      ...(options.includeTripCalls ? { depType: "stopEvents", includeCompleteStopSeq: "1" } : {}),
    });
    return parseDepartureBoardResponse(payload, stopPointId);
  }

  /**
   * Where one line-direction goes, from any run of it: the whole route, terminus to terminus.
   *
   * The same locator the trip endpoint takes — a run is how this endpoint is addressed — but the
   * answer is the line's, not the run's, and the requested stop is only where the line is caught.
   * Ordinary boards never state this: they state trips, and the trips running at any hour describe
   * less of the line than the line. Measured at about 30 kB for a thirty-stop tram line, which is
   * one request in place of a filtered board at every stop of it.
   *
   * `stop`, not `stopID`, which is the trip endpoint's name for the same field.
   */
  async fetchLineRoute(locator: KvvTripLocator): Promise<KvvTripCall[]> {
    const payload = await this.requestJson(this.lineRouteEndpoint, `Linie ${locator.line}`, {
      line: locator.line,
      tripCode: locator.tripCode,
      stop: locator.stopPointId,
      date: locator.date,
      time: locator.time,
      coordOutputFormat: WGS84_COORDINATE_FORMAT,
    });
    return parseLineRouteResponse(payload, locator);
  }

  /** One dated trip, identified by the opaque tuple a basic departure row already carries. */
  async fetchTrip(locator: KvvTripLocator): Promise<KvvTrip> {
    const payload = await this.requestJson(this.tripEndpoint, `Fahrt ${locator.tripCode}`, {
      tripCode: locator.tripCode,
      line: locator.line,
      stopID: locator.stopPointId,
      date: locator.date,
      time: locator.time,
      useRealtime: "1",
      tStOTType: "ALL",
      coordOutputFormat: WGS84_COORDINATE_FORMAT,
    });
    return parseTripResponse(payload, locator);
  }

  /**
   * The notices the operator has published and dated for today.
   *
   * Unfiltered the endpoint answers with every notice in the whole KVV area, which is far more than
   * a Karlsruhe reader has any use for and a great deal to transfer; `filterDateValid` narrows it
   * to what applies today. Which of those concern a line or a stop in view is decided above this
   * client, because only the app knows what is in view.
   */
  async fetchServiceNotices(now = new Date()): Promise<KvvServiceNotice[]> {
    return parseServiceNoticeResponse(
      await this.requestJson(this.serviceNoticeEndpoint, "Betriebsmeldungen", {
        filterDateValid: formatNetworkCalendarDay(now),
        filterPublicationStatus: "current",
      }),
    );
  }

  async searchStops(query: string): Promise<KvvStopSearchResult[]> {
    return parseStopSearchResponse(
      await this.requestJson(this.stopSearchEndpoint, "Haltestellensuche", {
        type_sf: "any",
        name_sf: query,
        // Stops only. Left unfiltered the finder spends its answer on streets and POIs — a query
        // like "Kaiserstr" comes back more street than stop — and every one of those is dropped
        // when the answer is read. `type_sf=stop` would be the obvious narrowing but is a
        // different, nationwide index: it answers without `anyType` and without coordinates, so
        // no result could be placed inside the network's area.
        anyObjFilter_sf: "2",
        // Without this the feed answers coordinates on its projected grid; the position is what
        // decides above this client whether a found stop belongs to the network's area.
        coordOutputFormat: WGS84_COORDINATE_FORMAT,
      }),
    );
  }

  /**
   * One GET, bounded by a timeout, with every failure surfaced as a `KvvEfaError` naming what was
   * being read. Only simple request headers are sent, so the request stays preflight-free.
   */
  private async requestJson(
    endpoint: string,
    requestDescription: string,
    queryParameters: Record<string, string | readonly string[]>,
  ): Promise<unknown> {
    const url = new URL(endpoint);
    const searchParameters = new URLSearchParams({ outputFormat: "json" });
    for (const [name, value] of Object.entries(queryParameters)) {
      if (Array.isArray(value)) value.forEach((entry) => searchParameters.append(name, entry));
      else searchParameters.set(name, value as string);
    }
    url.search = searchParameters.toString();

    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchFn(url, { signal: controller.signal });
      if (!response.ok) throw new KvvEfaError(`${requestDescription}: HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (error instanceof KvvEfaError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new KvvEfaError(`${requestDescription} nach ${this.timeoutMs} ms abgebrochen`, {
          cause: error,
        });
      }
      throw new KvvEfaError(`${requestDescription} konnte nicht geladen werden`, { cause: error });
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }
}
