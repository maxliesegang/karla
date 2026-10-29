/** Pure decoding of TRIAS replies (docs/trias-api.md); the transport is `trias-client.ts`. */
import {
  joinServiceNotes,
  normalizeNoticeLineNumber,
  parseNoticeDetails,
  parseBayKind,
  readOperatingNote,
  readTrainName,
  readVehicleAccess,
  splitDestination,
} from "./feed-conventions";
import {
  getDatedJourneyId,
  type FeedStopEvent,
  type FeedStopEventBoard,
  type FeedStopSearchResult,
  type FeedTripInfo,
  type FeedCall,
  type DatedJourneyRef,
  type RowCallRef,
} from "./feed";
import { network } from "../networks/network";
import { getRefPool } from "./network-scope";
import type { StopEventStatus, BayKind, PtMode } from "./transit-types";
import {
  child,
  childrenNamed,
  descendantsNamed,
  parseXml,
  textAt,
  type XmlElement,
} from "./xml-reader";

export class TriasError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TriasError";
  }
}

/** The provider's answers for a stop with nothing due, as opposed to a failed request. */
const NO_STOP_EVENTS_ERRORS = new Set(["STOPEVENT_LOCATIONUNSERVED", "STOPEVENT_NOEVENTFOUND"]);
/** The provider's answer for a name no stop matches. */
const NO_LOCATIONS_ERROR = "LOCATION_NORESULTS";

/** The stop's DHID for a TRIAS ref (`de:08212:37:6:6`: stop, area, quay). */
export const toStopPointId = (ref: string): string => ref.split(":").slice(0, 3).join(":");

/** The feed prefixes the home municipality's stop names with it. */
function readStopName(name: string): { stopName: string; placeName?: string } {
  const { placeName, stopNamePrefix } = network.home;
  const stopName = name.replace(stopNamePrefix, "");
  return stopName === name ? { stopName } : { stopName, placeName };
}

/** `Gleis 2(U)` or `Bstg. A`: the kind word, then the signed code. */
export function readBay(label: string | undefined): { code?: string; kind?: BayKind } {
  if (!label) return {};
  const [, word, code] = /^(\S+)\s+(.+)$/.exec(label) ?? [];
  const kind = parseBayKind(word);
  return kind ? { code, kind } : { code: label };
}

/** Pools that state the timetable as `EstimatedTime` where they have no prediction. */
const TIMETABLE_ECHO_POOLS = new Set(["frb", "din"]);
/** Pools that state times to the second; the others state whole minutes. */
const SECOND_PRECISION_POOLS = new Set(["kvv", "frb"]);
/** Farther ahead, a stated `EstimatedTime` is the plan (`ddb:` states one for tomorrow). */
const PREDICTION_HORIZON_MS = 3 * 3_600_000;

/** The journey's pool and the feed's clock, which decide whether an `EstimatedTime` predicts. */
type PredictionContext = { pool?: string; serverNow: number };

const isPrediction = (
  { pool, serverNow }: PredictionContext,
  timetabled: number,
  estimated: number,
) =>
  timetabled - serverNow <= PREDICTION_HORIZON_MS &&
  !(pool && TIMETABLE_ECHO_POOLS.has(pool) && estimated === timetabled);

type ServiceTime = { timetabled: string; estimated?: string; delayMinutes?: number };

function readServiceTime(
  element: XmlElement | undefined,
  context: PredictionContext,
): ServiceTime | undefined {
  const timetabled = Date.parse(textAt(element, "TimetabledTime") ?? "");
  if (!Number.isFinite(timetabled)) return undefined;
  const estimated = Date.parse(textAt(element, "EstimatedTime") ?? "");
  if (!Number.isFinite(estimated) || !isPrediction(context, timetabled, estimated))
    return { timetabled: new Date(timetabled).toISOString() };
  return {
    timetabled: new Date(timetabled).toISOString(),
    estimated: new Date(estimated).toISOString(),
    delayMinutes: Math.round((estimated - timetabled) / 60_000),
  };
}

