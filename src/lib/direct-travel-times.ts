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
  /** The stops passed, the rider's first and this one last. */
  stopIds: readonly string[];
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
 * The best direct ride to every stop the runs reach after boarding at `originId`. A call
 * `getStopId` cannot name ends the run's reach, or with `passUnnamed` is ridden past.
 */
export function getDirectTravelTimes(
  departures: readonly Departure[],
  originId: string,
  feedNow: number,
  measure: TravelMeasure,
  getStopId: (call: TripCall) => string | undefined,
  passUnnamed = false,
): ReadonlyMap<string, DirectTravelTime> {
  const best = new Map<string, DirectTravelTime>();
  for (const departure of departures) {
    if (departure.status === "cancelled") continue;
    const calls = collapseTurnaroundCalls(departure.tripCalls ?? []);
    const named = calls.map((call) => [call, getStopId(call)] as const);
    const kept = passUnnamed ? named.filter(([, id]) => id !== undefined) : named;
    const stopIds = kept.map(([, id]) => id);
    // Boarding at a complex's last call.
    let boardIndex = -1;
    for (const [index, [call]] of kept.entries()) {
      if (stopIds[index] !== originId || stopIds[index + 1] === originId) continue;
      const leaves = getTripCallInstant(call);
      if (leaves !== undefined && leaves >= feedNow) {
        boardIndex = index;
        break;
      }
    }
    if (boardIndex < 0) continue;
    const departsAt = getTripCallInstant(kept[boardIndex][0]) ?? feedNow;

    const passed = [originId];
    for (let index = boardIndex + 1; index < kept.length; index += 1) {
      const stopId = stopIds[index];
      if (!stopId) break;
      if (stopId === passed[passed.length - 1]) continue;
      passed.push(stopId);
      const arrivesAt = getTripCallInstant(kept[index][0], "arrival");
      if (arrivesAt === undefined || stopId === originId) continue;
      const candidate = { arrivesAt, lineId: departure.lineId, departsAt, stopIds: [...passed] };
      const known = best.get(stopId);
      if (!known || compareTravelTimes(candidate, known, measure) < 0) best.set(stopId, candidate);
    }
  }
  return best;
}

/** Whole minutes until arrival, rounded up. */
export const getMinutesUntilArrival = (arrivesAt: number, feedNow: number): number =>
  Math.max(0, Math.ceil((arrivesAt - feedNow) / 60_000));
