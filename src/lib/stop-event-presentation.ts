import { labelByPtMode } from "../data/line-signs";
import type { StopEvent, StopEventBoard, Call } from "../data/transit-types";
import {
  findExpectedDepartureInstant,
  getBoardAgeMs,
  getCountdownMinutes,
  getCountdownSeconds,
} from "./feed-clock";
import { formatSpokenBayText } from "./bay-naming";
import { formatDistance } from "./geo";
import type { RideProgress } from "./ride-progress";
import { isSelectedLine, type LineSelection } from "./line-bundles";
import { getCallsAfterCurrentStop, getCallInstant } from "./calls";
import { isSameDatedJourney } from "./journeys";

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
  timetabledTime?: string;
  punctuality: "unmonitored" | "punctual" | "late" | "early";
  accessibilityLabel: string;
};

/**
 * A published time from a schedule and its deviation. No deviation means unmonitored, not on time.
 */
function getPublishedTimeReading(
  timetabledTime: string,
  delayMinutes: number | undefined,
): DepartureTimeReading | undefined {
  const timetabledInstant = Date.parse(timetabledTime);
  if (!Number.isFinite(timetabledInstant)) return undefined;
  const timetabledClockTime = formatClockTime(new Date(timetabledInstant));

  if (delayMinutes === undefined) {
    return {
      expectedTime: timetabledClockTime,
      punctuality: "unmonitored",
      accessibilityLabel: `${timetabledClockTime} nach Fahrplan`,
    };
  }
  if (delayMinutes === 0) {
    return {
      expectedTime: timetabledClockTime,
      punctuality: "punctual",
      accessibilityLabel: `${timetabledClockTime}, pünktlich`,
    };
  }

  const expectedTime = formatClockTime(new Date(timetabledInstant + delayMinutes * 60_000));
  return {
    expectedTime,
    timetabledTime: timetabledClockTime,
    punctuality: delayMinutes > 0 ? "late" : "early",
    accessibilityLabel: `${expectedTime}, ${getDeviationPhrase(delayMinutes)}, planmäßig ${timetabledClockTime}`,
  };
}

type DepartureTimeFacts = Pick<
  StopEvent,
  "timetabledDepartureTime" | "estimatedDepartureTime" | "delayMinutes"
>;

/**
 * The row's deviation, derived from the feed's expected instant (`findExpectedDepartureInstant`):
 * the stated delay is truncated, so it can read "pünktlich" for a vehicle estimated a minute late.
 */
function findPublishedDelayMinutes(stopEvent: DepartureTimeFacts): number | undefined {
  const timetabled = Date.parse(stopEvent.timetabledDepartureTime);
  const expected = findExpectedDepartureInstant(
    stopEvent.timetabledDepartureTime,
    stopEvent.estimatedDepartureTime,
    stopEvent.delayMinutes,
  );
  // Unmonitored stays unmonitored; zero would claim on time.
  if (expected === undefined || !Number.isFinite(timetabled)) return stopEvent.delayMinutes;
  if (stopEvent.estimatedDepartureTime === undefined) return stopEvent.delayMinutes;
  return Math.round((expected - timetabled) / 60_000);
}

/** The time a row publishes. A cancelled journey gets no deviation applied. */
export function getDepartureTimeReading(
  stopEvent: DepartureTimeFacts & Pick<StopEvent, "status">,
): DepartureTimeReading | undefined {
  return getPublishedTimeReading(
    stopEvent.timetabledDepartureTime,
    stopEvent.status === "cancelled" ? undefined : findPublishedDelayMinutes(stopEvent),
  );
}

/**
 * The punctuality column, only for what the time cannot say: "nach Fahrplan" for an unmonitored
 * journey. An on-time journey needs no word, and a deviation is already in the time.
 */
export function getStopEventStatusLabel(stopEvent: StopEvent): string | undefined {
  if (stopEvent.status === "cancelled") return "entfällt";
  // A diversion outranks punctuality.
  if (stopEvent.status === "diverted") return "Umleitung";
  // The same deviation the time was published from.
  if (findPublishedDelayMinutes(stopEvent) === undefined) return "nach Fahrplan";
  return undefined;
}

/**
 * The boarding a row prints: only the exception. Nearly every vehicle is step-free, so printing it
 * on every row would bury the one that is not. The full reading is spoken.
 */
export function getVehicleAccessLabel(stopEvent: StopEvent): string | undefined {
  return stopEvent.vehicleAccess === "notStepFree" ? "nicht barrierefrei" : undefined;
}

/** The spoken boarding reading. Silence is never spoken as a vehicle with steps. */
function getSpokenVehicleAccess(stopEvent: StopEvent): string | undefined {
  if (stopEvent.vehicleAccess === "stepFree") return "stufenloser Einstieg";
  if (stopEvent.vehicleAccess === "notStepFree") return "nicht barrierefreies Fahrzeug";
  return undefined;
}

