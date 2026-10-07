/** Confidence and boarding facts for the Zentrum's readings. */
import type { Departure, DepartureBoard, TripCall } from "../data/transit-types";
import { isSameRun } from "./trips";
import { formatPlatformLabel } from "./platform-naming";
import type { ZentrumTravelTime } from "./zentrum-schematic-overlays";
import type { ZentrumSchematicVehicle } from "./zentrum-schematic";
import { formatClockTime } from "./departure-presentation";
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

export function getZentrumBoardingPlatformLabel(call: TripCall): string {
  return (
    call.platformLabel ||
    (call.platformCode ? formatPlatformLabel(call.platformCode, undefined) : "Ohne Steigangabe")
  );
}

export function findZentrumBoardingDeparture(
  board: DepartureBoard | null,
  time: ZentrumTravelTime,
): Departure | undefined {
  return board?.departures.find(
    (departure) =>
      isSameRun(departure, time.departure) &&
      (time.boardingCall.providerStopPointId !== undefined
        ? departure.boardingProviderStopPointId === time.boardingCall.providerStopPointId
        : departure.boardingLocalStopId === time.boardingCall.localStopId) &&
      time.boardingCall.platformCode !== undefined &&
      departure.platformCode === time.boardingCall.platformCode,
  );
}

/** Boarding facts come from the origin's row or call, never another stop's row. */
export function getZentrumRidePresentation(
  ride: ZentrumTravelTime,
  board: DepartureBoard | null,
  feedNow: number,
) {
  const boardingDeparture = findZentrumBoardingDeparture(board, ride);
  const waitMinutes = getMinutesUntilDeparture(ride.departsAt, feedNow);
  return {
    waitLabel: waitMinutes === 0 ? "Abfahrt jetzt" : `Abfahrt in ${waitMinutes} min`,
    rideMinutes: getRideMinutes(ride),
    departureTime: formatClockTime(new Date(ride.departsAt)),
    arrivalTime: formatClockTime(new Date(ride.arrivesAt)),
    platformLabel: boardingDeparture
      ? formatPlatformLabel(
          boardingDeparture.platformCode,
          boardingDeparture.platformKind,
          "unbekannt",
        )
      : getZentrumBoardingPlatformLabel(ride.boardingCall),
    direction: (boardingDeparture ?? ride.departure).destination,
    sourceLabel: getZentrumTravelSourceLabel(ride),
    serviceNote: boardingDeparture?.serviceNote,
  };
}
