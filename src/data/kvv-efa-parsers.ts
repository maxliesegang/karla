/** Pure decoding of the KVV EFA wire format; the HTTP transport is `kvv-efa-client.ts`. */
import { EXCEPTIONAL_OPERATION_WORDS } from "./operational-exceptions";
import type {
  DepartureStatus,
  PlatformKind,
  TransportMode,
  TripCall,
  VehicleAccess,
} from "./transit-types";

/** The timezone the feed states its times in, and the one riders read off a KVV clock. */
const NETWORK_TIME_ZONE = "Europe/Berlin";
const networkOffsetFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: NETWORK_TIME_ZONE,
  timeZoneName: "longOffset",
});
/**
 * `filterDateValid` wants the network's own calendar day, in the operator's `DD.MM.YYYY` spelling.
 */
const networkDateFormat = new Intl.DateTimeFormat("de-DE", {
  timeZone: NETWORK_TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

/**
 * EFA reports "no realtime prediction available" as this sentinel instead of omitting the field.
 */
const NO_PREDICTION_DELAY_MINUTES = -9999;

export class KvvEfaError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "KvvEfaError";
  }
}

/** A calling point as the feed states it, still carrying the provider stop id it was read from. */
export type KvvTripCall = TripCall & { providerId?: string };

/** The provider tuple that identifies one dated trip; every field is copied from its DM row. */
export type KvvTripLocator = {
  tripCode: string;
  /** The provider's own key for the service designation (`servingLine.stateless`), not the sign. */
  line: string;
  stopPointId: string;
  date: string;
  time: string;
};

export type KvvTrip = {
  serverTime: string;
  tripCalls: KvvTripCall[];
  /** Only exceptional whole-trip states override the fresher stop-specific DM row. */
  status?: Extract<DepartureStatus, "cancelled" | "diverted">;
};

export type KvvDeparture = {
  /** EFA stop point the vehicle departs from; a complex reports several of these. */
  stopPointId: string;
  stopPointName: string;
  /** EFA's timetable-trip identity, with the operational AVMS identity as fallback. */
  tripId?: string;
  /** Dated identity, for matching older shared links and deduplicating operating instances. */
  tripInstanceId?: string;
  /** `servingLine.trainNum`, including where two separately addressed portions share one train. */
  trainNumber?: string;
  lineId: string;
  /** Opaque EFA identity for this line and operating direction (`H`/`R`). */
  routeDirectionId?: string;
  transportMode: TransportMode;
  destination: string;
  minutesUntilDeparture: number;
  delayMinutes?: number;
  platformCode: string;
  platformKind?: PlatformKind;
  status: DepartureStatus;
  scheduledDepartureTime: string;
  predictedDepartureTime?: string;
  serviceNote?: string;
  /** What the feed states about boarding this vehicle, where it states anything at all. */
  vehicleAccess?: VehicleAccess;
  /** Opaque provider state used below `TransitSource` to load only this trip. */
  tripLocator?: KvvTripLocator;
  tripCalls?: KvvTripCall[];
};

export type KvvDepartureBoard = {
  stopPointId: string;
  stopName: string;
  /** Server time of the feed, so countdowns are anchored to the source, not the browser clock. */
  serverTime: string;
  /** Scheduled line-directions the stop monitor can query; never evidence of a departure itself. */
  servingLines: KvvServingLine[];
  departures: KvvDeparture[];
};

/**
 * A line-direction a stop serves, paired with the line's name. Direction ids are opaque, so this
 * pairing is the only way to name a line with no departure on the board.
 */
export type KvvServingLine = { lineId?: string; directionId: string };

export type KvvStopSearchResult = {
  providerId: string;
  name: string;
  /** The municipality the stop is in, as the feed states it. */
  placeName?: string;
  /** Where the stop stands, so the source can tell what is inside the network's area. */
  latitude?: number;
  longitude?: number;
};

/** A published notice in the operator's terms: its line spellings and provider stop ids. */
export type KvvServiceNotice = {
  id: string;
  title: string;
  /** Line numbers as published, normalised to the form a departure states (`007` is line 7). */
  lineNumbers: string[];
  concernedStops: { providerId?: string; name: string }[];
  /** The operator's own wording, as the paragraphs it published it in. */
  details: string[];
  validFrom?: string;
  validUntil?: string;
  priority: "normal" | "high";
};

/** Today's date in the network's own calendar, as the notice feed's `filterDateValid` wants it. */
export const formatNetworkCalendarDay = (now: Date): string => networkDateFormat.format(now);

