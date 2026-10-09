import { labelByTransportMode } from "../data/line-signs";
import type { Departure, DepartureBoard, TripCall } from "../data/transit-types";
import { findExpectedDepartureInstant, getBoardAgeMs, getCountdownMinutes } from "./feed-clock";
import { formatSpokenPlatformLabel } from "./platform-naming";
import { formatDistance } from "./geo";
import type { RideProgress } from "./ride-progress";
import { isSelectedLine, type LineSelection } from "./line-bundles";
import { getCallsAfterCurrentStop, getTripCallInstant } from "./trip-calls";
import { isSameRun } from "./trips";

/** Times are read off the Karlsruhe clock wherever the viewer is. */
const clockFormat = new Intl.DateTimeFormat("de-DE", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Berlin",
});

export function formatClockTime(value: string | Date): string {
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? "–" : clockFormat.format(parsed);
}

/** A spoken deviation; `+3` reads as two unrelated tokens. */
function getDeviationPhrase(delayMinutes: number): string {
  const minutes = Math.abs(delayMinutes);
  return `${minutes} ${minutes === 1 ? "Minute" : "Minuten"} ${delayMinutes > 0 ? "später" : "früher"} als geplant`;
}

/**
 * The one time a rider is given (schedule plus deviation), and the schedule it moved from, shown
 * struck through rather than as "14:32 +3".
 */
export type DepartureTimeReading = {
  /** The schedule with its deviation added. */
  expectedTime: string;
  /** The schedule, only where a deviation moved the departure off it. */
  scheduledTime?: string;
  punctuality: "unmonitored" | "punctual" | "late" | "early";
  accessibilityLabel: string;
};

/**
 * A published time from a schedule and its deviation. No deviation means unmonitored, not on time.
 */
function getPublishedTimeReading(
  scheduledTime: string,
  delayMinutes: number | undefined,
): DepartureTimeReading | undefined {
  const scheduledInstant = Date.parse(scheduledTime);
  if (!Number.isFinite(scheduledInstant)) return undefined;
  const scheduledClockTime = formatClockTime(new Date(scheduledInstant));

  if (delayMinutes === undefined) {
    return {
      expectedTime: scheduledClockTime,
      punctuality: "unmonitored",
      accessibilityLabel: `${scheduledClockTime} nach Fahrplan`,
    };
  }
  if (delayMinutes === 0) {
    return {
      expectedTime: scheduledClockTime,
      punctuality: "punctual",
      accessibilityLabel: `${scheduledClockTime}, pünktlich`,
    };
  }

  const expectedTime = formatClockTime(new Date(scheduledInstant + delayMinutes * 60_000));
  return {
    expectedTime,
    scheduledTime: scheduledClockTime,
    punctuality: delayMinutes > 0 ? "late" : "early",
    accessibilityLabel: `${expectedTime}, ${getDeviationPhrase(delayMinutes)}, planmäßig ${scheduledClockTime}`,
  };
}

type DepartureTimeFacts = Pick<
  Departure,
  "scheduledDepartureTime" | "predictedDepartureTime" | "delayMinutes"
>;

/**
 * The row's deviation, derived from the feed's expected instant (`findExpectedDepartureInstant`):
 * the stated delay is truncated, so it can read "pünktlich" for a vehicle predicted a minute late.
 */
function findPublishedDelayMinutes(departure: DepartureTimeFacts): number | undefined {
  const scheduled = Date.parse(departure.scheduledDepartureTime);
  const expected = findExpectedDepartureInstant(
    departure.scheduledDepartureTime,
    departure.predictedDepartureTime,
    departure.delayMinutes,
  );
  // Unmonitored stays unmonitored; zero would claim on time.
  if (expected === undefined || !Number.isFinite(scheduled)) return departure.delayMinutes;
  if (departure.predictedDepartureTime === undefined) return departure.delayMinutes;
  return Math.round((expected - scheduled) / 60_000);
}

/** The time a row publishes. A cancelled trip gets no deviation applied. */
export function getDepartureTimeReading(
  departure: DepartureTimeFacts & Pick<Departure, "status">,
): DepartureTimeReading | undefined {
  return getPublishedTimeReading(
    departure.scheduledDepartureTime,
    departure.status === "cancelled" ? undefined : findPublishedDelayMinutes(departure),
  );
}