/** A call, from a board's `CallAtStop` or a journey's bare call element. */
function parseCall(
  element: XmlElement | undefined,
  isThisCall: boolean,
  context: PredictionContext,
): FeedCall | null {
  const call = child(element, "CallAtStop") ?? element;
  const name = textAt(call, "StopPointName", "Text");
  if (!call || !name) return null;
  const ref = textAt(call, "StopPointRef");
  const bayText = textAt(call, "EstimatedBay", "Text") ?? textAt(call, "PlannedBay", "Text");
  const arrival = readServiceTime(child(call, "ServiceArrival"), context);
  const departure = readServiceTime(child(call, "ServiceDeparture"), context);
  const delayMinutes = departure?.delayMinutes ?? arrival?.delayMinutes;
  return {
    ...readStopName(name),
    bayText,
    bay: readBay(bayText).code,
    stopPointId: ref && toStopPointId(ref),
    isThisCall: isThisCall || undefined,
    timetabledArrivalTime: arrival?.timetabled,
    timetabledDepartureTime: departure?.timetabled,
    estimatedArrivalTime: arrival?.estimated,
    estimatedDepartureTime: departure?.estimated,
    delayMinutes,
    // Stated only where it differs from the departure delay.
    arrivalDelayMinutes: arrival?.delayMinutes === delayMinutes ? undefined : arrival?.delayMinutes,
  };
}

const LONG_DISTANCE_RAIL_SUBMODES = new Set([
  "highSpeedRail",
  "interregionalRail",
  "international",
]);
const REGIONAL_RAIL_SUBMODES = new Set(["local", "regionalRail"]);

/** The rider's modes; demand-responsive buses are not read. S-Bahn and rail replacement stay `lightRail`. */
function parsePtMode(mode: XmlElement | undefined): PtMode | undefined {
  const ptMode = textAt(mode, "PtMode");
  if (ptMode === "tram") return "tram";
  if (ptMode === "rail") {
    const submode = textAt(mode, "RailSubmode") ?? "";
    if (LONG_DISTANCE_RAIL_SUBMODES.has(submode)) return "longDistanceRail";
    return REGIONAL_RAIL_SUBMODES.has(submode) ? "regionalRail" : "lightRail";
  }
  if (ptMode === "urbanRail" || ptMode === "metro") return "lightRail";
  if (ptMode === "bus" && textAt(mode, "BusSubmode") !== "demandAndResponseBus") return "bus";
  return undefined;
}

const isStated = (element: XmlElement | undefined, name: string): boolean =>
  textAt(element, name) === "true";

function parseStatus(service: XmlElement | undefined, hasPrediction: boolean): StopEventStatus {
  if (isStated(service, "Cancelled")) return "cancelled";
  if (isStated(service, "Deviation") || isStated(service, "Unplanned")) return "diverted";
  return hasPrediction ? "realtime" : "scheduled";
}

/** `kvv:22305:E:R:s26:1762`: the line ref, then the journey's own code. */
function readLineRef(journeyRef: string): string | undefined {
  const separator = journeyRef.lastIndexOf(":");
  if (separator <= 0 || separator === journeyRef.length - 1) return undefined;
  return journeyRef.slice(0, separator);
}

type Delivery = { serverTime: string; response: XmlElement };

function readDelivery(xml: string, requestDescription: string, responseName: string): Delivery {
  let root: XmlElement;
  try {
    root = parseXml(xml);
  } catch (cause) {
    throw new TriasError(`${requestDescription}: ungültiges XML`, { cause });
  }
  const delivery = root.name === "Trias" ? child(root, "ServiceDelivery") : undefined;
  const serverTime = textAt(delivery, "ResponseTimestamp");
  const response = child(delivery, "DeliveryPayload", responseName);
  if (!delivery || !response || textAt(delivery, "Status") === "false") {
    throw new TriasError(`${requestDescription}: unerwartete Antwort`);
  }
  if (!serverTime || !isValidFeedTimestamp(serverTime)) {
    throw new TriasError(`${requestDescription}: ungültige Feed-Zeit`);
  }
  return { serverTime, response };
}

function isValidFeedTimestamp(value: string): boolean {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    return false;
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return date.toISOString().slice(0, 10) === value.slice(0, 10) && Number(value.slice(11, 13)) < 24;
}