/**
 * The points a stop search answered with. One exact match comes back as `{ points: { point } }`
 * rather than a list.
 */
function readStopFinderPoints(points: unknown): Record<string, unknown>[] {
  if (Array.isArray(points)) return points.filter(isRecord);
  return isRecord(points) ? readRecordList(points.point) : [];
}

export function parseStopSearchResponse(payload: unknown): KvvStopSearchResult[] {
  if (!isRecord(payload) || !isRecord(payload.stopFinder)) return [];
  return readStopFinderPoints(payload.stopFinder.points).flatMap((result) => {
    if (result.anyType !== "stop") return [];
    const reference = isRecord(result.ref) ? result.ref : undefined;
    const providerId = readOptionalString(reference?.id) ?? readOptionalString(result.stateless);
    const fullName = readOptionalString(result.name);
    if (!providerId || !fullName) return [];
    const placeName = readOptionalString(reference?.place) ?? readOptionalString(result.mainLoc);
    return [
      {
        providerId,
        name: removeMunicipalityPrefix(fullName),
        placeName,
        ...(parseCoordinates(reference?.coords) ?? {}),
      },
    ];
  });
}

export function parseDepartureBoardResponse(
  payload: unknown,
  stopPointId: string,
): KvvDepartureBoard {
  if (!isRecord(payload))
    throw new KvvEfaError(`Abfahrtstafel ${stopPointId}: unerwartete Antwort`);

  const stopPoint =
    isRecord(payload.dm) && isRecord(payload.dm.points) ? payload.dm.points.point : undefined;
  const stopName =
    isRecord(stopPoint) && typeof stopPoint.name === "string"
      ? removeMunicipalityPrefix(stopPoint.name)
      : "";
  const departureEntries = Array.isArray(payload.departureList) ? payload.departureList : [];
  const servingLines = isRecord(payload.servingLines)
    ? readRecordList(payload.servingLines.lines)
    : [];

  return {
    stopPointId,
    stopName,
    serverTime: parseServerTime(payload.parameters) ?? new Date().toISOString(),
    servingLines: parseServingLines(servingLines),
    departures: departureEntries
      .filter(isRecord)
      .map(parseDeparture)
      .filter((entry): entry is KvvDeparture => entry !== null),
  };
}

/**
 * Boarding as the hints state it. The negation is matched first because it contains the positive
 * word; a trip whose hints say nothing about boarding stays unanswered, not `notStepFree`.
 */
const NOT_STEP_FREE_PATTERN = /nicht\s+(barrierefrei|stufenlos|rollstuhl)/i;
const STEP_FREE_PATTERN = /stufenlos|niederflur|barrierefrei|behindertengerecht|einstiegshilfe/i;

/**
 * Hints about how the trip is running (`Verspätung eines vorausfahrenden Zuges`), as opposed to
 * equipment (`WLAN`, `Bordrestaurant`), which shares the field and is dropped.
 */
const OPERATING_HINT_PATTERN = new RegExp(
  `verspätung|störung|${EXCEPTIONAL_OPERATION_WORDS}|entfällt|ausfall|behinderung|gleiswechsel`,
  "i",
);

function readHintContents(hints: unknown): string[] {
  return readRecordList(hints)
    .map((hint) => readOptionalString(hint.content))
    .filter((content): content is string => Boolean(content));
}

export function findVehicleAccess(hints: unknown): VehicleAccess | undefined {
  const contents = readHintContents(hints);
  if (contents.some((content) => NOT_STEP_FREE_PATTERN.test(content))) return "notStepFree";
  return contents.some((content) => STEP_FREE_PATTERN.test(content)) ? "stepFree" : undefined;
}

/** The operating remarks among the hints, as one note. */
export function findOperatingHint(hints: unknown): string | undefined {
  const operating = readHintContents(hints).filter((content) =>
    OPERATING_HINT_PATTERN.test(content),
  );
  return operating.length > 0 ? [...new Set(operating)].join(" · ") : undefined;
}

/** Two remarks about one trip read as one note; either may be missing. */
function joinServiceNotes(...notes: (string | undefined)[]): string | undefined {
  const stated = [...new Set(notes.filter((note): note is string => Boolean(note)))];
  return stated.length > 0 ? stated.join(" · ") : undefined;
}

/**
 * The row's deviation, measured against the prediction where there is one: `delay` is truncated to
 * the minute and disagrees with `realDateTime` on about one row in twenty (docs/kvv-efa-api.md).
 */