/** The countdown column. A cancelled journey says so instead of showing a dash. */
export type CountdownReading =
  | { kind: "cancelled"; label: string }
  | { kind: "due"; label: string }
  | { kind: "minutes"; minutes: number; label: string }
  | { kind: "seconds"; seconds: number; label: string };

/** The rider's setting to count a prediction's last minute in seconds. */
export type CountdownOptions = { isShowingLastMinuteSeconds?: boolean };

/** Last-minute countdowns use ten-second steps, rounded down. */
const LAST_MINUTE_STEP_SECONDS = 10;

/** The seconds a row's last minute shows; `undefined` outside it, or without a prediction to the second. */
function getLastMinuteSeconds(
  stopEvent: StopEvent,
  feedNow: number,
  { isShowingLastMinuteSeconds = false }: CountdownOptions,
): number | undefined {
  if (!isShowingLastMinuteSeconds) return undefined;
  const seconds = getCountdownSeconds(stopEvent, feedNow);
  if (seconds === undefined || seconds >= 60) return undefined;
  return Math.floor(seconds / LAST_MINUTE_STEP_SECONDS) * LAST_MINUTE_STEP_SECONDS;
}

export function getCountdownReading(
  stopEvent: StopEvent,
  feedNow: number,
  options: CountdownOptions = {},
): CountdownReading {
  if (stopEvent.status === "cancelled") return { kind: "cancelled", label: "entfällt" };
  const seconds = getLastMinuteSeconds(stopEvent, feedNow, options);
  if (seconds !== undefined) {
    return seconds <= 0
      ? { kind: "due", label: "jetzt" }
      : { kind: "seconds", seconds, label: `${seconds} s` };
  }
  const minutes = getCountdownMinutes(stopEvent, feedNow);
  return minutes <= 0
    ? { kind: "due", label: "jetzt" }
    : { kind: "minutes", minutes, label: `${minutes} min` };
}

/**
 * Whether a row reads as selected: the pinned journey, else every journey of the selected lines.
 * Matched by vehicle (`isSameDatedJourney`), since a journey calling at two of a complex's places
 * has two rows (Europaplatz: `Gleis 6` at 13:43, `Gleis 4` at 13:44).
 */
export function isStopEventSelected(
  stopEvent: StopEvent,
  selectedStopEvent: StopEvent | undefined,
  lineSelection: LineSelection | undefined,
): boolean {
  return selectedStopEvent
    ? isSameDatedJourney(stopEvent, selectedStopEvent)
    : Boolean(lineSelection && isSelectedLine(lineSelection, stopEvent.lineId));
}

/**
 * Whether this row is the addressed journey, matched by vehicle, so tapping it steps up to the
 * line.
 */
export function isStopEventPinned(
  stopEvent: StopEvent,
  selectedStopEvent: StopEvent | undefined,
): boolean {
  return Boolean(selectedStopEvent && isSameDatedJourney(stopEvent, selectedStopEvent));
}

/** The next few calls after this stop: the `über …` a rider checks before boarding. */
export function getViaSummary(stopEvent: StopEvent, callCount = 3): string {
  // The last call is the destination the row already states.
  const via = getCallsAfterCurrentStop(stopEvent)
    .slice(0, -1)
    .map((call) => call.stopName);
  return via.slice(0, callCount).join(" · ");
}

/** The board's age once it is old enough to matter, and a failed refresh as soon as it happens. */
export function getStaleBoardLabel(
  stopEventBoard: StopEventBoard | null,
  feedNow: number,
): string | undefined {
  if (!stopEventBoard || stopEventBoard.dataStatus !== "live") return undefined;
  const ageMinutes = Math.floor(getBoardAgeMs(stopEventBoard, feedNow) / 60_000);
  const readAt = `Stand ${formatClockTime(stopEventBoard.feedUpdatedAt)}`;
  if (ageMinutes >= 2) return `${readAt} · seit ${ageMinutes} Min ohne Aktualisierung`;
  // A failed refresh is said at once, before the board is old enough to count as stale.
  return stopEventBoard.refreshFailedAt !== undefined
    ? `${readAt} · Aktualisierung fehlgeschlagen`
    : undefined;
}

/** Compact exception status for the line diagram. */
export function getLineDiagramStatusLabel(
  stopEvent: StopEvent | undefined,
  stopEventBoard: StopEventBoard | null,
): string | undefined {
  if (stopEvent?.status === "cancelled") return "entfällt";
  if (stopEvent?.status === "diverted") return "Umleitung";
  if (!stopEventBoard) return "lädt";
  return stopEventBoard.dataStatus === "live" ? undefined : "nicht verfügbar";
}

