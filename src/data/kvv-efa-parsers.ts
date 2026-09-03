/**
 * Decoding of the KVV EFA wire format, and the wire types it answers with.
 *
 * Everything here is a pure function from the provider's JSON to typed values (or an error naming
 * what could not be read). The HTTP transport lives beside it in `kvv-efa-client.ts`.
 */
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
/** `filterDateValid` wants the network's own calendar day, in the operator's `DD.MM.YYYY` spelling. */
const networkDateFormat = new Intl.DateTimeFormat("de-DE", {
  timeZone: NETWORK_TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

/** EFA reports "no realtime prediction available" as this sentinel instead of omitting the field. */
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
  /** Dated identity retained for matching older shared links and deduplicating operating instances. */
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
  platformName: string;
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
 * One line-direction a stop monitor knows, and the line a rider knows it as.
 *
 * The pairing is the point. A provider direction id is opaque — `kvv:22304:E:H:s26` says nothing
 * about being S4 — so an id read off a departure can only be attributed to the line that departure
 * is on, and a line with no departure due within the board's few rows can then not be named at all.
 * The stop states the pairing itself, for every line calling there and whether or not one is due.
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

/**
 * One published notice, still in the operator's own terms: the lines it names as the operator
 * spells them, and the provider stop ids it names, for the source to resolve into our own.
 */
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
 * The points a stop search answered with.
 *
 * A finder that matched several stops answers with a list of them; one that matched exactly one
 * answers with that point wrapped in an object instead — `{ points: { point: {…} } }`. Reading the
 * list shape alone therefore lost every search that succeeded outright, which is exactly what a
 * deep link performs: a stop whose name matches nothing else could not be resolved by the one
 * query that names it precisely.
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
    ? readRecordList(payload.servingLines.lines).filter((line) =>
        isLocalNetworkMode(readOptionalString(isRecord(line.mode) ? line.mode.type : undefined)),
      )
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
 * Boarding, as the feed states it — and only as it states it.
 *
 * The hint vocabulary carries both directions: `Stufenloses Fahrzeug` and `Niederflurwagen` state a
 * step-free vehicle, and `Nicht barrierefreies Fahrzeug` states the opposite of one. The negation
 * is read first, because it contains the very word the positive is matched by. A trip whose hints
 * mention boarding at all is therefore answered; one whose hints do not is left unanswered, which
 * is a third state and never the same as `notStepFree`.
 */
const NOT_STEP_FREE_PATTERN = /nicht\s+(barrierefrei|stufenlos|rollstuhl)/i;
const STEP_FREE_PATTERN = /stufenlos|niederflur|barrierefrei|behindertengerecht|einstiegshilfe/i;

/**
 * Hints that say how the trip is *running*, as opposed to what the vehicle carries.
 *
 * The feed uses one field for both: `Verspätung eines vorausfahrenden Zuges` is the reason a rider
 * is standing on a platform, and `Bordrestaurant` is not. Only the first kind is a note this app
 * has anywhere to put; the equipment vocabulary is recognised in order to be left out, because a
 * board that repeats `WLAN` on every row has spent its most scannable column on nothing.
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

/** The operating remarks among the hints, as one note. Equipment hints are deliberately dropped. */
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
 * The deviation a row publishes, measured against the prediction where the feed made one.
 *
 * `delay` is truncated to the minute below and `realDateTime` is not, so the two disagree on about
 * one monitored row in twenty (see `docs/kvv-efa-api.md`). Only the call this row completes can be
 * corrected this way; every other call in a sequence has the stated deviation and nothing else.
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
 * The line-directions a stop states for itself, each under the name its departures carry.
 *
 * Named the same way a row is (`symbol` before `number`), because the whole use of this is to
 * recognise a line by the id a departure of it would have stated — read from a different corner of
 * the same answer, and available when no departure of that line is due.
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
    if (!directionId || byDirectionId.has(directionId)) continue;
    byDirectionId.set(directionId, lineId ? { lineId, directionId } : { directionId });
  }
  return [...byDirectionId.values()];
}