function findPublishedDelayMinutes(
  scheduledDepartureTime: string,
  predictedDepartureTime: string | undefined,
  delayMinutes: number | undefined,
): number | undefined {
  const scheduled = Date.parse(scheduledDepartureTime);
  const predicted = predictedDepartureTime ? Date.parse(predictedDepartureTime) : Number.NaN;
  if (!Number.isFinite(scheduled) || !Number.isFinite(predicted)) return delayMinutes;
  return Math.round((predicted - scheduled) / 60_000);
}

/**
 * The local network's line-directions a stop states, named as a row would name them (`symbol`
 * before `number`), so a line is recognised before any of its departures is due.
 */
function parseServingLines(lines: readonly Record<string, unknown>[]): KvvServingLine[] {
  const byDirectionId = new Map<string, KvvServingLine>();
  for (const line of lines) {
    const mode = isRecord(line.mode) ? line.mode : undefined;
    const diva = isRecord(mode?.diva) ? mode.diva : undefined;
    const directionId = readOptionalString(diva?.stateless) ?? readOptionalString(line.stateless);
    const lineId =
      readOptionalString(line.symbol) ??
      readOptionalString(mode?.symbol) ??
      readOptionalString(mode?.number) ??
      readOptionalString(line.number);
    if (
      !directionId ||
      !isLocalNetworkLine(readOptionalString(mode?.type), directionId) ||
      byDirectionId.has(directionId)
    )
      continue;
    byDirectionId.set(directionId, lineId ? { lineId, directionId } : { directionId });
  }
  return [...byDirectionId.values()];
}

function parseDeparture(entry: Record<string, unknown>): KvvDeparture | null {
  const servingLine = isRecord(entry.servingLine) ? entry.servingLine : null;
  const lineId = readOptionalString(servingLine?.symbol) ?? readOptionalString(servingLine?.number);
  const destination = readOptionalString(servingLine?.direction);
  if (!servingLine || !lineId || !destination) return null;
  const motType = readOptionalString(servingLine.motType);
  if (!isLocalNetworkLine(motType, readOptionalString(servingLine.stateless))) return null;

  const delayMinutes = parseDelayMinutes(servingLine.delay);
  const tripStatus =
    readOptionalString(servingLine.realtimeTripStatus) ??
    readOptionalString(entry.realtimeTripStatus);
  const stopStatus = readOptionalString(entry.realtimeStatus);
  const [plainDestination, serviceNote] = splitDestination(destination);
  const tripId =
    findAttributeValue(entry.attrs, "RealtimeTripId") ??
    findAttributeValue(entry.attrs, "AVMSTripID");
  const scheduledDepartureTime = parseDateTime(entry.dateTime) ?? "";
  const predictedDepartureTime = parseDateTime(entry.realDateTime);
  // The row is the only statement of the call at its own stop, and the only one with a prediction;
  // completed from the stated delay instead, it would disagree with the board row by a minute.
  const tripCalls = parseTripCalls(entry, {
    scheduledDepartureTime,
    delayMinutes: findPublishedDelayMinutes(
      scheduledDepartureTime,
      predictedDepartureTime,
      delayMinutes,
    ),
  });

  return {
    stopPointId: readOptionalString(entry.stopID) ?? "",
    stopPointName: readOptionalString(entry.nameWO) ?? "",
    tripId,
    tripInstanceId: getTripInstanceId(tripId, tripCalls),
    trainNumber: readOptionalString(servingLine.trainNum),
    lineId,
    routeDirectionId: readOptionalString(servingLine.stateless),
    transportMode: parseTransportMode(motType),
    destination: plainDestination,
    minutesUntilDeparture: Math.max(
      0,
      Number.parseInt(readOptionalString(entry.countdown) ?? "", 10) || 0,
    ),
    delayMinutes,
    // `platform` is the signed code (the identity boards group and URLs match on); `pointType` is
    // the operator's word for it.
    platformCode: readOptionalString(entry.platform) ?? "",
    platformKind: parsePlatformKind(readOptionalString(entry.pointType)),
    status: parseDepartureStatus(tripStatus, stopStatus, delayMinutes),
    scheduledDepartureTime,
    predictedDepartureTime,
    serviceNote: joinServiceNotes(serviceNote, findOperatingHint(servingLine.hints)),
    vehicleAccess: findVehicleAccess(servingLine.hints),
    tripLocator: parseTripLocator(entry, servingLine),
    tripCalls,
  };
}