/**
 * The punctuality column, only for what the time cannot say: "nach Fahrplan" for an unmonitored
 * trip. An on-time trip needs no word, and a deviation is already in the time.
 */
export function getDepartureStatusLabel(departure: Departure): string | undefined {
  if (departure.status === "cancelled") return "entfällt";
  // A diversion outranks punctuality.
  if (departure.status === "diverted") return "Umleitung";
  // The same deviation the time was published from.
  if (findPublishedDelayMinutes(departure) === undefined) return "nach Fahrplan";
  return undefined;
}

/**
 * The boarding a row prints: only the exception. Nearly every vehicle is step-free, so printing it
 * on every row would bury the one that is not. The full reading is spoken.
 */
export function getVehicleAccessLabel(departure: Departure): string | undefined {
  return departure.vehicleAccess === "notStepFree" ? "nicht barrierefrei" : undefined;
}

/** The spoken boarding reading. Silence is never spoken as a vehicle with steps. */
function getSpokenVehicleAccess(departure: Departure): string | undefined {
  if (departure.vehicleAccess === "stepFree") return "stufenloser Einstieg";
  if (departure.vehicleAccess === "notStepFree") return "nicht barrierefreies Fahrzeug";
  return undefined;
}

/** The countdown column. A cancelled trip says so instead of showing a dash. */
export type CountdownReading =
  | { kind: "cancelled"; label: string }
  | { kind: "due"; label: string }
  | { kind: "minutes"; minutes: number; label: string };

export function getCountdownReading(departure: Departure, feedNow: number): CountdownReading {
  if (departure.status === "cancelled") return { kind: "cancelled", label: "entfällt" };
  const minutes = getCountdownMinutes(departure, feedNow);
  return minutes <= 0
    ? { kind: "due", label: "jetzt" }
    : { kind: "minutes", minutes, label: `${minutes} min` };
}

/**
 * Whether a row reads as selected: the pinned trip, else every trip of the selected lines. Matched
 * by vehicle (`isSameRun`), since a trip calling at two of a complex's places has two rows
 * (Europaplatz: `Gleis 6` at 13:43, `Gleis 4` at 13:44).
 */
export function isDepartureSelected(
  departure: Departure,
  selectedDeparture: Departure | undefined,
  lineSelection: LineSelection | undefined,
): boolean {
  return selectedDeparture
    ? isSameRun(departure, selectedDeparture)
    : Boolean(lineSelection && isSelectedLine(lineSelection, departure.lineId));
}

/**
 * Whether this row is the addressed trip, matched by vehicle, so tapping it steps up to the line.
 */
export function isDeparturePinned(
  departure: Departure,
  selectedDeparture: Departure | undefined,
): boolean {
  return Boolean(selectedDeparture && isSameRun(departure, selectedDeparture));
}

/** The next few calls after this stop: the `über …` a rider checks before boarding. */
export function getViaSummary(departure: Departure, callCount = 3): string {
  // The last call is the destination the row already states.
  const via = getCallsAfterCurrentStop(departure)
    .slice(0, -1)
    .map((call) => call.stopName);
  return via.slice(0, callCount).join(" · ");
}

/** The board's age once it is old enough to matter, and a failed refresh as soon as it happens. */
export function getStaleBoardLabel(
  departureBoard: DepartureBoard | null,
  feedNow: number,
): string | undefined {
  if (!departureBoard || departureBoard.dataStatus !== "live") return undefined;
  const ageMinutes = Math.floor(getBoardAgeMs(departureBoard, feedNow) / 60_000);
  const readAt = `Stand ${formatClockTime(departureBoard.feedUpdatedAt)}`;
  if (ageMinutes >= 2) return `${readAt} · seit ${ageMinutes} Min ohne Aktualisierung`;
  // A failed refresh is said at once, before the board is old enough to count as stale.
  return departureBoard.refreshFailedAt !== undefined
    ? `${readAt} · Aktualisierung fehlgeschlagen`
    : undefined;
}

/** Compact exception status for the line diagram. */
export function getLineDiagramStatusLabel(
  departure: Departure | undefined,
  departureBoard: DepartureBoard | null,
): string | undefined {
  if (departure?.status === "cancelled") return "entfällt";
  if (departure?.status === "diverted") return "Umleitung";
  if (!departureBoard) return "lädt";
  return departureBoard.dataStatus === "live" ? undefined : "nicht verfügbar";
}