const readErrorCodes = (response: XmlElement | undefined): string[] =>
  childrenNamed(response, "ErrorMessage").flatMap((error) =>
    [textAt(error, "Code"), textAt(error, "Text", "Text")].filter(
      (value): value is string => value !== undefined,
    ),
  );

/** Whole minutes between the two clock readings, as stop displays count them. */
const countClockMinutes = (from: number, until: number): number =>
  Math.max(0, Math.floor(until / 60_000) - Math.floor(from / 60_000));

function parseStopEvent(
  event: XmlElement,
  eventKind: "departure" | "arrival",
  serverNow: number,
): FeedStopEvent | null {
  const service = child(event, "Service");
  const section = child(service, "ServiceSection");
  const journeyRef = textAt(service, "JourneyRef");
  const lineRef = journeyRef && readLineRef(journeyRef);
  const publishedLineName = textAt(section, "PublishedLineName", "Text");
  const destinationText = textAt(service, "DestinationText", "Text");
  const ptMode = parsePtMode(child(section, "Mode"));
  if (!journeyRef || !lineRef || !publishedLineName || !destinationText || !ptMode) return null;
  const publishedJourneyNumber = textAt(event, "Extension", "PublishedJourneyNumber", "Text");
  const lineId =
    ptMode === "longDistanceRail"
      ? readTrainName(
          publishedLineName,
          textAt(event, "Extension", "TransportTypeName", "Text"),
          publishedJourneyNumber,
        )
      : publishedLineName;
  const pool = getRefPool(journeyRef);
  const context = { pool, serverNow };

  const thisCall = parseCall(child(event, "ThisCall"), true, context);
  if (!thisCall?.stopPointId) return null;
  const before = childrenNamed(event, "PreviousCall").map((call) =>
    parseCall(call, false, context),
  );
  const after = childrenNamed(event, "OnwardCall").map((call) => parseCall(call, false, context));
  const calls =
    before.length + after.length > 0
      ? [...before, thisCall, ...after].filter((call): call is FeedCall => call !== null)
      : undefined;

  // An arrival board's row is timed by the arrival.
  const timetabledDepartureTime =
    eventKind === "arrival"
      ? (thisCall.timetabledArrivalTime ?? thisCall.timetabledDepartureTime)
      : (thisCall.timetabledDepartureTime ?? thisCall.timetabledArrivalTime);
  const estimatedDepartureTime =
    eventKind === "arrival"
      ? (thisCall.estimatedArrivalTime ?? thisCall.estimatedDepartureTime)
      : (thisCall.estimatedDepartureTime ?? thisCall.estimatedArrivalTime);
  if (!timetabledDepartureTime) return null;
  const timetabled = Date.parse(timetabledDepartureTime);
  const expected = estimatedDepartureTime ? Date.parse(estimatedDepartureTime) : timetabled;
  const operatingDayRef = textAt(service, "OperatingDayRef");
  const remarks = childrenNamed(service, "Attribute").flatMap(
    (attribute) => textAt(attribute, "Text", "Text") ?? [],
  );
  const [destination, destinationNote] = splitDestination(destinationText);
  const bay = readBay(thisCall.bayText);
  const origin = textAt(service, "OriginStopPointRef");
  const end = textAt(service, "DestinationStopPointRef");

  return {
    stopPointId: thisCall.stopPointId,
    stopPointName: thisCall.stopName,
    journeyRef,
    ...(operatingDayRef
      ? { operatingDayRef, datedJourneyId: getDatedJourneyId({ journeyRef, operatingDayRef }) }
      : {}),
    publishedJourneyNumber,
    lineId,
    lineRef,
    ptMode,
    destinationText: destination,
    ...(origin ? { originStopPointId: toStopPointId(origin) } : {}),
    ...(end ? { destinationStopPointId: toStopPointId(end) } : {}),
    minutesUntilDeparture: countClockMinutes(serverNow, expected),
    delayMinutes: estimatedDepartureTime ? Math.round((expected - timetabled) / 60_000) : undefined,
    bay: bay.code ?? "",
    bayKind: bay.kind,
    status: parseStatus(service, estimatedDepartureTime !== undefined),
    timetabledDepartureTime,
    estimatedDepartureTime,
    ...(estimatedDepartureTime && pool && SECOND_PRECISION_POOLS.has(pool)
      ? { isEstimatedToTheSecond: true }
      : {}),
    serviceNote: joinServiceNotes(destinationNote, readOperatingNote(remarks)),
    vehicleAccess: readVehicleAccess(remarks),
    calls,
  };
}