/** All five parts are required; partial provider state must never become a plausible wrong trip. */
function parseTripLocator(
  entry: Record<string, unknown>,
  servingLine: Record<string, unknown>,
): KvvTripLocator | undefined {
  const dateTime = isRecord(entry.dateTime) ? entry.dateTime : undefined;
  const parts = dateTime
    ? [dateTime.year, dateTime.month, dateTime.day, dateTime.hour, dateTime.minute].map((value) =>
        Number.parseInt(readOptionalString(value) ?? "", 10),
      )
    : [];
  const [year, month, day, hour, minute] = parts;
  const tripCode = readOptionalString(servingLine.key);
  const line = readOptionalString(servingLine.stateless);
  const stopPointId = readOptionalString(entry.stopID);
  if (!tripCode || !line || !stopPointId || parts.some((part) => !Number.isFinite(part)))
    return undefined;

  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    tripCode,
    line,
    stopPointId,
    date: `${year}${pad(month)}${pad(day)}`,
    time: `${pad(hour)}${pad(minute)}`,
  };
}

/**
 * A line-direction's whole route, end to end, from the run a locator names: the only reading of
 * where a line goes rather than where its current trips go. Validated against the echoed
 * `diva.stateless`; a wrong `tripCode` comes back as HTTP 200 with an empty sequence.
 */
export function parseLineRouteResponse(payload: unknown, locator: KvvTripLocator): KvvTripCall[] {
  if (!isRecord(payload)) throw new KvvEfaError(`Linie ${locator.line}: unerwartete Antwort`);
  const stopSeqCoords = isRecord(payload.stopSeqCoords) ? payload.stopSeqCoords : undefined;
  const params = isRecord(stopSeqCoords?.params) ? stopSeqCoords.params : undefined;
  const mode = isRecord(params?.mode) ? params.mode : undefined;
  const diva = isRecord(mode?.diva) ? mode.diva : undefined;
  if (readOptionalString(diva?.stateless) !== locator.line) {
    throw new KvvEfaError(`Linie ${locator.line}: nicht gefunden`);
  }

  const route = readRecordList(params?.stopSeq)
    .map((entry) => parseTripCall(entry, false))
    .filter((call): call is KvvTripCall => call !== null);
  if (route.length === 0) throw new KvvEfaError(`Linie ${locator.line}: keine Halte`);
  return route;
}

/**
 * Validates the echoed tuple: a failed lookup is an HTTP 200 with an empty or mismatched answer.
 */
export function parseTripResponse(payload: unknown, locator: KvvTripLocator): KvvTrip {
  if (!isRecord(payload)) throw new KvvEfaError(`Fahrt ${locator.tripCode}: unerwartete Antwort`);
  const echoed = isRecord(payload.vehicleCallAtStop) ? payload.vehicleCallAtStop : undefined;
  const entries = readRecordList(payload.stopSeq);
  const matchesLocator =
    readOptionalString(echoed?.tC) === locator.tripCode &&
    readOptionalString(echoed?.stopID) === locator.stopPointId &&
    readOptionalString(echoed?.line) === locator.line;
  if (!matchesLocator || entries.length === 0) {
    throw new KvvEfaError(`Fahrt ${locator.tripCode}: nicht gefunden`);
  }

  const rowCallIndex = findRowCallIndex(entries, locator);
  const tripCalls = entries
    .map((entry, index) => parseTripCall(entry, index === rowCallIndex))
    .filter((call): call is KvvTripCall => call !== null);
  if (tripCalls.length === 0) throw new KvvEfaError(`Fahrt ${locator.tripCode}: keine Halte`);

  const statuses = entries.map((entry) => readOptionalString(entry.realtimeStatus));
  const status = statuses.some(
    (value) => value === "TRIP_CANCELLED" || value === "DEPARTURE_CANCELLED",
  )
    ? "cancelled"
    : statuses.some((value) => value === "EXTRA_STOPS" || value === "EXTRA_TRIP")
      ? "diverted"
      : undefined;
  return {
    serverTime: parseServerTime(payload.parameters) ?? new Date().toISOString(),
    tripCalls,
    status,
  };
}

/**
 * The index of the call the requested row is about: the call at the echoed stop departing in the
 * locator's minute (compared in the wire's `YYYYMMDD HH:MM` form). A terminus loop reports several
 * calls under one stop id, so the stop alone is ambiguous; the first call there is the fallback.
 */
