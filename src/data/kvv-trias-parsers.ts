/** Pure decoding of KVV's TRIAS replies (docs/kvv-trias-api.md); the transport is `kvv-trias-client.ts`. */
import {
  formatNetworkDateAndTime,
  isLocalNetworkPool,
  joinServiceNotes,
  parsePlatformKind,
  readOperatingNote,
  readVehicleAccess,
  splitDestination,
} from "./kvv-conventions";
import {
  getTripInstanceId,
  type KvvDeparture,
  type KvvDepartureBoard,
  type KvvStopSearchResult,
  type KvvTrip,
  type KvvTripCall,
  type KvvTripLocator,
} from "./kvv-feed";
import type { DepartureStatus, PlatformKind, TransportMode } from "./transit-types";
import { child, childrenNamed, parseXml, textAt, type XmlElement } from "./xml-reader";

export class KvvTriasError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "KvvTriasError";
  }
}

/** The provider's answers for a stop with nothing due, as opposed to a failed request. */
const NO_STOP_EVENTS_ERRORS = new Set(["STOPEVENT_LOCATIONUNSERVED", "STOPEVENT_NOEVENTFOUND"]);

/**
 * The provider stop id for a TRIAS ref (`de:08212:37:6:6`, stop, area, quay). Karlsruhe's EFA ids
 * are `7` and the stop number to six digits (all 389 stops of the catalog); elsewhere they differ,
 * so the stop's DHID stands in, which EFA accepts too.
 */
export function toProviderStopId(ref: string): string {
  const stop = ref.split(":").slice(0, 3).join(":");
  const karlsruhe = /^de:08212:(\d+)$/.exec(stop);
  return karlsruhe ? `7${karlsruhe[1].padStart(6, "0")}` : stop;
}

/** TRIAS prefixes Karlsruhe's stop names with the city, spelled out or as `KA`. */
const NETWORK_CITY_PREFIX = /^(?:KA|Karlsruhe) (?=\S)/;

function readStopName(name: string): { stopName: string; placeName?: string } {
  const stopName = name.replace(NETWORK_CITY_PREFIX, "");
  return stopName === name ? { stopName } : { stopName, placeName: "Karlsruhe" };
}

/** `Gleis 2(U)` or `Bstg. A`: the kind word, then the signed code. */
function readBay(label: string | undefined): { code?: string; kind?: PlatformKind } {
  if (!label) return {};
  const [, word, code] = /^(\S+)\s+(.+)$/.exec(label) ?? [];
  const kind = parsePlatformKind(word);
  return kind ? { code, kind } : { code: label };
}

type ServiceTime = { scheduled: string; predicted?: string; delayMinutes?: number };

function readServiceTime(element: XmlElement | undefined): ServiceTime | undefined {
  const scheduled = Date.parse(textAt(element, "TimetabledTime") ?? "");
  if (!Number.isFinite(scheduled)) return undefined;
  const predicted = Date.parse(textAt(element, "EstimatedTime") ?? "");
  if (!Number.isFinite(predicted)) return { scheduled: new Date(scheduled).toISOString() };
  return {
    scheduled: new Date(scheduled).toISOString(),
    predicted: new Date(predicted).toISOString(),
    delayMinutes: Math.round((predicted - scheduled) / 60_000),
  };
}

/** A call, from a board's `CallAtStop` or a trip's bare call element. */
function parseCall(element: XmlElement | undefined, isCurrentStop: boolean): KvvTripCall | null {
  const call = child(element, "CallAtStop") ?? element;
  const name = textAt(call, "StopPointName", "Text");
  if (!call || !name) return null;
  const ref = textAt(call, "StopPointRef");
  const platformLabel = textAt(call, "EstimatedBay", "Text") ?? textAt(call, "PlannedBay", "Text");
  const arrival = readServiceTime(child(call, "ServiceArrival"));
  const departure = readServiceTime(child(call, "ServiceDeparture"));
  const delayMinutes = departure?.delayMinutes ?? arrival?.delayMinutes;
  return {
    ...readStopName(name),
    platformLabel,
    platformCode: readBay(platformLabel).code,
    providerId: ref && toProviderStopId(ref),
    isCurrentStop: isCurrentStop || undefined,
    scheduledArrivalTime: arrival?.scheduled,
    scheduledDepartureTime: departure?.scheduled,
    predictedArrivalTime: arrival?.predicted,
    predictedDepartureTime: departure?.predicted,
    delayMinutes,
    // Stated only where it differs from the departure delay.
    arrivalDelayMinutes: arrival?.delayMinutes === delayMinutes ? undefined : arrival?.delayMinutes,
  };
}

