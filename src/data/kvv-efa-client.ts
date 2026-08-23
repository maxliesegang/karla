import {
  KvvEfaError,
  formatNetworkCalendarDay,
  parseDepartureBoardResponse,
  parseServiceNoticeResponse,
  parseStopSearchResponse,
  parseTripResponse,
  type KvvDepartureBoard,
  type KvvServiceNotice,
  type KvvStopSearchResult,
  type KvvTrip,
  type KvvTripLocator,
} from "./kvv-efa-parsers";

const DEFAULT_DEPARTURE_ENDPOINT = "https://projekte.kvv-efa.de/sl3-alone/XSLT_DM_REQUEST";
const DEFAULT_TRIP_ENDPOINT = "https://projekte.kvv-efa.de/sl3-alone/XML_TRIPSTOPTIMES_REQUEST";
const DEFAULT_STOP_SEARCH_ENDPOINT =
  "https://projekte.kvv-efa.de/sl3-alone/XSLT_STOPFINDER_REQUEST";
/** The operator's published notices — planned closures, replacement services, diversions. */
const DEFAULT_SERVICE_NOTICE_ENDPOINT =
  "https://projekte.kvv-efa.de/sl3-alone/XSLT_ADDINFO_REQUEST";
const DEFAULT_TIMEOUT_MS = 8_000;
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
 */
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
  private readonly stopSearchEndpoint: string;
  private readonly serviceNoticeEndpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  constructor(options: KvvEfaClientOptions = {}) {
    this.departureEndpoint = options.departureEndpoint ?? DEFAULT_DEPARTURE_ENDPOINT;
    this.tripEndpoint = options.tripEndpoint ?? DEFAULT_TRIP_ENDPOINT;
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
      limit: String(options.limit ?? DEFAULT_DEPARTURE_LIMIT),
      ...LOCAL_NETWORK_MODE_PARAMETERS,
      // Without this the feed answers in its own projected grid (MRCV), which no map shares.
      coordOutputFormat: WGS84_COORDINATE_FORMAT,
      ...(options.lineIds?.length ? { line: options.lineIds } : {}),
      ...(options.includeTripCalls ? { depType: "stopEvents", includeCompleteStopSeq: "1" } : {}),
    });
    return parseDepartureBoardResponse(payload, stopPointId);
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