/**
 * A stop's board. TRIAS states no serving lines, so they stay empty; the source learns them from
 * observed dated journeys.
 */
export function parseTriasStopEvents(
  xml: string,
  stopPointId: string,
  eventKind: "departure" | "arrival" = "departure",
): FeedStopEventBoard {
  const description = `Abfahrtstafel ${stopPointId}`;
  const { serverTime, response } = readDelivery(xml, description, "StopEventResponse");
  const errors = readErrorCodes(response);
  const hasUnexpectedError = childrenNamed(response, "ErrorMessage").some(
    (error) => !NO_STOP_EVENTS_ERRORS.has(textAt(error, "Text", "Text") ?? ""),
  );
  if (hasUnexpectedError) {
    throw new TriasError(`${description}: ${errors.join(", ")}`);
  }
  const serverNow = Date.parse(serverTime);
  const stopEvents = childrenNamed(response, "StopEventResult")
    .map((result) => child(result, "StopEvent"))
    .flatMap((event) => (event ? (parseStopEvent(event, eventKind, serverNow) ?? []) : []));
  return {
    stopPointId,
    stopName: stopEvents[0]?.stopPointName ?? "",
    serverTime,
    stopEvents,
  };
}

/**
 * A SIRI situation as a board carries it (`StopEventResponseContext`), only those of the board's
 * rows' lines. In the operator's terms: line refs, not
 * line numbers. The app reads none for now, and the proxy strips the block.
 */
export type TriasSituation = {
  /** `SituationNumber@Version`; an ad-hoc one, which has no number, by its summary. */
  id: string;
  title: string;
  /** Line numbers from the description's `Linien: S2, S12, 1` list, where it has one. */
  listedLineNumbers: string[];
  /** The affected journeys' line refs, as stated (`kvv:21001:E:H:`). */
  lineRefs: string[];
  affectedStops: { stopPointId?: string; name: string }[];
  /** The operator's wording as paragraphs, else its description. */
  details: string[];
  validFrom?: string;
  validUntil?: string;
  /** SIRI's ranking, 1 most urgent; KVV's planned works are 3, ad-hoc ones -1. */
  priority?: number;
};

/** The situations a board reply carries; a reply without the block has none. */
export function parseTriasSituations(xml: string): TriasSituation[] {
  const { response } = readDelivery(xml, "Situationen", "StopEventResponse");
  return descendantsNamed(response, "PtSituation").flatMap(
    (situation) => parseSituation(situation) ?? [],
  );
}

/** `Linien: S2, S12, 1, SEV`, the line list KVV writes into a situation's description. */
const SITUATION_LINE_LIST = /^Linien?:\s*(.+)$/m;

function parseSituation(situation: XmlElement): TriasSituation | null {
  const title = textAt(situation, "Summary");
  if (!title) return null;
  const number = textAt(situation, "SituationNumber");
  const description = textAt(situation, "Description");
  const periods = childrenNamed(situation, "ValidityPeriod");
  const starts = periods.flatMap((period) => readInstant(textAt(period, "StartTime"))).sort();
  const ends = periods.flatMap((period) => readInstant(textAt(period, "EndTime"))).sort();
  const details = parseNoticeDetails(textAt(situation, "Detail"));
  const priority = Number.parseInt(textAt(situation, "Priority") ?? "", 10);
  return {
    id: number ? `${number}@${textAt(situation, "Version") ?? "0"}` : `trias:${title}`,
    title,
    listedLineNumbers: [
      ...new Set(
        (SITUATION_LINE_LIST.exec(description ?? "")?.[1].split(",") ?? []).flatMap(
          (listed) => normalizeNoticeLineNumber(listed) ?? [],
        ),
      ),
    ],
    lineRefs: [
      ...new Set(descendantsNamed(situation, "LineRef").flatMap((ref) => ref.text.trim() || [])),
    ],
    affectedStops: descendantsNamed(situation, "AffectedStopPoint").flatMap((stop) => {
      const ref = textAt(stop, "StopPointRef");
      const name = textAt(stop, "StopPointName", "Text") ?? textAt(stop, "StopPointName");
      return name ? [{ stopPointId: ref && toStopPointId(ref), name }] : [];
    }),
    details: details.length > 0 ? details : description ? [description] : [],
    validFrom: starts[0],
    validUntil: ends[ends.length - 1],
    ...(Number.isFinite(priority) ? { priority } : {}),
  };
}