/**
 * Why the pinned journey has no mark on its line (not started yet, or position unknown), read off
 * the same calls as the placement so it cannot contradict the diagram.
 */
export function getDatedJourneyPositionHint(
  stopEvent: StopEvent | undefined,
  /** Whether the diagram carries a mark for this journey. */
  isPlaced: boolean,
  feedNow: number,
): string | undefined {
  const calls = stopEvent?.calls ?? [];
  // Without a sequence there is no drawn line, and the diagram says so itself.
  if (!stopEvent || isPlaced || calls.length < 2) return undefined;
  if (stopEvent.status === "cancelled") return "Entfällt · keine Position auf der Linie";

  const firstCall = calls[0];
  const startInstant = getCallInstant(firstCall);
  if (startInstant !== undefined && feedNow < startInstant) {
    // The first call's published time, deviation included.
    const reading = getCallTimeReading(firstCall, feedNow);
    return `Noch nicht unterwegs · Start ${reading?.expectedTime ?? formatClockTime(new Date(startInstant))} ab ${firstCall.stopName}`;
  }

  const lastCall = calls[calls.length - 1];
  const endInstant = getCallInstant(lastCall, "arrival");
  if (endInstant !== undefined && feedNow > endInstant) {
    return `Fahrt beendet · ${formatClockTime(new Date(endInstant))} ${lastCall.stopName}`;
  }

  // Under way but not placeable from the calls in hand.
  return "Position derzeit nicht bekannt";
}

const countdownLabel = (minutes: number) =>
  minutes <= 0 ? "jetzt" : `in ${minutes} ${minutes === 1 ? "Minute" : "Minuten"}`;

/** The spoken countdown, in seconds where the row's column shows them. */
function getSpokenCountdown(
  stopEvent: StopEvent,
  feedNow: number | undefined,
  options: CountdownOptions,
): string {
  if (feedNow === undefined) return countdownLabel(stopEvent.minutesUntilDeparture);
  const seconds = getLastMinuteSeconds(stopEvent, feedNow, options);
  if (seconds === undefined) return countdownLabel(getCountdownMinutes(stopEvent, feedNow));
  return seconds <= 0 ? "jetzt" : `in ${seconds} Sekunden`;
}

/** Spoken form of a row; the visual columns alone read as fragments. */
export function getStopEventAccessibilityLabel(
  stopEvent: StopEvent,
  feedNow?: number,
  options: CountdownOptions = {},
): string {
  const timeReading = getDepartureTimeReading(stopEvent);

  return [
    `${labelByPtMode[stopEvent.ptMode]} ${stopEvent.lineId} nach ${stopEvent.destinationText}`,
    // A cancelled journey has no countdown or time to speak.
    ...(stopEvent.status === "cancelled"
      ? ["Fahrt entfällt"]
      : [
          getSpokenCountdown(stopEvent, feedNow, options),
          ...(timeReading ? [`ab ${timeReading.accessibilityLabel}`] : []),
        ]),
    formatSpokenBayText(stopEvent.bay, stopEvent.bayKind),
    // Boarding outranks everything after it except the operator's remark.
    ...(stopEvent.status === "cancelled"
      ? []
      : ([getSpokenVehicleAccess(stopEvent)].filter(Boolean) as string[])),
    ...(stopEvent.serviceNote ? [`Hinweis: ${stopEvent.serviceNote}`] : []),
  ].join(", ");
}

/** One call's time on a selected journey, using the shared reading, plus whether it has passed. */
export type CallTimeReading = DepartureTimeReading & {
  /** True once the vehicle is due to have left this call. */
  isPast: boolean;
};

/**
 * Where a ride's countdown comes from. Without a position it is the feed's times, which are a
 * prediction unless the next call is unmonitored.
 */
export function getRideCountdownSourceLabel(
  progress: Pick<RideProgress, "source" | "metersToNextCall">,
  nextCallTime: CallTimeReading | undefined,
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

/** The time a journey calls at one of its stops, or nothing when the journey states none. */
export function getCallTimeReading(call: Call, feedNow: number): CallTimeReading | undefined {
  const timetabled = call.timetabledDepartureTime ?? call.timetabledArrivalTime;
  if (!timetabled) return undefined;
  const reading = getPublishedTimeReading(timetabled, call.delayMinutes);
  if (!reading) return undefined;

  const isPast = feedNow > (getCallInstant(call) ?? Number.POSITIVE_INFINITY);
  return {
    ...reading,
    isPast,
    accessibilityLabel: isPast
      ? `bereits abgefahren, ${reading.accessibilityLabel}`
      : reading.accessibilityLabel,
  };
}