function parseDeparture(entry: Record<string, unknown>): KvvDeparture | null {
  const servingLine = isRecord(entry.servingLine) ? entry.servingLine : null;
  const lineId = readOptionalString(servingLine?.symbol) ?? readOptionalString(servingLine?.number);
  const destination = readOptionalString(servingLine?.direction);
  if (!servingLine || !lineId || !destination) return null;
  if (!isLocalNetworkMode(readOptionalString(servingLine.motType))) return null;

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
  // The row is also the one statement of the call at its own stop, which the sequence itself omits —
  // and the only one of this trip's calls with a prediction behind it, because a stop sequence
  // carries scheduled times and deviations alone. Completed from the stated delay it would publish
  // a minute earlier than the row it was read from, which is the same departure drawn twice on one
  // screen: the board row beside the diagram, disagreeing with the diagram's row for this stop.
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
    transportMode: parseTransportMode(readOptionalString(servingLine.motType)),
    destination: plainDestination,
    minutesUntilDeparture: Math.max(
      0,
      Number.parseInt(readOptionalString(entry.countdown) ?? "", 10) || 0,
    ),
    delayMinutes,
    // `platform` is the bare code the platform is signed with; `pointType` is the word the feed
    // puts in front of it. They are carried apart so the code stays the identity a board groups
    // and a URL matches on, and the word stays the operator's rather than the app's.
    platformName: readOptionalString(entry.platform) ?? "",
    platformKind: parsePlatformKind(readOptionalString(entry.pointType)),
    status: parseDepartureStatus(tripStatus, stopStatus, delayMinutes),
    scheduledDepartureTime,
    predictedDepartureTime,
    // The destination's own remark and the feed's operating hint are both about this trip, so they
    // are stated as one note rather than as two fields every surface would have to render twice.
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
 * One line-direction's whole route, from the run a locator names.
 *
 * The same shape a trip sequence has, and read by the same call parser — but it is a different
 * fact. A trip's sequence is what one vehicle is doing; this is where the line goes, stated from
 * end to end whatever part of it the run was asked about. It is the only reading that says so:
 * everywhere else the route is inferred from the trips that happen to be out, which is always less
 * than the line.
 *
 * Validated against the echoed `diva.stateless` rather than the trip tuple, because that is what
 * the answer restates — a wrong `tripCode` comes back as HTTP 200 with an empty sequence, exactly
 * as it does on the trip endpoint.
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
 * A successful HTTP response can still be an empty or mismatched provider lookup. Validate the
 * echoed tuple before accepting its sequence, because EFA otherwise supplies no useful error.
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

  const tripCalls = entries
    .map((entry) => {
      const ref = isRecord(entry.ref) ? entry.ref : undefined;
      return parseTripCall(entry, readOptionalString(ref?.id) === locator.stopPointId);
    })
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
 * `RealtimeTripId` describes a timetable trip and is reused on later operating dates. Pairing it
 * with the first scheduled call identifies the dated run while remaining identical on every board
 * that returns the trip's complete stop sequence.
 *
 * Exported because a single-trip reading states the same run's first call too, and one vehicle must
 * not end up with two dated identities: the diagram follows a mark by this id, and two ids for one
 * trip are two marks for one vehicle.
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
  // To the minute, because the same call is published to the minute on a row and to the second in a
  // sequence: a board read at the trip's own origin states that first call as its row, and the id
  // has to be the one every other board's reading of the vehicle produces, not a second identity
  // for it. Which minute a run starts in separates today's from tomorrow's just as well.
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
 * The trip as this row states it — including the call at the board's own stop, which the sequence
 * itself leaves out.
 *
 * `prevStopSeq` stops one call short of the stop the board was read at and `onwardStopSeq` starts
 * one call past it: the call between them exists only as the row above, which states both of its
 * facts — the published time and the deviation — and is therefore what completes it.
 *
 * Left uncompleted that call is a hole rather than a neutral omission, because a call with no time
 * cannot carry a vehicle: placement drops it, so the mark ran the two links either side of the
 * stop as one and never stood at it. Worse, every board reads the same trip with the hole in a
 * *different* place, so two readings of one vehicle disagree about which stops it calls at, and a
 * mark re-anchored from one onto the other steps back down the line.
 */
function parseTripCalls(
  entry: Record<string, unknown>,
  /** What the row publishes about its own call: the two facts the sequence does not state here. */
  rowCall: { scheduledDepartureTime: string; delayMinutes: number | undefined },
): KvvTripCall[] | undefined {
  const previous = readRecordList(entry.prevStopSeq);
  const onward = readRecordList(entry.onwardStopSeq);
  if (previous.length === 0 && onward.length === 0) return undefined;

  const current = {
    nameWO: entry.nameWO,
    name: entry.stopName,
    platformName: entry.platformName ?? entry.platform,
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
  /** Stated by the row rather than by the sequence, and only for the call the row is about. */
  rowCall?: { scheduledDepartureTime: string; delayMinutes: number | undefined },
): KvvTripCall | null {
  const ref = isRecord(entry.ref) ? entry.ref : undefined;
  // `nameWO` is the feed's own name without the locality, so it needs no prefix removed — and the
  // regex would cut a name that carries a comma of its own (`Bahnhof, Vorplatz`). Only the full
  // `name` is prefixed, and only in the comma form the departure board's own point uses.
  const nameWithoutPlace = readOptionalString(entry.nameWO);
  const fullName = readOptionalString(entry.name);
  const name = nameWithoutPlace ?? (fullName && removeMunicipalityPrefix(fullName));
  if (!name) return null;
  const coordinates = parseCoordinates(ref?.coords);
  // A terminus still carries a placeholder `depDelay: 0`, but marks that departure invalid and
  // states the vehicle's real deviation on its arrival. Reading the placeholder first makes a
  // delayed trip appear to finish before it reaches the preceding stops, so its marker disappears.
  const hasArrival = readOptionalString(ref?.arrValid) !== "0";
  const hasDeparture = readOptionalString(ref?.depValid) !== "0";
  // The sequence states planned times; the deviation is carried beside them, not folded in. Both
  // ends of the call are read, because they are separate facts: the feed reports a vehicle pulling
  // into a terminus four minutes down and leaving it on time, and the recovery happens between the
  // two numbers. The departure side remains the headline the rows print.
  const arrivalDelayMinutes = hasArrival ? parseDelayMinutes(ref?.arrDelay) : undefined;
  const departureDelayMinutes = hasDeparture ? parseDelayMinutes(ref?.depDelay) : undefined;
  const scheduledDepartureTime = hasDeparture
    ? parseSequenceTime(ref?.depDateTimeSec ?? ref?.depDateTime)
    : undefined;
  // The sequence says nothing at all about the board's own call, so there the row is not a second
  // account to be reconciled with this one — it is the only account there is.
  const delayMinutes =
    departureDelayMinutes ?? arrivalDelayMinutes ?? (ref ? undefined : rowCall?.delayMinutes);
  return {
    stopName: name,
    // The locality is stated beside the name rather than folded into it: which municipality a
    // `Bahnhof` belongs to is what the views outside it have to add back.
    placeName: readOptionalString(entry.place),
    platformName: readOptionalString(entry.platformName),
    providerId: readOptionalString(ref?.id) ?? readOptionalString(entry.stopID),
    isCurrentStop: isCurrentStop || undefined,
    latitude: coordinates?.latitude,
    longitude: coordinates?.longitude,
    scheduledArrivalTime: hasArrival
      ? parseSequenceTime(ref?.arrDateTimeSec ?? ref?.arrDateTime)
      : undefined,
    scheduledDepartureTime: ref ? scheduledDepartureTime : rowCall?.scheduledDepartureTime,
    delayMinutes,
    // Stated only where it says something the headline does not, so a reading of it never has to
    // ask whether the two numbers came from one field or two.
    arrivalDelayMinutes: arrivalDelayMinutes === delayMinutes ? undefined : arrivalDelayMinutes,
  };
}

/** `coordOutputFormat=WGS84` answers `longitude,latitude`, in that order. */
function parseCoordinates(value: unknown): { latitude: number; longitude: number } | undefined {
  const [longitude, latitude] = (readOptionalString(value) ?? "").split(",").map(Number);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;
  // The projected grid the feed falls back to reads as huge numbers, never as a Karlsruhe degree.
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return undefined;
  return { latitude, longitude };
}

/** Stop sequences state times as `YYYYMMDD HH:MM[:SS]`, not as the component object a departure uses. */
function parseSequenceTime(value: unknown): string | undefined {
  const match = /^(\d{4})(\d{2})(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    readOptionalString(value) ?? "",
  );
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part ?? 0));
  return resolveNetworkWallTime(Date.UTC(year, month - 1, day, hour, minute, second || 0));
}