/** The modes read, as EFA's local network selects them; demand-responsive buses are not. */
function parseTransportMode(mode: XmlElement | undefined): TransportMode | undefined {
  const ptMode = textAt(mode, "PtMode");
  if (ptMode === "tram") return "tram";
  if (ptMode === "rail" || ptMode === "urbanRail" || ptMode === "metro") return "lightRail";
  if (ptMode === "bus" && textAt(mode, "BusSubmode") !== "demandAndResponseBus") return "bus";
  return undefined;
}

const isStated = (element: XmlElement | undefined, name: string): boolean =>
  textAt(element, name) === "true";

function parseStatus(service: XmlElement | undefined, hasPrediction: boolean): DepartureStatus {
  if (isStated(service, "Cancelled")) return "cancelled";
  if (isStated(service, "Deviation") || isStated(service, "Unplanned")) return "diverted";
  return hasPrediction ? "realtime" : "scheduled";
}

/** `kvv:22305:E:R:s26:1762`: the line-direction, then the trip code. */
function splitJourneyRef(journeyRef: string): { line: string; tripCode: string } | undefined {
  const separator = journeyRef.lastIndexOf(":");
  if (separator <= 0 || separator === journeyRef.length - 1) return undefined;
  return { line: journeyRef.slice(0, separator), tripCode: journeyRef.slice(separator + 1) };
}

type Delivery = { serverTime: string; response: XmlElement };