function findRowCallIndex(
  entries: readonly Record<string, unknown>[],
  locator: KvvTripLocator,
): number {
  const minute = `${locator.date} ${locator.time.slice(0, 2)}:${locator.time.slice(2)}`;
  const atStop = (entry: Record<string, unknown>): boolean => {
    const ref = isRecord(entry.ref) ? entry.ref : undefined;
    return readOptionalString(ref?.id) === locator.stopPointId;
  };
  const rowCallIndex = entries.findIndex((entry) => {
    if (!atStop(entry)) return false;
    const ref = isRecord(entry.ref) ? entry.ref : undefined;
    const departure = readOptionalString(ref?.depDateTimeSec ?? ref?.depDateTime);
    return departure !== undefined && departure.startsWith(minute);
  });
  return rowCallIndex >= 0 ? rowCallIndex : entries.findIndex(atStop);
}

/**
 * A dated run id: `RealtimeTripId` is reused on later dates, so it is paired with the first
 * scheduled call. Exported so a single-trip reading yields the same id as a board's.
 */
export function getTripInstanceId(
  tripId: string | undefined,
  tripCalls:
    | readonly { scheduledArrivalTime?: string; scheduledDepartureTime?: string }[]
    | undefined,
): string | undefined {
  if (!tripId) return undefined;
  const firstCall = tripCalls?.[0];
  const tripStartTime = firstCall?.scheduledDepartureTime ?? firstCall?.scheduledArrivalTime;
  // To the minute: rows publish the first call to the minute, sequences to the second.
  return tripStartTime ? `${tripId}@${tripStartTime.slice(0, 16)}` : tripId;
}

function findAttributeValue(attributes: unknown, name: string): string | undefined {
  if (!Array.isArray(attributes)) return undefined;
  const attribute = attributes.filter(isRecord).find((entry) => entry.name === name);
  return attribute ? readOptionalString(attribute.value) : undefined;
}

/** A sequence of one comes back as a bare object rather than a one-element array. */
function readRecordList(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  return isRecord(value) ? [value] : [];
}

/**
 * The trip's calls, completed with the board's own stop: `prevStopSeq` ends one call before it and
 * `onwardStopSeq` starts one after, so only the row states that call. Without it a mark would skip
 * the stop, and each board would leave the gap in a different place.
 */
function parseTripCalls(
  entry: Record<string, unknown>,
  /** The row's facts about its own call, which the sequence omits. */
  rowCall: { scheduledDepartureTime: string; delayMinutes: number | undefined },
): KvvTripCall[] | undefined {
  const previous = readRecordList(entry.prevStopSeq);
  const onward = readRecordList(entry.onwardStopSeq);
  if (previous.length === 0 && onward.length === 0) return undefined;

  const current = {
    nameWO: entry.nameWO,
    name: entry.stopName,
    platformName: entry.platformName ?? entry.platform,
    // The row states the bare code, the sequence the worded label; diagrams print the label, rows
    // match on the code.
    platform: entry.platform,
    stopID: entry.stopID,
  };
  return [
    ...previous.map((stop) => parseTripCall(stop, false)),
    parseTripCall(current, true, rowCall),
    ...onward.map((stop) => parseTripCall(stop, false)),
  ].filter((call): call is KvvTripCall => call !== null);
}