/**
 * The published notices, as the operator states them.
 *
 * A notice is kept only where the operator is still standing behind it: `publish`, `valid` and
 * `deactivated` are three separate flags, and a notice that has been withdrawn keeps its entry in
 * the answer with the flags turned off rather than disappearing from it. Nothing here summarises,
 * ranks or rewrites the text — the title is the operator's own, and the full wording stays a link
 * to the operator's page.
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
    // The same notice is republished under a new sequence number when its text is revised, so both
    // parts identify the reading in hand.
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
 * A notice spells a line number the way its own system stores it — `007` for the bus a departure
 * board calls `7` — so the padding comes off before anything compares them. A suffix is part of the
 * number and stays as published: `104s` and `104` are different lines, and which case the operator
 * writes the suffix in is not, which is why the comparison itself is what ignores case.
 */
export function normalizeNoticeLineNumber(number: string | undefined): string | undefined {
  const trimmed = number?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^0+(?=[A-Za-z]*\d)/, "");
}

/** The whole span the operator states, from the earliest period it names to the latest. */
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

/** Notices state a time as a nested date and time record rather than as the departure's flat one. */
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

/**
 * The operator's own wording, split into the paragraphs it wrote it in.
 *
 * The notice feed carries the full text beside the headline, so the whole of what was published is
 * already in hand. It arrives as the rich text of the operator's editor — emphasis, colours, a
 * bullet drawn as a character — and none of that is markup this app renders: the words are the
 * fact, so the tags come off and the breaks between them become the paragraphs a reader sees.
 */
