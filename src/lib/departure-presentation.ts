import { labelByTransportMode } from "../data/line-signs";
import type { Departure, DepartureBoard, TripCall } from "../data/transit-types";
import { findExpectedDepartureInstant, getBoardAgeMs, getCountdownMinutes } from "./feed-clock";
import { formatSpokenPlatformName } from "./platform-naming";
import { isSelectedLine, type LineSelection } from "./line-bundles";
import { getTripCallInstant } from "./trip-calls";

/** Departure times are Karlsruhe clock times, so they are read off that clock wherever the viewer is. */
const clockFormat = new Intl.DateTimeFormat("de-DE", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Berlin",
});

export function formatClockTime(value: string | Date): string {
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? "–" : clockFormat.format(parsed);
}

/** How a deviation is spoken. `+3` is read out as two unrelated tokens, so it is never spoken. */
function getDeviationPhrase(delayMinutes: number): string {
  const minutes = Math.abs(delayMinutes);
  return `${minutes} ${minutes === 1 ? "Minute" : "Minuten"} ${delayMinutes > 0 ? "später" : "früher"} als geplant`;
}

/**
 * The one time a rider is given, and the schedule it was moved off.
 *
 * The feed states a schedule and a deviation separately, and a board that prints both as it got
 * them makes the rider add them up: "14:32 +3" beside a countdown that already contains those three
 * minutes is two conventions in one row, and no one can tell which number the plus applies to. So
 * the sum is what gets published, and the schedule stays beside it as the evidence it was moved
 * from — struck through, never as a number to do arithmetic with.
 */
export type DepartureTimeReading = {
  /** What the vehicle is actually expected to do: the schedule with its deviation added in. */
  expectedTime: string;
  /** The published schedule, stated only where a deviation has moved the departure off it. */
  scheduledTime?: string;
  /** What the pair says, for the tone it is drawn in and the dot beside it. */
  punctuality: "unmonitored" | "punctual" | "late" | "early";
  /** Spoken form; "14:32 +3" reads as two unrelated numbers. */
  accessibilityLabel: string;
};

/**
 * One published time, read off a scheduled time and whatever deviation is measured for it.
 *
 * An absent deviation is not "pünktlich": the trip is simply not monitored, and saying so is the
 * difference between a measurement and a timetable.
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

/**
 * The deviation this row publishes, measured against the time the feed actually expects the vehicle
 * at (`findExpectedDepartureInstant`) rather than read off its stated delay.
 *
 * The two are the same number on most rows and differ by a minute on some, because the feed
 * truncates the delay it states and does not truncate the prediction it states beside it. Read from
 * the delay alone, those rows publish a scheduled time and the word "pünktlich" for a vehicle the
 * operator is predicting a minute later — a measurement claimed where the feed made none.
 *
 * Derived back into a deviation rather than used as a time, because a deviation is what the row has
 * to show: the published time is the schedule moved by it, with the schedule struck through beside
 * it as the evidence it moved. A prediction is stated to the minute, so the sum comes back to
 * exactly the prediction.
 */
function findPublishedDelayMinutes(departure: Departure): number | undefined {
  const scheduled = Date.parse(departure.scheduledDepartureTime);
  const expected = findExpectedDepartureInstant(
    departure.scheduledDepartureTime,
    departure.predictedDepartureTime,
    departure.delayMinutes,
  );
  // An unmonitored trip states neither, and must keep saying so: a zero here would read as a
  // measurement that the vehicle is on time.
  if (expected === undefined || !Number.isFinite(scheduled)) return departure.delayMinutes;
  if (departure.predictedDepartureTime === undefined) return departure.delayMinutes;
  return Math.round((expected - scheduled) / 60_000);
}

/**
 * The time one departure row publishes. A trip that will not run has no deviation to apply: adding
 * three minutes to a cancelled departure would state a time it is expected at.
 */
export function getDepartureTimeReading(departure: Departure): DepartureTimeReading | undefined {
  return getPublishedTimeReading(
    departure.scheduledDepartureTime,
    departure.status === "cancelled" ? undefined : findPublishedDelayMinutes(departure),
  );
}

