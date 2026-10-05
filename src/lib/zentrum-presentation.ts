/** Confidence and boarding facts for the Zentrum's readings. */
import type { Departure, DepartureBoard, TripCall } from "../data/transit-types";
import { isSameRun } from "./trips";
import { formatPlatformLabel } from "./platform-naming";
import type { ZentrumTravelTime } from "./zentrum-schematic-overlays";

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
