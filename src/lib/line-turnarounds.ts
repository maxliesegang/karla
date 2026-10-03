import type { Departure, TripCall } from "../data/transit-types";
import { getLineFamilyId, isSameLineFamily } from "./line-families";
import { getCallKey, getTripCallInstant, statesRunEnd, statesRunStart } from "./trip-calls";
import { getRunMarkKey } from "./trips";

/**
 * Turnarounds at a terminus, inferred: the feed publishes an ending run and a starting run, and no
 * field joins them (docs/kvv-efa-api.md). An arrival is paired with a departure only when:
 * - the feed states a run end and a run start (`statesRunEnd` / `statesRunStart`);
 * - both are at the same stop and in the same line family;
 * - the departure goes back over ground the arrival covered;
 * - it is the soonest departure after the published arrival, by published times;
 * - the stand is shorter than the line's headway there (line 6 stands 15 minutes at Tivoli);
 * - the stand is at least `MIN_TURNAROUND_STAND_MS`; a quicker departure spends the arrival rather
 *   than passing it to the next one (Wolfartsweier Nord turns on the same second);
 * - arrivals are paired one to one, in published arrival order.
 * The pairing only lets the diagram draw one standing mark for the stand; nothing else is carried
 * between the two trips.
 */

/** The longest stand paired where no headway can be measured: the network's tightest takt. */
const DEFAULT_TURNAROUND_WINDOW_MS = 10 * 60_000;
/** The longest stand paired whatever the headway; measured turns run 3–15 minutes. */
const MAX_TURNAROUND_STAND_MS = 20 * 60_000;
/**
 * The shortest stand paired. A departure at the arrival's instant is two vehicles or a turn with no
 * time; either way no stand is drawn, and no later departure is tried instead.
 */
const MIN_TURNAROUND_STAND_MS = 60_000;

export type TurnaroundIndex = {
  /**
   * The departure each arrival turns out as. Callers drop the arrival's mark only once that
   * departure is drawn.
   */
  turningDepartureKeyByArrivalKey: ReadonlyMap<string, string>;
  /**
   * When each paired departure may be drawn standing: the arrival's due instant. Unpaired, a trip
   * stands only for the lead before it leaves.
   */
  standFromByDepartureKey: ReadonlyMap<string, number>;
};

/** Same place: by id where both resolved, else by published name. */
function isSameCallStop(left: TripCall, right: TripCall): boolean {
  return left.localStopId && right.localStopId
    ? left.localStopId === right.localStopId
    : left.stopName === right.stopName;
}

/**
 * The stops a run covers away from the terminus, as a set: a loop or short working need not retrace
 * stop for stop. The terminus's own stop points are skipped first.
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

/** Whether the departure retraces any of the arrival's route. */
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
  /** When the feed expects the vehicle here, deviation included; stands are drawn from this. */
  instant: number;
  /** The published time; pairing uses this. */
  scheduledInstant: number;
  route: Set<string>;
};

/** The published time at a call, without deviation. */
function getScheduledCallInstant(call: TripCall, end: "arrival" | "departure"): number | undefined {
  const published =
    end === "arrival"
      ? (call.scheduledArrivalTime ?? call.scheduledDepartureTime)
      : (call.scheduledDepartureTime ?? call.scheduledArrivalTime);
  const instant = published ? Date.parse(published) : Number.NaN;
  return Number.isFinite(instant) ? instant : undefined;
}

/** Run ends and starts, only where the feed states them and the chain is timed. */
function findRunEnds(departures: readonly Departure[]): { arrivals: RunEnd[]; starts: RunEnd[] } {
  const arrivals: RunEnd[] = [];
  const starts: RunEnd[] = [];
  for (const departure of departures) {
    const calls = departure.tripCalls ?? [];
    if (calls.length < 2 || departure.status === "cancelled") continue;
    const key = getRunMarkKey(departure);
    const finalCall = calls[calls.length - 1];
    const firstCall = calls[0];
    const arrivalInstant = statesRunEnd(finalCall)
      ? getTripCallInstant(finalCall, "arrival")
      : undefined;
    const departureInstant = statesRunStart(firstCall) ? getTripCallInstant(firstCall) : undefined;
    const scheduledArrival = getScheduledCallInstant(finalCall, "arrival");
    const scheduledDeparture = getScheduledCallInstant(firstCall, "departure");
    if (arrivalInstant !== undefined && scheduledArrival !== undefined) {
      arrivals.push({
        key,
        departure,
        call: finalCall,
        instant: arrivalInstant,
        scheduledInstant: scheduledArrival,
        route: getRouteAwayFromEnd(calls, "last"),
      });
    }
    if (departureInstant !== undefined && scheduledDeparture !== undefined) {
      starts.push({
        key,
        departure,
        call: firstCall,
        instant: departureInstant,
        scheduledInstant: scheduledDeparture,
        route: getRouteAwayFromEnd(calls, "first"),
      });
    }
  }
  return { arrivals, starts };
}