function readDelivery(xml: string, requestDescription: string, responseName: string): Delivery {
  let root: XmlElement;
  try {
    root = parseXml(xml);
  } catch (cause) {
    throw new KvvTriasError(`${requestDescription}: ungültiges XML`, { cause });
  }
  const delivery = root.name === "Trias" ? child(root, "ServiceDelivery") : undefined;
  const serverTime = textAt(delivery, "ResponseTimestamp");
  const response = child(delivery, "DeliveryPayload", responseName);
  if (!delivery || !response || textAt(delivery, "Status") === "false") {
    throw new KvvTriasError(`${requestDescription}: unerwartete Antwort`);
  }
  if (!serverTime || !isValidFeedTimestamp(serverTime)) {
    throw new KvvTriasError(`${requestDescription}: ungültige Feed-Zeit`);
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

/** Whole minutes between the two clock readings, as KVV's displays count them. */
const countClockMinutes = (from: number, until: number): number =>
  Math.max(0, Math.floor(until / 60_000) - Math.floor(from / 60_000));

function parseStopEvent(
  event: XmlElement,
  eventKind: "departure" | "arrival",
  serverNow: number,
): KvvDeparture | null {
  const service = child(event, "Service");
  const section = child(service, "ServiceSection");
  const journeyRef = textAt(service, "JourneyRef");
  const journey = journeyRef && splitJourneyRef(journeyRef);
  const lineId = textAt(section, "PublishedLineName", "Text");
  const destinationText = textAt(service, "DestinationText", "Text");
  const transportMode = parseTransportMode(child(section, "Mode"));
  if (!journeyRef || !journey || !lineId || !destinationText || !transportMode) return null;
  if (!isLocalNetworkPool(journeyRef)) return null;

  const thisCall = parseCall(child(event, "ThisCall"), true);
  if (!thisCall?.providerId) return null;
  const before = childrenNamed(event, "PreviousCall").map((call) => parseCall(call, false));
  const after = childrenNamed(event, "OnwardCall").map((call) => parseCall(call, false));
  const tripCalls =
    before.length + after.length > 0
      ? [...before, thisCall, ...after].filter((call): call is KvvTripCall => call !== null)
      : undefined;

  // An arrival board's row is timed by the arrival, as EFA's arrival list is.
  const scheduledDepartureTime =
    eventKind === "arrival"
      ? (thisCall.scheduledArrivalTime ?? thisCall.scheduledDepartureTime)
      : (thisCall.scheduledDepartureTime ?? thisCall.scheduledArrivalTime);
  const predictedDepartureTime =
    eventKind === "arrival"
      ? (thisCall.predictedArrivalTime ?? thisCall.predictedDepartureTime)
      : (thisCall.predictedDepartureTime ?? thisCall.predictedArrivalTime);
  if (!scheduledDepartureTime) return null;
  const scheduled = Date.parse(scheduledDepartureTime);
  const expected = predictedDepartureTime ? Date.parse(predictedDepartureTime) : scheduled;
  const operatingDay = textAt(service, "OperatingDayRef");
  const remarks = childrenNamed(service, "Attribute").flatMap(
    (attribute) => textAt(attribute, "Text", "Text") ?? [],
  );
  const [destination, destinationNote] = splitDestination(destinationText);
  const bay = readBay(thisCall.platformLabel);

  return {
    stopPointId: thisCall.providerId,
    stopPointName: thisCall.stopName,
    tripId: journeyRef,
    tripInstanceId: getTripInstanceId(journeyRef, tripCalls),
    trainNumber: textAt(event, "Extension", "PublishedJourneyNumber", "Text"),
    lineId,
    routeDirectionId: journey.line,
    transportMode,
    destination,
    minutesUntilDeparture: countClockMinutes(serverNow, expected),
    delayMinutes: predictedDepartureTime ? Math.round((expected - scheduled) / 60_000) : undefined,
    platformCode: bay.code ?? "",
    platformKind: bay.kind,
    status: parseStatus(service, predictedDepartureTime !== undefined),
    scheduledDepartureTime,
    predictedDepartureTime,
    ...(predictedDepartureTime ? { isPredictedToTheSecond: true } : {}),
    serviceNote: joinServiceNotes(destinationNote, readOperatingNote(remarks)),
    vehicleAccess: readVehicleAccess(remarks),
    tripLocator: {
      ...journey,
      stopPointId: thisCall.providerId,
      ...formatNetworkDateAndTime(scheduled),
      ...(operatingDay ? { operatingDay } : {}),
    },
    tripCalls,
  };
}

/** A stop's board; `servingLines` are not in TRIAS, so the client supplies them. */
export function parseTriasStopEvents(
  xml: string,
  stopPointId: string,
  eventKind: "departure" | "arrival" = "departure",
): KvvDepartureBoard {
  const description = `Abfahrtstafel ${stopPointId}`;
  const { serverTime, response } = readDelivery(xml, description, "StopEventResponse");
  const errors = readErrorCodes(response);
  const hasUnexpectedError = childrenNamed(response, "ErrorMessage").some(
    (error) => !NO_STOP_EVENTS_ERRORS.has(textAt(error, "Text", "Text") ?? ""),
  );
  if (hasUnexpectedError) {
    throw new KvvTriasError(`${description}: ${errors.join(", ")}`);
  }
  const serverNow = Date.parse(serverTime);
  const departures = childrenNamed(response, "StopEventResult")
    .map((result) => child(result, "StopEvent"))
    .flatMap((event) => (event ? (parseStopEvent(event, eventKind, serverNow) ?? []) : []));
  return {
    stopPointId,
    stopName: departures[0]?.stopPointName ?? "",
    serverTime,
    servingLines: [],
    departures,
  };
}

/** The call the locator's row was read at: its stop at its minute, else its stop. */
function findRowCallIndex(calls: readonly KvvTripCall[], locator: KvvTripLocator): number {
  const atStop = (call: KvvTripCall) => call.providerId === locator.stopPointId;
  const rowCallIndex = calls.findIndex((call) => {
    const time = call.scheduledDepartureTime ?? call.scheduledArrivalTime;
    if (!atStop(call) || !time) return false;
    const { date, time: minute } = formatNetworkDateAndTime(Date.parse(time));
    return date === locator.date && minute === locator.time;
  });
  return rowCallIndex >= 0 ? rowCallIndex : calls.findIndex(atStop);
}

/** Validates the echoed journey: a failed lookup is an HTTP 200 carrying an error code. */
export function parseTriasTrip(xml: string, locator: KvvTripLocator): KvvTrip {
  const description = `Fahrt ${locator.tripCode}`;
  const { serverTime, response } = readDelivery(xml, description, "TripInfoResponse");
  const result = child(response, "TripInfoResult");
  const service = child(result, "Service");
  if (!result || textAt(service, "JourneyRef") !== `${locator.line}:${locator.tripCode}`) {
    throw new KvvTriasError(`${description}: nicht gefunden`);
  }

  const calls = [
    ...childrenNamed(result, "PreviousCall"),
    ...childrenNamed(result, "OnwardCall"),
  ].flatMap((element) => parseCall(element, false) ?? []);
  if (calls.length === 0) throw new KvvTriasError(`${description}: keine Halte`);
  const rowCallIndex = findRowCallIndex(calls, locator);
  if (rowCallIndex >= 0) calls[rowCallIndex].isCurrentStop = true;

  const status = parseStatus(service, false);
  return {
    serverTime,
    tripCalls: calls,
    status: status === "cancelled" || status === "diverted" ? status : undefined,
  };
}

export function parseTriasLocations(xml: string): KvvStopSearchResult[] {
  const { response } = readDelivery(xml, "Haltestellensuche", "LocationInformationResponse");
  const errors = readErrorCodes(response);
  if (errors.length > 0) throw new KvvTriasError(`Haltestellensuche: ${errors.join(", ")}`);
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
        providerId: toProviderStopId(ref),
        name,
        placeName: textAt(location, "LocationName", "Text"),
        ...(Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : {}),
      },
    ];
  });
}