function parseTripCall(
  entry: Record<string, unknown>,
  isCurrentStop: boolean,
  rowCall?: { scheduledDepartureTime: string; delayMinutes: number | undefined },
): KvvTripCall | null {
  const ref = isRecord(entry.ref) ? entry.ref : undefined;
  // `nameWO` already lacks the locality, and may contain a comma of its own (`Bahnhof, Vorplatz`).
  const nameWithoutPlace = readOptionalString(entry.nameWO);
  const fullName = readOptionalString(entry.name);
  const name = nameWithoutPlace ?? (fullName && removeMunicipalityPrefix(fullName));
  if (!name) return null;
  const coordinates = parseCoordinates(ref?.coords);
  // A terminus carries a placeholder `depDelay: 0` with `depValid: 0`; its real deviation is on the
  // arrival.
  const hasArrival = readOptionalString(ref?.arrValid) !== "0";
  const hasDeparture = readOptionalString(ref?.depValid) !== "0";
  // Planned times with the deviation beside them. Arrival and departure delays are separate facts:
  // a vehicle can arrive four minutes late at a terminus and leave on time.
  const arrivalDelayMinutes = hasArrival ? parseDelayMinutes(ref?.arrDelay) : undefined;
  const departureDelayMinutes = hasDeparture ? parseDelayMinutes(ref?.depDelay) : undefined;
  const scheduledDepartureTime = hasDeparture
    ? parseSequenceTime(ref?.depDateTimeSec ?? ref?.depDateTime)
    : undefined;
  // The sequence omits the board's own call, so the row is the only account of it.
  const delayMinutes =
    departureDelayMinutes ?? arrivalDelayMinutes ?? (ref ? undefined : rowCall?.delayMinutes);
  const platformCode = readOptionalString(ref?.platform) ?? readOptionalString(entry.platform);
  return {
    stopName: name,
    placeName: readOptionalString(entry.place),
    // The operator words some platforms and only numbers others (`Waidweg`: `Gleis 1`, `Gleis 2`,
    // `3`), so the code stands in where no label is given.
    platformLabel: readOptionalString(entry.platformName) ?? platformCode,
    platformCode,
    providerId: readOptionalString(ref?.id) ?? readOptionalString(entry.stopID),
    isCurrentStop: isCurrentStop || undefined,
    latitude: coordinates?.latitude,
    longitude: coordinates?.longitude,
    scheduledArrivalTime: hasArrival
      ? parseSequenceTime(ref?.arrDateTimeSec ?? ref?.arrDateTime)
      : undefined,
    scheduledDepartureTime: ref ? scheduledDepartureTime : rowCall?.scheduledDepartureTime,
    delayMinutes,
    // Stated only where it differs from the departure delay.
    arrivalDelayMinutes: arrivalDelayMinutes === delayMinutes ? undefined : arrivalDelayMinutes,
  };
}

/** `coordOutputFormat=WGS84` answers `longitude,latitude`, in that order. */
function parseCoordinates(value: unknown): { latitude: number; longitude: number } | undefined {
  const [longitude, latitude] = (readOptionalString(value) ?? "").split(",").map(Number);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;
  // The projected grid the feed can fall back to has values no degree can take.
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return undefined;
  return { latitude, longitude };
}

/** Stop sequences state times as `YYYYMMDD HH:MM[:SS]`. */
function parseSequenceTime(value: unknown): string | undefined {
  const match = /^(\d{4})(\d{2})(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    readOptionalString(value) ?? "",
  );
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part ?? 0));
  return resolveNetworkWallTime(Date.UTC(year, month - 1, day, hour, minute, second || 0));
}

/**
 * The published notices, verbatim. Only notices that are published, valid and not deactivated are
 * kept; a withdrawn notice stays in the answer with its flags off.
 */
export function parseServiceNoticeResponse(payload: unknown): KvvServiceNotice[] {
  if (!isRecord(payload) || !isRecord(payload.additionalInformation)) return [];
  const travelInformations = payload.additionalInformation.travelInformations;
  if (!isRecord(travelInformations)) return [];

  return readRecordList(travelInformations.travelInformation)
    .filter(isPublishedNotice)
    .flatMap((entry) => {
      const notice = parseServiceNotice(entry);
      return notice ? [notice] : [];
    });
}

function isPublishedNotice(entry: Record<string, unknown>): boolean {
  return (
    readOptionalString(entry.publish) === "1" &&
    readOptionalString(entry.valid) === "1" &&
    readOptionalString(entry.deactivated) !== "true"
  );
}

function parseServiceNotice(entry: Record<string, unknown>): KvvServiceNotice | null {
  const infoLink = isRecord(entry.infoLink) ? entry.infoLink : undefined;
  const title =
    readOptionalString(infoLink?.infoLinkText) ??
    readOptionalString(infoLink?.subtitle) ??
    readOptionalString(infoLink?.subject);
  const infoId = readOptionalString(entry.infoID);
  if (!title || !infoId) return null;

  const { validFrom, validUntil } = parseValidityPeriod(entry.validityPeriod);
  return {
    // A revised notice is republished under a new sequence number.
    id: `${infoId}@${readOptionalString(entry.seqID) ?? "0"}`,
    title,
    lineNumbers: [
      ...new Set(
        readRecordList(entry.concernedLines).flatMap((line) => {
          const number = normalizeNoticeLineNumber(readOptionalString(line.number));
          return number ? [number] : [];
        }),
      ),
    ],
    concernedStops: readRecordList(entry.concernedStops).flatMap((stop) => {
      const name = readOptionalString(stop.name);
      return name ? [{ providerId: readOptionalString(stop.stopID), name }] : [];
    }),
    details: parseNoticeDetails(readOptionalString(infoLink?.htmlText)),
    validFrom,
    validUntil,
    priority: readOptionalString(entry.priority) === "high" ? "high" : "normal",
  };
}