/**
 * Headways are per line family and calling point: two lines interleaved at five minutes are not
 * five-minute services.
 */
const getTurnaroundGroupKey = (end: RunEnd): string =>
  `${getLineFamilyId(end.departure.lineId)}@${getCallKey(end.call)}`;

/**
 * The line's headway at a terminus, as the smallest gap between its published departures: a missed
 * run widens the average, and erring short only refuses pairings.
 */
function findHeadwayMsByGroup(starts: readonly RunEnd[]): Map<string, number> {
  const instantsByGroup = new Map<string, number[]>();
  for (const start of starts) {
    const group = getTurnaroundGroupKey(start);
    instantsByGroup.set(group, [...(instantsByGroup.get(group) ?? []), start.scheduledInstant]);
  }
  const headwayMsByGroup = new Map<string, number>();
  for (const [group, instants] of instantsByGroup) {
    const ordered = [...new Set(instants)].sort((left, right) => left - right);
    let headway: number | undefined;
    for (let index = 1; index < ordered.length; index += 1) {
      const gap = ordered[index] - ordered[index - 1];
      if (gap > 0 && (headway === undefined || gap < headway)) headway = gap;
    }
    if (headway !== undefined) headwayMsByGroup.set(group, headway);
  }
  return headwayMsByGroup;
}

/** The longest stand a pairing may claim: a second short of the headway, else the default. */
function findStandWindowMs(headwayMs: number | undefined): number {
  return headwayMs === undefined
    ? DEFAULT_TURNAROUND_WINDOW_MS
    : Math.min(headwayMs - 1_000, MAX_TURNAROUND_STAND_MS);
}

/** Which arrival turns out as which departure; see the module comment. */
export function findTurnarounds(departures: readonly Departure[]): TurnaroundIndex {
  const { arrivals, starts } = findRunEnds(departures);
  const headwayMsByGroup = findHeadwayMsByGroup(starts);
  const turningDepartureKeyByArrivalKey = new Map<string, string>();
  const standFromByDepartureKey = new Map<string, number>();
  // Departures already answered, even by a too-quick pairing; looking past them would invent a
  // stand.
  const spentStartKeys = new Set<string>();

  // In published arrival order, so pairings never cross.
  const orderedArrivals = [...arrivals].sort(
    (left, right) =>
      left.scheduledInstant - right.scheduledInstant || left.key.localeCompare(right.key),
  );
  for (const arrival of orderedArrivals) {
    let soonest: RunEnd | undefined;
    for (const start of starts) {
      if (
        spentStartKeys.has(start.key) ||
        start.key === arrival.key ||
        start.scheduledInstant < arrival.scheduledInstant ||
        !isSameLineFamily(arrival.departure.lineId, start.departure.lineId) ||
        !isSameCallStop(arrival.call, start.call) ||
        !isReversal(arrival, start)
      ) {
        continue;
      }
      const isSooner =
        soonest === undefined ||
        start.scheduledInstant < soonest.scheduledInstant ||
        (start.scheduledInstant === soonest.scheduledInstant &&
          start.key.localeCompare(soonest.key) < 0);
      if (isSooner) soonest = start;
    }
    if (!soonest) continue;

    const gap = soonest.scheduledInstant - arrival.scheduledInstant;
    // Beyond the window: no turn here. The departure stays free for a later, closer arrival.
    if (gap > findStandWindowMs(headwayMsByGroup.get(getTurnaroundGroupKey(soonest)))) continue;
    spentStartKeys.add(soonest.key);
    if (gap < MIN_TURNAROUND_STAND_MS) continue;
    turningDepartureKeyByArrivalKey.set(arrival.key, soonest.key);
    standFromByDepartureKey.set(soonest.key, arrival.instant);
  }
  return { turningDepartureKeyByArrivalKey, standFromByDepartureKey };
}