const readInstant = (value: string | undefined): string[] => {
  const instant = Date.parse(value ?? "");
  return Number.isFinite(instant) ? [new Date(instant).toISOString()] : [];
};

/** The row's call: its stop at its timetabled instant, else its stop. */
function findRowCallIndex(calls: readonly FeedCall[], rowCall: RowCallRef): number {
  const atStop = (call: FeedCall) => call.stopPointId === rowCall.stopPointId;
  const instant = Date.parse(rowCall.timetabledTime);
  const rowCallIndex = calls.findIndex(
    (call) =>
      atStop(call) &&
      [call.timetabledDepartureTime, call.timetabledArrivalTime].some(
        (time) => time !== undefined && Date.parse(time) === instant,
      ),
  );
  return rowCallIndex >= 0 ? rowCallIndex : calls.findIndex(atStop);
}

/** Validates the echoed journey: a failed lookup is an HTTP 200 carrying an error code. */
export function parseTriasTripInfo(
  xml: string,
  journey: DatedJourneyRef,
  rowCall?: RowCallRef,
): FeedTripInfo {
  const description = `Fahrt ${journey.journeyRef}`;
  const { serverTime, response } = readDelivery(xml, description, "TripInfoResponse");
  const result = child(response, "TripInfoResult");
  const service = child(result, "Service");
  if (!result || textAt(service, "JourneyRef") !== journey.journeyRef) {
    throw new TriasError(`${description}: nicht gefunden`);
  }

  const context = { pool: getRefPool(journey.journeyRef), serverNow: Date.parse(serverTime) };
  const calls = [
    ...childrenNamed(result, "PreviousCall"),
    ...childrenNamed(result, "OnwardCall"),
  ].flatMap((element) => parseCall(element, false, context) ?? []);
  if (calls.length === 0) throw new TriasError(`${description}: keine Halte`);
  const rowCallIndex = rowCall ? findRowCallIndex(calls, rowCall) : -1;
  if (rowCallIndex >= 0) calls[rowCallIndex].isThisCall = true;

  const status = parseStatus(service, false);
  return {
    serverTime,
    calls,
    status: status === "cancelled" || status === "diverted" ? status : undefined,
  };
}

export function parseTriasLocations(xml: string): FeedStopSearchResult[] {
  const { response } = readDelivery(xml, "Haltestellensuche", "LocationInformationResponse");
  const hasUnexpectedError = childrenNamed(response, "ErrorMessage").some(
    (error) => textAt(error, "Text", "Text") !== NO_LOCATIONS_ERROR,
  );
  if (hasUnexpectedError) {
    throw new TriasError(`Haltestellensuche: ${readErrorCodes(response).join(", ")}`);
  }
  return childrenNamed(response, "LocationResult").flatMap((result) => {
    const location = child(result, "Location");
    const stop = child(location, "StopPoint") ?? child(location, "StopPlace");
    const ref = textAt(stop, "StopPointRef") ?? textAt(stop, "StopPlaceRef");
    const name = textAt(stop, "StopPointName", "Text") ?? textAt(stop, "StopPlaceName", "Text");
    if (!ref || !name) return [];
    const latitude = Number(textAt(location, "GeoPosition", "Latitude"));
    const longitude = Number(textAt(location, "GeoPosition", "Longitude"));
    return [
      {
        stopPointId: toStopPointId(ref),
        name,
        placeName: textAt(location, "LocationName", "Text"),
        ...(Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : {}),
      },
    ];
  });
}