/**
 * The punctuality column, for what the time itself cannot say. Without a prediction the trip is not
 * monitored, and the board says so instead of implying realtime. A measured on-time trip needs no
 * repeated word beside a time that has not moved; its complete reading remains in the row's spoken
 * label.
 *
 * A deviation is not a word here: it is the published time, with the schedule struck through beside
 * it. Repeating it as "+3" is the same fact twice, and the second telling is the one that asks the
 * rider to do arithmetic.
 */
export function getDepartureStatusLabel(departure: Departure): string | undefined {
  if (departure.status === "cancelled") return "entfällt";
  // A diversion is the fact about this trip, and it outranks a punctuality that no longer describes
  // the journey the rider would be taking. It was previously stated only as a delay value.
  if (departure.status === "diverted") return "Umleitung";
  // The same deviation the row's own time was published from, so the column and the time beside it
  // can never disagree about whether this trip is measured at all.
  if (findPublishedDelayMinutes(departure) === undefined) return "nach Fahrplan";
  return undefined;
}

/**
 * The boarding a row *prints*, which is only ever the exception.
 *
 * The feed states three things and they are wildly unequal in number: nearly every departure in
 * Karlsruhe is a step-free vehicle, a rare one is explicitly not, and some say nothing. Printing
 * "stufenlos" on nineteen rows out of twenty spends the most scannable line of the board on a word
 * that carries no information and buries the twentieth row, which is the one a rider with a
 * wheelchair, a pram or a suitcase actually has to see. So the row prints the operator's own
 * wording for the exception and nothing at all otherwise.
 *
 * The full reading is not lost: it is spoken (`findSpokenVehicleAccess`), where it costs no space
 * and where a rider who cannot see the board has no other way to it.
 */
export function findVehicleAccessLabel(departure: Departure): string | undefined {
  return departure.vehicleAccess === "notStepFree" ? "nicht barrierefrei" : undefined;
}

/**
 * The spoken form, which states all three: what the operator said, or nothing where it said
 * nothing. Silence is never spoken as a vehicle with steps.
 */
function findSpokenVehicleAccess(departure: Departure): string | undefined {
  if (departure.vehicleAccess === "stepFree") return "stufenloser Einstieg";
  if (departure.vehicleAccess === "notStepFree") return "nicht barrierefreies Fahrzeug";
  return undefined;
}

/**
 * The countdown column, in the one wording every surface uses.
 *
 * A cancelled trip has no countdown to state — a struck-through dash reads as a rendering fault
 * from three metres away, so the column says what happened instead.
 */
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
 * Whether a departure reads as the selection, the same in every order of the board: the pinned trip
 * is the whole selection, and its siblings on the same line stay quiet. Without one, the lines being
 * read are the selection and every trip of them reads as chosen — which is the whole of what a
 * bundle changes here: two lines read together highlight as the one corridor the rider chose.
 */
export function isDepartureSelected(
  departure: Departure,
  selectedDepartureId: string | undefined,
  lineSelection: LineSelection | undefined,
): boolean {
  return selectedDepartureId
    ? selectedDepartureId === departure.id
    : Boolean(lineSelection && isSelectedLine(lineSelection, departure.lineId));
}

/** The next few calls a trip makes after this stop: the `über …` a rider checks before boarding. */
export function getViaSummary(departure: Departure, callCount = 3): string {
  const calls = departure.tripCalls ?? [];
  const currentIndex = calls.findIndex((call) => call.isCurrentStop);
  if (currentIndex < 0) return "";
  const via = calls.slice(currentIndex + 1, -1).map((call) => call.stopName);
  return via.slice(0, callCount).join(" · ");
}

/**
 * How old the board in view is, stated only once it is old enough to matter. A board refreshed a
 * moment ago needs no disclaimer; one that has not refreshed for minutes needs one that cannot be
 * mistaken for a live reading.
 */
export function findStaleBoardLabel(
  departureBoard: DepartureBoard | null,
  feedNow: number,
): string | undefined {
  if (!departureBoard || departureBoard.dataStatus !== "live") return undefined;
  const ageMinutes = Math.floor(getBoardAgeMs(departureBoard, feedNow) / 60_000);
  if (ageMinutes < 2) return undefined;
  return `Stand ${formatClockTime(departureBoard.feedUpdatedAt)} · seit ${ageMinutes} Min ohne Aktualisierung`;
}