/**
 * Strips a notice's zero padding (`007` is line `7`). Suffixes stay (`104s` is not `104`); the
 * comparison ignores their case.
 */
export function normalizeNoticeLineNumber(number: string | undefined): string | undefined {
  const trimmed = number?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^0+(?=[A-Za-z]*\d)/, "");
}

/** From the earliest period the notice names to the latest. */
function parseValidityPeriod(value: unknown): { validFrom?: string; validUntil?: string } {
  const periods = readRecordList(value);
  const from = periods
    .flatMap((period) => parseNoticeDateTime(period.itdDateTime_From) ?? [])
    .sort();
  const until = periods
    .flatMap((period) => parseNoticeDateTime(period.itdDateTime_To) ?? [])
    .sort();
  return { validFrom: from[0], validUntil: until[until.length - 1] };
}

function parseNoticeDateTime(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.itdDate)) return undefined;
  const date = value.itdDate;
  const time = isRecord(value.itdTime) ? value.itdTime : {};
  const parts = [date.year, date.month, date.day, time.hour ?? "0", time.minute ?? "0"].map(
    (part) => Number.parseInt(readOptionalString(part) ?? "", 10),
  );
  if (parts.some((part) => !Number.isFinite(part))) return undefined;
  const [year, month, day, hour, minute] = parts;
  return resolveNetworkWallTime(Date.UTC(year, month - 1, day, hour, minute));
}

/** The notice's rich text as plain paragraphs: tags stripped, breaks become paragraphs. */
function parseNoticeDetails(html: string | undefined): string[] {
  if (!html) return [];
  return html
    .replace(/<\/(?:p|div|li|tr|h[1-6])\s*>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .split("\n")
    .map((line) => decodeHtmlEntities(line).replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0);
}

/** The named entities the operator's text uses, plus the numeric form. */
const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  auml: "ä",
  ouml: "ö",
  uuml: "ü",
  Auml: "Ä",
  Ouml: "Ö",
  Uuml: "Ü",
  szlig: "ß",
  bull: "•",
  ndash: "–",
  mdash: "—",
  euro: "€",
  hellip: "…",
  rarr: "→",
  laquo: "«",
  raquo: "»",
  bdquo: "„",
  ldquo: "“",
  rdquo: "”",
  sbquo: "‚",
  lsquo: "‘",
  rsquo: "’",
  deg: "°",
};

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#\d+|#[xX][0-9a-fA-F]+|[A-Za-z]+);/g, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const code =
        entity[1] === "x" || entity[1] === "X"
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    return HTML_ENTITIES[entity] ?? match;
  });
}

function parseDepartureStatus(
  tripStatus: string | undefined,
  stopStatus: string | undefined,
  delay: number | undefined,
): DepartureStatus {
  if (tripStatus === "TRIP_CANCELLED" || stopStatus === "DEPARTURE_CANCELLED") return "cancelled";
  if (tripStatus === "EXTRA_STOPS" || tripStatus === "EXTRA_TRIP") return "diverted";
  return delay === undefined ? "scheduled" : "realtime";
}

/**
 * The modes read: Stadtbahn, S-Bahn, tram and local buses (including `Ersatzverkehr`). The bus
 * group a board is asked for also carries long-distance coaches (Flixbus at Hauptbahnhof), and only
 * `motType` tells them apart.
 */
const LOCAL_NETWORK_MOT_TYPES = new Set(["1", "4", "5", "6", "11"]);

/** An unstated mode is unknown, not foreign. */
function isLocalNetworkMode(motType: string | undefined): boolean {
  return motType === undefined || LOCAL_NETWORK_MOT_TYPES.has(motType);
}

/**
 * The data pool of KVV's own lines, the first segment of a line id (`kvv:22304:E:H:s26`). The
 * server also answers for other pools that share KVV's modes: DB's S-Bahn Rhein-Neckar (S3, S6, S9,
 * since December 2025) and `rab:` rail replacement. Measured 5 September 2026.
 */
const LOCAL_NETWORK_POOL = "kvv";

/** An unstated pool is unknown, not foreign. */
function isLocalNetworkPool(lineStatelessId: string | undefined): boolean {
  if (lineStatelessId === undefined) return true;
  const pool = lineStatelessId.slice(0, lineStatelessId.indexOf(":"));
  return !lineStatelessId.includes(":") || pool === LOCAL_NETWORK_POOL;
}