function parseNoticeDetails(html: string | undefined): string[] {
  if (!html) return [];
  return html
    .replace(/<\/(?:p|div|li|tr|h[1-6])\s*>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .split("\n")
    .map((line) => decodeHtmlEntities(line).replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0);
}

/** The named entities the operator's German text actually uses, plus the numeric form. */
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
 * The modes this app reads: Stadtbahn and S-Bahn, tram, and every kind of local bus, including the
 * replacement services the operator runs as `Ersatzverkehr`.
 *
 * A board is already asked for these modes (`kvv-efa-client.ts`), but the feed's mode groups are
 * coarser than its `motType`: the bus group carries long-distance coaches — Flixbus at
 * Hauptbahnhof — which no rider opens a Karlsruhe board for, and they arrive both as rows and as
 * serving directions the coverage pass would then go and query. This is where a `motType` is
 * visible, so this is where they are left out.
 */
const LOCAL_NETWORK_MOT_TYPES = new Set(["1", "4", "5", "6", "11"]);

/** An unstated mode is unknown, not foreign: only a mode the feed states and names is left out. */
function isLocalNetworkMode(motType: string | undefined): boolean {
  return motType === undefined || LOCAL_NETWORK_MOT_TYPES.has(motType);
}

function parseTransportMode(motType: string | undefined): TransportMode {
  if (motType === "1") return "lightRail";
  if (motType === "4") return "tram";
  if (motType === "5" || motType === "6" || motType === "11") return "bus";
  return "other";
}

/**
 * The feed's word for the boarding place: `Gleis` where the departure is rail-bound, `Bstg.` where
 * it is a bus stand. Anything else — including the entries that state no `pointType` at all — is
 * left unstated rather than guessed, because the mode of the line does not decide it.
 */
function parsePlatformKind(pointType: string | undefined): PlatformKind | undefined {
  const stated = pointType?.trim().toLowerCase();
  if (stated === "gleis" || stated === "bahnsteig") return "track";
  if (stated === "bstg" || stated === "bstg." || stated === "bussteig") return "stand";
  return undefined;
}

/**
 * KVV appends operational remarks to the destination, for example
 * `Waldstadt > SEV ab Hirtenweg` or `Heide (Umleitung)`. Keeping them out of the destination keeps
 * the board scannable while preserving the information next to it. A parenthesis is only a remark
 * when it uses operational vocabulary: `Söllingen (b. Karlsruhe)` disambiguates a place and belongs
 * to the destination itself.
 */
const OPERATIONAL_REMARK_PATTERN = new RegExp(
  `${EXCEPTIONAL_OPERATION_WORDS}|entfällt|sonderfahrt|verstärker|nur bis|ab \\S`,
  "i",
);

export function splitDestination(destination: string): [string, string | undefined] {
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
 * EFA states departure times as bare local components with no offset. Left that way they would be
 * read as the *viewer's* local time, which puts every prediction hours off the clock outside
 * Germany and silently drops every vehicle marker, so the Karlsruhe wall time is resolved to a real
 * instant here — once, at the provider boundary — and travels the app as an absolute timestamp.
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

/**
 * The offset itself depends on the instant, which is what is being solved for. Reading it a
 * second time at the first answer settles every hour except the ambiguous one a DST change makes.
 */
function resolveNetworkWallTime(wallTime: number): string {
  const firstGuess = wallTime - getNetworkOffsetMs(wallTime);
  return new Date(wallTime - getNetworkOffsetMs(firstGuess)).toISOString();
}

/** How far ahead of UTC the network's own timezone runs at a given instant. */
function getNetworkOffsetMs(instant: number): number {
  const offset = networkOffsetFormat
    .formatToParts(instant)
    .find((part) => part.type === "timeZoneName")?.value;
  const [, sign, hours, minutes] = /^GMT([+-])(\d{2}):(\d{2})$/.exec(offset ?? "") ?? [];
  if (!sign) return 0;
  return (sign === "-" ? -1 : 1) * (Number(hours) * 60 + Number(minutes)) * 60_000;
}

/**
 * The feed's own clock, resolved to a real instant.
 *
 * Stated as `YYYY-MM-DDTHH:MM:SS` with no offset, which `Date.parse` reads as the *viewer's* local
 * time — the same hazard `parseDateTime` exists to avoid, and the one that matters most, because
 * every countdown in the app is counted from this clock rather than the device's. Left unresolved
 * it is right in Karlsruhe and hours out everywhere else, which reads as a board where nothing is
 * ever due. The seconds are kept: they are what the board's stated age is measured against.
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

/** EFA prefixes names with the municipality, which the views already provide as context. */
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