/** Compact exception status used by the line diagram or its board lifecycle. */
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
 * Why the pinned trip carries no mark on the line it is drawn on.
 *
 * A mark is placed only where the trip's own calls say where the vehicle is — see
 * `lib/vehicle-positioning.ts`, where an absent mark is the honest answer and an invented one is
 * not. But a rider who picked a departure a quarter of an hour before it leaves then reads a
 * diagram of their own trip with nothing of their trip on it, and unexplained that reads as the app
 * having lost the vehicle rather than as the run not having begun. This is the sentence that says
 * which of the two it is, and it is read off the same calls the placement is, so it can never state
 * a position the diagram declined to draw.
 */
export function getSelectedTripPositionHint(
  departure: Departure | undefined,
  /** Whether the diagram actually carries a mark for this trip; with one there is nothing to say. */
  isPlaced: boolean,
  feedNow: number,
): string | undefined {
  const calls = departure?.tripCalls ?? [];
  // Without a sequence there is no drawn line for the trip to be missing from, and the diagram is
  // saying so for itself.
  if (!departure || isPlaced || calls.length < 2) return undefined;
  // A trip that will not run has no position to be waited for, and no time to count towards.
  if (departure.status === "cancelled") return "Entfällt · keine Position auf der Linie";

  const firstCall = calls[0];
  const startInstant = getTripCallInstant(firstCall);
  if (startInstant !== undefined && feedNow < startInstant) {
    // The published time of that first call, deviation included: the one time this view states for
    // the start of the run, the same way every other time in the app is stated.
    const reading = getTripCallTimeReading(firstCall, feedNow);
    return `Noch nicht unterwegs · Start ${reading?.expectedTime ?? formatClockTime(new Date(startInstant))} ab ${firstCall.stopName}`;
  }

  const lastCall = calls[calls.length - 1];
  const endInstant = getTripCallInstant(lastCall, "arrival");
  if (endInstant !== undefined && feedNow > endInstant) {
    return `Fahrt beendet · ${formatClockTime(new Date(endInstant))} ${lastCall.stopName}`;
  }

  // The run is under way, and the calls in hand still do not place it: a gap between boards, or a
  // sequence the feed gave no usable times for. Nothing is claimed about where the vehicle is.
  return "Position derzeit nicht bekannt";
}

const countdownLabel = (minutes: number) => (minutes <= 0 ? "jetzt" : `in ${minutes} Minuten`);

/** Spoken form of one departure row; the visual columns alone would read as disconnected fragments. */
export function getDepartureAccessibilityLabel(departure: Departure, feedNow?: number): string {
  const timeReading = getDepartureTimeReading(departure);

  return [
    `${labelByTransportMode[departure.transportMode]} ${departure.lineId} nach ${departure.destination}`,
    // A trip that will not run has no countdown and no departure time to speak, and speaking either
    // contradicts the very next thing the label says.
    ...(departure.status === "cancelled"
      ? ["Fahrt entfällt"]
      : [
          countdownLabel(
            feedNow === undefined
              ? departure.minutesUntilDeparture
              : getCountdownMinutes(departure, feedNow),
          ),
          // The same order the row is read in: when it leaves, then what that was measured against.
          ...(timeReading ? [`ab ${timeReading.accessibilityLabel}`] : []),
        ]),
    formatSpokenPlatformName(departure.platformName, departure.platformKind),
    // Whether a rider can board at all outranks everything after it but the operator's own remark.
    ...(departure.status === "cancelled"
      ? []
      : ([findSpokenVehicleAccess(departure)].filter(Boolean) as string[])),
    ...(departure.serviceNote ? [`Hinweis: ${departure.serviceNote}`] : []),
  ].join(", ");
}

/**
 * One calling point's time on a selected trip: the published time, plus whether the call has
 * happened. The reading itself is the shared one, so a stop in the diagram and a row on the board
 * cannot state the same deviation two different ways.
 */
export type TripCallTimeReading = DepartureTimeReading & {
  /** True once the vehicle is due to have left this calling point. */
  isPast: boolean;
};

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