/** A line of the local network: a local mode and the operator's own pool. */
function isLocalNetworkLine(
  motType: string | undefined,
  lineStatelessId: string | undefined,
): boolean {
  return isLocalNetworkMode(motType) && isLocalNetworkPool(lineStatelessId);
}

function parseTransportMode(motType: string | undefined): TransportMode {
  if (motType === "1") return "lightRail";
  if (motType === "4") return "tram";
  if (motType === "5" || motType === "6" || motType === "11") return "bus";
  return "other";
}

/**
 * `Gleis` (rail) or `Bstg.` (bus stand); anything else is left unstated, not guessed from the mode.
 */
function parsePlatformKind(pointType: string | undefined): PlatformKind | undefined {
  const stated = pointType?.trim().toLowerCase();
  if (stated === "gleis" || stated === "bahnsteig") return "track";
  if (stated === "bstg" || stated === "bstg." || stated === "bussteig") return "stand";
  return undefined;
}

/**
 * Operational remarks KVV appends to destinations (`Waldstadt > SEV ab Hirtenweg`,
 * `Heide (Umleitung)`). A parenthesis counts only with operational vocabulary: `Söllingen (b.
 * Karlsruhe)` is part of the place name.
 */
const OPERATIONAL_REMARK_PATTERN = new RegExp(
  `${EXCEPTIONAL_OPERATION_WORDS}|entfällt|sonderfahrt|verstärker|nur bis|ab \\S`,
  "i",
);

function splitDestination(destination: string): [string, string | undefined] {
  const chevron = destination.indexOf(">");
  if (chevron > 0) {
    return [
      destination.slice(0, chevron).trim(),
      destination.slice(chevron + 1).trim() || undefined,
    ];
  }

  const suffix = /\s*\(([^()]+)\)\s*$/.exec(destination);
  if (suffix && OPERATIONAL_REMARK_PATTERN.test(suffix[1])) {
    return [destination.slice(0, suffix.index).trim(), suffix[1].trim()];
  }

  return [destination.trim(), undefined];
}

function parseDelayMinutes(value: unknown): number | undefined {
  const delay = Number.parseInt(readOptionalString(value) ?? "", 10);
  if (!Number.isFinite(delay) || delay === NO_PREDICTION_DELAY_MINUTES) return undefined;
  return delay;
}

/**
 * EFA times are Karlsruhe wall time with no offset; they are resolved to an instant here, at the
 * boundary, so they are not read as the viewer's local time.
 */
function parseDateTime(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const dateComponents = ["year", "month", "day", "hour", "minute"].map((key) =>
    Number.parseInt(readOptionalString(value[key]) ?? "", 10),
  );
  if (dateComponents.some((component) => !Number.isFinite(component))) return undefined;
  const [year, month, day, hour, minute] = dateComponents;
  return resolveNetworkWallTime(Date.UTC(year, month - 1, day, hour, minute));
}

/** Reads the offset twice, which settles every hour but the ambiguous one at a DST change. */
function resolveNetworkWallTime(wallTime: number): string {
  const firstGuess = wallTime - getNetworkOffsetMs(wallTime);
  return new Date(wallTime - getNetworkOffsetMs(firstGuess)).toISOString();
}

function getNetworkOffsetMs(instant: number): number {
  const offset = networkOffsetFormat
    .formatToParts(instant)
    .find((part) => part.type === "timeZoneName")?.value;
  const [, sign, hours, minutes] = /^GMT([+-])(\d{2}):(\d{2})$/.exec(offset ?? "") ?? [];
  if (!sign) return 0;
  return (sign === "-" ? -1 : 1) * (Number(hours) * 60 + Number(minutes)) * 60_000;
}

/**
 * The feed's clock as an instant. It has no offset, like `parseDateTime`'s input, and every
 * countdown is counted from it. Seconds are kept for the board's age.
 */
function parseServerTime(parameters: unknown): string | undefined {
  if (!Array.isArray(parameters)) return undefined;
  const entry = parameters
    .filter(isRecord)
    .find((parameter) => parameter.name === "serverTime" && typeof parameter.value === "string");
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    readOptionalString(entry?.value) ?? "",
  );
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  return resolveNetworkWallTime(Date.UTC(year, month - 1, day, hour, minute, second || 0));
}

/** EFA prefixes names with the municipality, which the views already show. */
function removeMunicipalityPrefix(name: string): string {
  return name.replace(/^[^,]+,\s*/, "");
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number") return String(value);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
