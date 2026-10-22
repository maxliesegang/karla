import type { StopEvent, Call } from "../data/transit-types";
import { getLineFamilyId, isSameLineFamily } from "./line-families";
import {
  getCallKey,
  getCallInstant,
  statesDatedJourneyEnd,
  statesDatedJourneyStart,
} from "./calls";
import { getDatedJourneyMarkKey } from "./journeys";

/**
 * Turnarounds at a terminus, inferred: the feed publishes an ending dated journey and a starting
 * one, and no field joins them (docs/kvv-efa-api.md). An arrival is paired with a departure only
 * when:
 * - the feed states a dated journey end and a dated journey start (`statesDatedJourneyEnd` /
 * `statesDatedJourneyStart`);
 * - both are at the same stop and in the same line family;
 * - the departure goes back over ground the arrival covered;
 * - it is the soonest departure after the published arrival, by published times;
 * - the stand is shorter than the line's headway there (line 6 stands 15 minutes at Tivoli);
 * - the stand is at least `MIN_TURNAROUND_STAND_MS`; a quicker departure spends the arrival rather
 *   than passing it to the next one (Wolfartsweier Nord turns on the same second);
 * - arrivals are paired one to one, in published arrival order.
 * The pairing only lets the diagram draw one standing mark for the stand; nothing else is carried
 * between the two journeys.
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
   * When each paired departure may be drawn standing: the arrival's due instant. Unpaired, a
   * journey stands only for the lead before it leaves.
   */
  standFromByDepartureKey: ReadonlyMap<string, number>;
};

/** Same place: by id where both resolved, else by published name. */
function isSameCallStop(left: Call, right: Call): boolean {
  return left.localStopId && right.localStopId
    ? left.localStopId === right.localStopId
    : left.stopName === right.stopName;
}

/**
 * The stops a dated journey covers away from the terminus, as a set: a loop or short working need
 * not retrace stop for stop. The terminus's own stop points are skipped first.
 */
function getRouteAwayFromEnd(calls: readonly Call[], end: "first" | "last"): Set<string> {
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
function isReversal(arrival: DatedJourneyEnd, start: DatedJourneyEnd): boolean {
  for (const key of start.route) {
    if (arrival.route.has(key)) return true;
  }
  return false;
}

type DatedJourneyEnd = {
  key: string;
  stopEvent: StopEvent;
  call: Call;
  /** When the feed expects the vehicle here, deviation included; stands are drawn from this. */
  instant: number;
  /** The published time; pairing uses this. */
  timetabledInstant: number;
  route: Set<string>;
};

/** The published time at a call, without deviation. */
function getTimetabledCallInstant(call: Call, end: "arrival" | "departure"): number | undefined {
  const published =
    end === "arrival"
      ? (call.timetabledArrivalTime ?? call.timetabledDepartureTime)
      : (call.timetabledDepartureTime ?? call.timetabledArrivalTime);
  const instant = published ? Date.parse(published) : Number.NaN;
  return Number.isFinite(instant) ? instant : undefined;
}

/** Run ends and starts, only where the feed states them and the chain is timed. */
function findDatedJourneyEnds(stopEvents: readonly StopEvent[]): {
  arrivals: DatedJourneyEnd[];
  starts: DatedJourneyEnd[];
} {
  const arrivals: DatedJourneyEnd[] = [];
  const starts: DatedJourneyEnd[] = [];
  for (const stopEvent of stopEvents) {
    const calls = stopEvent.calls ?? [];
    if (calls.length < 2 || stopEvent.status === "cancelled") continue;
    const key = getDatedJourneyMarkKey(stopEvent);
    const finalCall = calls[calls.length - 1];
    const firstCall = calls[0];
    const arrivalInstant = statesDatedJourneyEnd(finalCall)
      ? getCallInstant(finalCall, "arrival")
      : undefined;
    const departureInstant = statesDatedJourneyStart(firstCall)
      ? getCallInstant(firstCall)
      : undefined;
    const timetabledArrival = getTimetabledCallInstant(finalCall, "arrival");
    const timetabledDeparture = getTimetabledCallInstant(firstCall, "departure");
    if (arrivalInstant !== undefined && timetabledArrival !== undefined) {
      arrivals.push({
        key,
        stopEvent,
        call: finalCall,
        instant: arrivalInstant,
        timetabledInstant: timetabledArrival,
        route: getRouteAwayFromEnd(calls, "last"),
      });
    }
    if (departureInstant !== undefined && timetabledDeparture !== undefined) {
      starts.push({
        key,
        stopEvent,
        call: firstCall,
        instant: departureInstant,
        timetabledInstant: timetabledDeparture,
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
const getTurnaroundGroupKey = (end: DatedJourneyEnd): string =>
  `${getLineFamilyId(end.stopEvent.lineId)}@${getCallKey(end.call)}`;

/**
 * The line's headway at a terminus, as the smallest gap between its published departures: a missed
 * journey widens the average, and erring short only refuses pairings.
 */
function findHeadwayMsByGroup(starts: readonly DatedJourneyEnd[]): Map<string, number> {
  const instantsByGroup = new Map<string, number[]>();
  for (const start of starts) {
    const group = getTurnaroundGroupKey(start);
    instantsByGroup.set(group, [...(instantsByGroup.get(group) ?? []), start.timetabledInstant]);
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
export function findTurnarounds(stopEvents: readonly StopEvent[]): TurnaroundIndex {
  const { arrivals, starts } = findDatedJourneyEnds(stopEvents);
  const headwayMsByGroup = findHeadwayMsByGroup(starts);
  const turningDepartureKeyByArrivalKey = new Map<string, string>();
  const standFromByDepartureKey = new Map<string, number>();
  // Departures already answered, even by a too-quick pairing; looking past them would invent a
  // stand.
  const spentStartKeys = new Set<string>();

  // In published arrival order, so pairings never cross.
  const orderedArrivals = [...arrivals].sort(
    (left, right) =>
      left.timetabledInstant - right.timetabledInstant || left.key.localeCompare(right.key),
  );
  for (const arrival of orderedArrivals) {
    let soonest: DatedJourneyEnd | undefined;
    for (const start of starts) {
      if (
        spentStartKeys.has(start.key) ||
        start.key === arrival.key ||
        start.timetabledInstant < arrival.timetabledInstant ||
        !isSameLineFamily(arrival.stopEvent.lineId, start.stopEvent.lineId) ||
        !isSameCallStop(arrival.call, start.call) ||
        !isReversal(arrival, start)
      ) {
        continue;
      }
      const isSooner =
        soonest === undefined ||
        start.timetabledInstant < soonest.timetabledInstant ||
        (start.timetabledInstant === soonest.timetabledInstant &&
          start.key.localeCompare(soonest.key) < 0);
      if (isSooner) soonest = start;
    }
    if (!soonest) continue;

    const gap = soonest.timetabledInstant - arrival.timetabledInstant;
    // Beyond the window: no turn here. The departure stays free for a later, closer arrival.
    if (gap > findStandWindowMs(headwayMsByGroup.get(getTurnaroundGroupKey(soonest)))) continue;
    spentStartKeys.add(soonest.key);
    if (gap < MIN_TURNAROUND_STAND_MS) continue;
    turningDepartureKeyByArrivalKey.set(arrival.key, soonest.key);
    standFromByDepartureKey.set(soonest.key, arrival.instant);
  }
  return { turningDepartureKeyByArrivalKey, standFromByDepartureKey };
}
