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
/** A line's whole route, which no board states (`docs/kvv-efa-api.md`). */
const DEFAULT_LINE_ROUTE_ENDPOINT =
  "https://projekte.kvv-efa.de/sl3-alone/XML_STOPSEQCOORD_REQUEST";
const DEFAULT_STOP_SEARCH_ENDPOINT =
  "https://projekte.kvv-efa.de/sl3-alone/XSLT_STOPFINDER_REQUEST";
/** The operator's published notices. */
const DEFAULT_SERVICE_NOTICE_ENDPOINT =
  "https://projekte.kvv-efa.de/sl3-alone/XSLT_ADDINFO_REQUEST";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_DEPARTURE_LIMIT = 20;
/** Longitude,latitude instead of the feed's projected grid. */
const WGS84_COORDINATE_FORMAT = "WGS84[DD.ddddd]";

/**
 * The mode macros a board is asked for: Stadtbahn/S-Bahn, tram, bus. Without them a Hauptbahnhof
 * board fills with ICE, TGV and Flixbus. They filter by mode group, so coaches and other pools are
 * dropped again in `kvv-efa-parsers.ts`.
 *
 * Only sent on unfiltered boards: they make the monitor ignore the row cap and return every row's
 * calling sequence (21 kB vs 108 kB for the same twenty filtered rows).
 */
/**
 * The row cap, under both names the endpoint knows. `limit` only applies when sent before the mode
 * macros, so this object's key order matters. `depSequence` caps either way, but `1` returns
 * nothing, so it is never below two (`docs/kvv-efa-api.md`).
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
 * Read-only transport for the KVV EFA endpoints. They mirror the caller's origin in
 * `Access-Control-Allow-Origin`, so the static site reads them directly; only simple headers are
 * sent, to avoid a preflight. Parsing lives in `kvv-efa-parsers.ts`.
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
      /** Opaque `servingLine.stateless` ids; the parameter may repeat. */
      lineIds?: readonly string[];
      eventKind?: "departure" | "arrival";
    } = {},
  ): Promise<KvvDepartureBoard> {
    const payload = await this.requestJson(this.departureEndpoint, `Abfahrtstafel ${stopPointId}`, {
      type_dm: "stopID",
      name_dm: stopPointId,
      mode: "direct",
      useRealtime: "1",
      // Off is the default, but pinned: with the mode macros, `1` turns a stop board into a
      // district board (Marktplatz returned rows from seven nearby stops).
      useProxFootSearch: "0",
      itdDateTimeDepArr: options.eventKind === "arrival" ? "arr" : "dep",
      ...toRowLimitParameters(options.limit ?? DEFAULT_DEPARTURE_LIMIT),
      ...(options.lineIds?.length ? {} : LOCAL_NETWORK_MODE_PARAMETERS),
      // Otherwise the feed answers in its projected grid (MRCV).
      coordOutputFormat: WGS84_COORDINATE_FORMAT,
      ...(options.lineIds?.length ? { line: options.lineIds } : {}),
      ...(options.includeTripCalls ? { depType: "stopEvents", includeCompleteStopSeq: "1" } : {}),
    });
    return parseDepartureBoardResponse(payload, stopPointId, options.eventKind);
  }

  /**
   * A line-direction's whole route, addressed by any run of it (about 30 kB for a tram line). The
   * field is `stop`, not the trip endpoint's `stopID`.
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

  /** One dated trip, by the opaque tuple a basic row carries. */
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

  /** Notices valid today; unfiltered, the endpoint returns the whole KVV area's. */
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
        // Stops only; otherwise streets and POIs crowd the answer. `type_sf=stop` is a different
        // nationwide index without `anyType` or coordinates.
        anyObjFilter_sf: "2",
        // The position decides whether a found stop is inside the network area.
        coordOutputFormat: WGS84_COORDINATE_FORMAT,
      }),
    );
  }

  /** One GET with a timeout; failures become a `KvvEfaError` naming what was read. */
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
