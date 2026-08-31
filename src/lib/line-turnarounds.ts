import type { Departure, TripCall } from "../data/transit-types";
import { isSameLineFamily } from "./line-families";
import { getCallKey, getTripCallInstant, statesRunEnd, statesRunStart } from "./trip-calls";
import { getVehicleTripKey } from "./trips";

/**
 * The turnaround at a terminus, reconstructed — and the word is exact, because nothing publishes it.
 *
 * A vehicle that reaches the end of the line stands there and goes back out as the next departure,
 * and for those few minutes a rider watching the terminus sees one vehicle. The feed states two
 * unrelated trips: one whose calls end there and one whose calls begin there. No field joins them
 * — `docs/kvv-efa-api.md` — so the join here is an inference, and it is made under rules narrow
 * enough that the times themselves carry it:
 *
 * - an end of a run at both ends of the join, as the *feed* states one — a call timed into with no
 *   departure, and one timed out of with no arrival (`statesRunEnd` / `statesRunStart`). Where our
 *   copy of a sequence merely stops, the vehicle does not, and a stop it runs through is not a
 *   place anything turns;
 * - the same stop, and the same line family: a working that goes back out as another line is a
 *   thing that happens, but nothing in the reading distinguishes it from two separate vehicles;
 * - the departure goes back the way the arrival came. A turnaround is a reversal, whether the
 *   vehicle backs out of a stub or runs a loop to face the other way, and either way its onward
 *   calls return to ground the arrival covered. A departure that carries on past the stop instead
 *   is the next stage of somebody else's journey, not this vehicle turning;
 * - the departure leaves after the arrival is due in and within one turnaround of it, and it is the
 *   *soonest* such departure — an arrival turns out as the next run away from that stop, never as
 *   one two departures later;
 * - and that soonest departure leaves late enough to be a stand a rider could watch. A departure
 *   timed at the arrival's own instant is either one vehicle pulling in as another pulls out, or a
 *   turn the timetable gives no time at all; the reading does not say which, so no stand is drawn.
 *   What it must not do is hand the arrival on to the *next* departure instead. That is how a
 *   turning point whose arrivals and departures are timed together — Wolfartsweier Nord on line 1's
 *   2026 diversion, a tram in at :34:48 and one out at :34:48 — came to show a mark standing there
 *   for the ten minutes until the following departure, and then the ten after that, and so on all
 *   day: a vehicle waiting at a stop nothing was waiting at, drawn from an arrival that had already
 *   left. A pairing rejected for being too quick spends both of its ends rather than looking past
 *   them;
 * - one arrival to one departure, nearest first, so a terminus turning three vehicles in ten
 *   minutes pairs them in the order they can actually be run, and never twice.
 *
 * What the pairing is used for is deliberately modest: the diagram draws one standing mark for the
 * stand rather than two, and may draw it for the whole of a longer turnaround. It never claims the
 * vehicle is a particular one, and no time, deviation or platform is carried from one trip to the
 * other.
 */

/** The longest stand still read as one vehicle turning back rather than two of them. */
export const TURNAROUND_WINDOW_MS = 10 * 60_000;
/**
 * The shortest gap still drawn as one vehicle standing and turning back.
 *
 * Sequences are timed to the second, and a departure at the arrival's own instant is something the
 * timetable does at both busy termini and turning points: one run sets out as another sets down, or
 * a turn is given no time at all. Nothing turns a tram around in no time, and a stand drawn across
 * that instant is the one way this inference can be read as claiming something about a vehicle it
 * never saw — so nothing is drawn. This disqualifies a pairing; it never passes the arrival on to a
 * later departure, which would be a longer and more confident version of the same invention.
 */
export const MIN_TURNAROUND_STAND_MS = 60_000;

export type TurnaroundIndex = {
  /**
   * The departure each arrival is taken to turn back out as. A caller drops the arrival's own mark
   * once that departure is actually on the diagram — never before, or a terminus the departure
   * cannot be drawn at would lose the arrival as well and show nothing standing at all.
   */
  turningDepartureKeyByArrivalKey: ReadonlyMap<string, string>;
  /**
   * When each paired departure may be drawn standing at the stop it leaves from: the instant the
   * arrival before it is due in. Without a pairing a trip is only drawn for the last few minutes
   * before it leaves, which is the whole of what its own calls support.
   */
  standFromByDepartureKey: ReadonlyMap<string, number>;
};

/** Two calls at one place, by the id where both resolve one and by the published name otherwise. */
function isSameCallStop(left: TripCall, right: TripCall): boolean {
  return left.localStopId && right.localStopId
    ? left.localStopId === right.localStopId
    : left.stopName === right.stopName;
}

