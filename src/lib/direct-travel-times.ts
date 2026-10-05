/**
 * How soon a rider leaving one stop now reaches others on one vehicle, from the runs in hand.
 * Direct rides only; the feed says nothing reliable about changes.
 */
import type { Departure, TripCall } from "../data/transit-types";
import { compareLineIds } from "./line-families";
import { collapseTurnaroundCalls, getTripCallInstant } from "./trip-calls";

/** What "nearest" means for a reached stop: the soonest arrival, or the shortest ride. */
export type TravelMeasure = "arrival" | "ride";

export type DirectTravelTime = {
  arrivesAt: number;
  lineId: string;
  /** When that vehicle leaves the rider's stop. */
  departsAt: number;
  /** The stops visited, the rider's first and this one last. */
  stopIds: readonly string[];
};

export type DirectRideTime = DirectTravelTime & {
  departure: Departure;
  boardingCall: TripCall;
  arrivalCall: TripCall;
};

const getMeasuredTime = (time: DirectTravelTime, measure: TravelMeasure): number =>
  measure === "ride" ? time.arrivesAt - time.departsAt : time.arrivesAt;

/** By the measure, then the sooner arrival, then the line. */
const compareTravelTimes = (
  left: DirectTravelTime,
  right: DirectTravelTime,
  measure: TravelMeasure,
): number =>
  getMeasuredTime(left, measure) - getMeasuredTime(right, measure) ||
  left.arrivesAt - right.arrivesAt ||
  compareLineIds(left.lineId, right.lineId);

/**
 * The best direct ride to every stop the runs reach after boarding at `originStopId`. A call
 * `getStopId` cannot name ends the run's reach, or with `passUnnamed` is ridden past.
 */
export function getDirectTravelTimes(
  departures: readonly Departure[],
  originStopId: string,
  feedNow: number,
  measure: TravelMeasure,
  getStopId: (call: TripCall) => string | undefined,
  passUnnamed = false,
): ReadonlyMap<string, DirectRideTime> {
  const bestRideByStopId = new Map<string, DirectRideTime>();
  for (const departure of departures) {
    if (departure.status === "cancelled") continue;
    const calls = collapseTurnaroundCalls(departure.tripCalls ?? []);
    const resolvedCalls = calls.map((call) => [call, getStopId(call)] as const);
    const eligibleCalls = passUnnamed
      ? resolvedCalls.filter(([, id]) => id !== undefined)
      : resolvedCalls;
    const stopIds = eligibleCalls.map(([, id]) => id);
    // Boarding at a complex's last call.
    let boardingCallIndex = -1;
    for (const [index, [call]] of eligibleCalls.entries()) {
      if (stopIds[index] !== originStopId || stopIds[index + 1] === originStopId) continue;
      const leaves = getTripCallInstant(call);
      if (leaves !== undefined && leaves >= feedNow) {
        boardingCallIndex = index;
        break;
      }
    }
    if (boardingCallIndex < 0) continue;
    const departsAt = getTripCallInstant(eligibleCalls[boardingCallIndex][0]) ?? feedNow;

    const visitedStopIds = [originStopId];
    for (let index = boardingCallIndex + 1; index < eligibleCalls.length; index += 1) {
      const stopId = stopIds[index];
      if (!stopId) break;
      if (stopId === visitedStopIds[visitedStopIds.length - 1]) continue;
      visitedStopIds.push(stopId);
      const arrivesAt = getTripCallInstant(eligibleCalls[index][0], "arrival");
      if (arrivesAt === undefined || stopId === originStopId) continue;
      const candidate = {
        arrivesAt,
        lineId: departure.lineId,
        departsAt,
        stopIds: [...visitedStopIds],
        departure,
        boardingCall: eligibleCalls[boardingCallIndex][0],
        arrivalCall: eligibleCalls[index][0],
      };
      const known = bestRideByStopId.get(stopId);
      if (!known || compareTravelTimes(candidate, known, measure) < 0)
        bestRideByStopId.set(stopId, candidate);
    }
  }
  return bestRideByStopId;
}

/** Whole minutes until arrival, rounded up. */
export const getMinutesUntilArrival = (arrivesAt: number, feedNow: number): number =>
  Math.max(0, Math.ceil((arrivesAt - feedNow) / 60_000));
