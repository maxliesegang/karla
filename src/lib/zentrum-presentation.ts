/** Confidence and boarding facts for the Zentrum's readings. */
import type { StopEvent, StopEventBoard, Call } from "../data/transit-types";
import { isSameDatedJourney } from "./journeys";
import { formatBayText } from "./bay-naming";
import type { ZentrumTravelTime } from "./zentrum-schematic-overlays";
import type { ZentrumSchematicVehicle } from "./zentrum-schematic";
import { formatClockTime } from "./stop-event-presentation";
import { getMinutesUntilDeparture, getRideMinutes } from "./zentrum-schematic-overlays";

export function getZentrumVehiclePlaceLabel({
  phase,
  from,
  to,
  progress,
}: Pick<ZentrumSchematicVehicle, "phase" | "from" | "to" | "progress">): string {
  if (phase === "beforeStart") return `Steht an ${from.label} vor Abfahrt`;
  if (phase === "afterEnd") return `Steht an ${to.label} (Fahrt endet hier)`;
  if (from.id === to.id || progress === 0) return `Hält an ${from.label}`;
  if (progress === 1) return `Hält an ${to.label}`;
  return `Zwischen ${from.label} und ${to.label}`;
}

export function getZentrumTravelSourceLabel(time: ZentrumTravelTime): string {
  return time.boardingCall.delayMinutes === undefined ||
    (time.arrivalCall.arrivalDelayMinutes ?? time.arrivalCall.delayMinutes) === undefined
    ? "nach Fahrplan"
    : "nach Echtzeitprognose";
}

export function getZentrumBoardingBayText(call: Call): string {
  return call.bayText || (call.bay ? formatBayText(call.bay, undefined) : "Ohne Steigangabe");
}

export function findZentrumBoardingStopEvent(
  board: StopEventBoard | null,
  time: ZentrumTravelTime,
): StopEvent | undefined {
  return board?.stopEvents.find(
    (stopEvent) =>
      isSameDatedJourney(stopEvent, time.stopEvent) &&
      (time.boardingCall.providerStopPointId !== undefined
        ? stopEvent.boardingProviderStopPointId === time.boardingCall.providerStopPointId
        : stopEvent.boardingLocalStopId === time.boardingCall.localStopId) &&
      time.boardingCall.bay !== undefined &&
      stopEvent.bay === time.boardingCall.bay,
  );
}

/** Boarding facts come from the origin's row or call, never another stop's row. */
export function getZentrumRidePresentation(
  ride: ZentrumTravelTime,
  board: StopEventBoard | null,
  feedNow: number,
) {
  const boardingStopEvent = findZentrumBoardingStopEvent(board, ride);
  const waitMinutes = getMinutesUntilDeparture(ride.departsAt, feedNow);
  return {
    waitLabel: waitMinutes === 0 ? "Abfahrt jetzt" : `Abfahrt in ${waitMinutes} min`,
    rideMinutes: getRideMinutes(ride),
    departureTime: formatClockTime(new Date(ride.departsAt)),
    arrivalTime: formatClockTime(new Date(ride.arrivesAt)),
    bayText: boardingStopEvent
      ? formatBayText(boardingStopEvent.bay, boardingStopEvent.bayKind, "unbekannt")
      : getZentrumBoardingBayText(ride.boardingCall),
    direction: (boardingStopEvent ?? ride.stopEvent).destinationText,
    sourceLabel: getZentrumTravelSourceLabel(ride),
    serviceNote: boardingStopEvent?.serviceNote,
  };
}

export function getZentrumPositionFreshness(
  datedJourneys: readonly StopEvent[],
  now: number,
): string {
  if (datedJourneys.length === 0) return "";
  const stamps = datedJourneys.map(
    (datedJourney) => datedJourney.readAt?.coverageReadAt ?? datedJourney.readAt?.sequenceReadAt,
  );
  if (stamps.some((stamp) => stamp === undefined)) return "Datenalter unbekannt";
  const ageSeconds = Math.max(
    0,
    Math.floor((now - Math.min(...stamps.flatMap((stamp) => stamp ?? []))) / 1_000),
  );
  const age = ageSeconds < 60 ? `${ageSeconds} s` : `${Math.floor(ageSeconds / 60)} min`;
  return `${ageSeconds > 90 ? "Ältere Positionsdaten" : "Positionsdaten"} · bis zu ${age} alt`;
}