/**
 * Why the pinned trip has no mark on its line (not started yet, or position unknown), read off the
 * same calls as the placement so it cannot contradict the diagram.
 */
export function getRunPositionHint(
  departure: Departure | undefined,
  /** Whether the diagram carries a mark for this trip. */
  isPlaced: boolean,
  feedNow: number,
): string | undefined {
  const calls = departure?.tripCalls ?? [];
  // Without a sequence there is no drawn line, and the diagram says so itself.
  if (!departure || isPlaced || calls.length < 2) return undefined;
  if (departure.status === "cancelled") return "Entfällt · keine Position auf der Linie";

  const firstCall = calls[0];
  const startInstant = getTripCallInstant(firstCall);
  if (startInstant !== undefined && feedNow < startInstant) {
    // The first call's published time, deviation included.
    const reading = getTripCallTimeReading(firstCall, feedNow);
    return `Noch nicht unterwegs · Start ${reading?.expectedTime ?? formatClockTime(new Date(startInstant))} ab ${firstCall.stopName}`;
  }

  const lastCall = calls[calls.length - 1];
  const endInstant = getTripCallInstant(lastCall, "arrival");
  if (endInstant !== undefined && feedNow > endInstant) {
    return `Fahrt beendet · ${formatClockTime(new Date(endInstant))} ${lastCall.stopName}`;
  }

  // Under way but not placeable from the calls in hand.
  return "Position derzeit nicht bekannt";
}

const countdownLabel = (minutes: number) => (minutes <= 0 ? "jetzt" : `in ${minutes} Minuten`);

/** Spoken form of a row; the visual columns alone read as fragments. */
export function getDepartureAccessibilityLabel(departure: Departure, feedNow?: number): string {
  const timeReading = getDepartureTimeReading(departure);

  return [
    `${labelByTransportMode[departure.transportMode]} ${departure.lineId} nach ${departure.destination}`,
    // A cancelled trip has no countdown or time to speak.
    ...(departure.status === "cancelled"
      ? ["Fahrt entfällt"]
      : [
          countdownLabel(
            feedNow === undefined
              ? departure.minutesUntilDeparture
              : getCountdownMinutes(departure, feedNow),
          ),
          ...(timeReading ? [`ab ${timeReading.accessibilityLabel}`] : []),
        ]),
    formatSpokenPlatformLabel(departure.platformCode, departure.platformKind),
    // Boarding outranks everything after it except the operator's remark.
    ...(departure.status === "cancelled"
      ? []
      : ([getSpokenVehicleAccess(departure)].filter(Boolean) as string[])),
    ...(departure.serviceNote ? [`Hinweis: ${departure.serviceNote}`] : []),
  ].join(", ");
}

/** One call's time on a selected trip, using the shared reading, plus whether it has passed. */
export type TripCallTimeReading = DepartureTimeReading & {
  /** True once the vehicle is due to have left this call. */
  isPast: boolean;
};

/**
 * Where a ride's countdown comes from. Without a position it is the feed's times, which are a
 * prediction unless the next call is unmonitored.
 */
export function getRideCountdownSourceLabel(
  progress: Pick<RideProgress, "source" | "metersToNextCall">,
  nextCallTime: TripCallTimeReading | undefined,
): string {
  if (progress.source === "position") {
    return progress.metersToNextCall === undefined
      ? "nach Standort"
      : `nach Standort · noch ${formatDistance(progress.metersToNextCall)}`;
  }
  return !nextCallTime || nextCallTime.punctuality === "unmonitored"
    ? "nach Fahrplan"
    : "nach Echtzeitprognose";
}

/** The time a trip calls at one of its stops, or nothing when the trip states none. */
export function getTripCallTimeReading(
  call: TripCall,
  feedNow: number,
): TripCallTimeReading | undefined {
  const scheduled = call.scheduledDepartureTime ?? call.scheduledArrivalTime;
  if (!scheduled) return undefined;
  const reading = getPublishedTimeReading(scheduled, call.delayMinutes);
  if (!reading) return undefined;

  const isPast = feedNow > (getTripCallInstant(call) ?? Number.POSITIVE_INFINITY);
  return {
    ...reading,
    isPast,
    accessibilityLabel: isPast
      ? `bereits abgefahren, ${reading.accessibilityLabel}`
      : reading.accessibilityLabel,
  };
}