/**
 * The route either side of the turn, as the stops it covers away from the terminus.
 *
 * Taken as a set rather than a sequence because only one question is asked of it — does the
 * departure go back over ground the arrival came across — and because the two runs need not retrace
 * each other stop for stop to be one vehicle: a terminus loop rejoins the line a stop or two along,
 * and a short working turns back over part of what arrived.
 *
 * The terminus's own calls are skipped first. A stop complex is published as its stop points, so a
 * vehicle that turns is timed into the platform it arrives on and out of the one it leaves from,
 * and both of those are the place it turned rather than anywhere it went.
 */
function getRouteAwayFromEnd(calls: readonly TripCall[], end: "first" | "last"): Set<string> {
  const ordered = end === "last" ? [...calls].reverse() : calls;
  const endKey = getCallKey(ordered[0]);
  return new Set(
    ordered.slice(1).flatMap((call) => {
      const key = getCallKey(call);
      return key === endKey ? [] : [key];
    }),
  );
}

/** Whether the departure retraces any of the arrival's route, which is what turning back means. */
function isReversal(arrival: RunEnd, start: RunEnd): boolean {
  for (const key of start.route) {
    if (arrival.route.has(key)) return true;
  }
  return false;
}

type RunEnd = {
  key: string;
  departure: Departure;
  call: TripCall;
  instant: number;
  /** Where this run goes away from the end in question, kept once per run rather than per pairing. */
  route: Set<string>;
};

/**
 * The end of a run, and the start of one — each only where the feed states the run ends or begins
 * there, and only for a trip whose chain is timed.
 */
function findRunEnds(departures: readonly Departure[]): { arrivals: RunEnd[]; starts: RunEnd[] } {
  const arrivals: RunEnd[] = [];
  const starts: RunEnd[] = [];
  for (const departure of departures) {
    const calls = departure.tripCalls ?? [];
    if (calls.length < 2 || departure.status === "cancelled") continue;
    const key = getVehicleTripKey(departure);
    const finalCall = calls[calls.length - 1];
    const firstCall = calls[0];
    const arrivalInstant = statesRunEnd(finalCall)
      ? getTripCallInstant(finalCall, "arrival")
      : undefined;
    const departureInstant = statesRunStart(firstCall) ? getTripCallInstant(firstCall) : undefined;
    if (arrivalInstant !== undefined) {
      arrivals.push({
        key,
        departure,
        call: finalCall,
        instant: arrivalInstant,
        route: getRouteAwayFromEnd(calls, "last"),
      });
    }
    if (departureInstant !== undefined) {
      starts.push({
        key,
        departure,
        call: firstCall,
        instant: departureInstant,
        route: getRouteAwayFromEnd(calls, "first"),
      });
    }
  }
  return { arrivals, starts };
}

/** Which arrival turns back out as which departure, under the rules stated above. */
export function findTurnarounds(departures: readonly Departure[]): TurnaroundIndex {
  const { arrivals, starts } = findRunEnds(departures);
  const candidates = arrivals.flatMap((arrival) =>
    starts.flatMap((start) => {
      const gap = start.instant - arrival.instant;
      return start.key !== arrival.key &&
        gap >= 0 &&
        gap <= TURNAROUND_WINDOW_MS &&
        isSameLineFamily(arrival.departure.lineId, start.departure.lineId) &&
        isSameCallStop(arrival.call, start.call) &&
        isReversal(arrival, start)
        ? [{ arrival, start, gap }]
        : [];
    }),
  );

  // The shortest stand is the one a vehicle can actually run, so it is claimed first; a terminus
  // turning several vehicles pairs them in that order and each trip is spent once.
  candidates.sort(
    (left, right) => left.gap - right.gap || left.arrival.instant - right.arrival.instant,
  );
  const turningDepartureKeyByArrivalKey = new Map<string, string>();
  const standFromByDepartureKey = new Map<string, number>();
  // What each end has been answered by, whether or not that answer was a stand worth drawing. Kept
  // apart from the pairings themselves: an arrival whose own next departure left too soon to be a
  // turn has been accounted for, and looking past it to a later departure is the invention this
  // exists to refuse.
  const spentArrivalKeys = new Set<string>();
  const spentStartKeys = new Set<string>();
  for (const { arrival, start, gap } of candidates) {
    if (spentArrivalKeys.has(arrival.key) || spentStartKeys.has(start.key)) continue;
    spentArrivalKeys.add(arrival.key);
    spentStartKeys.add(start.key);
    if (gap < MIN_TURNAROUND_STAND_MS) continue;
    turningDepartureKeyByArrivalKey.set(arrival.key, start.key);
    standFromByDepartureKey.set(start.key, arrival.instant);
  }
  return { turningDepartureKeyByArrivalKey, standFromByDepartureKey };
}
