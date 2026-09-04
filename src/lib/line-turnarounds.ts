import type { Departure, TripCall } from "../data/transit-types";
import { getLineFamilyId, isSameLineFamily } from "./line-families";
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
 * - the departure leaves after the arrival is published to be in, and it is the *soonest* such
 *   departure — an arrival turns out as the next run away from that stop, never as one two
 *   departures later. Both sides are read from the published times rather than the predicted ones:
 *   which vehicle turns into which working is a fact about the plan, so a run falling behind must
 *   not re-pair the terminus around it;
 * - the stand it implies is shorter than the headway the line runs at that terminus, measured from
 *   the published departures the reading has in hand. This is where the pairing gets its bound,
 *   and it replaces a fixed window that had to be shorter than the tightest takt in the network
 *   and so refused every turn longer than it — line 6 stands 15 minutes at Tivoli and line 1
 *   stands 11 at Neureut-Heide, both of which a ten-minute window could never see. A stand of a
 *   whole headway or more is the *next* vehicle's turn, never this one's, and pairing across one
 *   is how a terminus drifts: each arrival handed a departure one working too far along, the error
 *   compounding down the day (`docs/kvv-efa-api.md`);
 * - and that soonest departure leaves late enough to be a stand a rider could watch. A departure
 *   timed at the arrival's own instant is either one vehicle pulling in as another pulls out, or a
 *   turn the timetable gives no time at all; the reading does not say which, so no stand is drawn.
 *   What it must not do is hand the arrival on to the *next* departure instead. That is how a
 *   turning point whose arrivals and departures are timed together — Wolfartsweier Nord, a tram in
 *   at :34:48 and one out at :34:48 through the whole of the ten-minute service — came to show a
 *   mark standing there for the ten minutes until the following departure, and then the ten after
 *   that, and so on all day. A pairing rejected for being too quick spends both of its ends rather
 *   than looking past them;
 * - one arrival to one departure, in the order the arrivals are published to come in, so a terminus
 *   turning three vehicles in ten minutes pairs them in the order they can actually be run, and
 *   never twice. Read nearest-gap-first instead, two pairings cross: an arrival that could have
 *   taken the departure in front of it is left the one behind.
 *
 * What none of this can settle is which of two readings a headway apart is the true one. A terminus
 * repeats, so an arrival turning out `g` minutes later and the same arrival turning out `g` plus a
 * headway later satisfy the published timetable equally, differing only by one more vehicle in the
 * fleet standing one more turn. The minimal reading is taken because it is the one that claims
 * least, and where even that is impossible — a gap of nothing at all — nothing is claimed instead.
 *
 * What the pairing is used for is deliberately modest: the diagram draws one standing mark for the
 * stand rather than two, and may draw it for the whole of a longer turnaround. It never claims the
 * vehicle is a particular one, and no time, deviation or platform is carried from one trip to the
 * other.
 */

/**
 * The longest stand read as one vehicle turning, where the headway cannot be measured.
 *
 * A reading that has caught only one run starting at a terminus cannot say how often the next one
 * follows, so it falls back on the tightest takt in the network. That is the conservative end of
 * the trade: it refuses the long turns a measured headway allows, rather than inventing a stand at
 * a terminus whose service it has not seen enough of to bound.
 */
export const DEFAULT_TURNAROUND_WINDOW_MS = 10 * 60_000;
/**
 * The longest stand read as one vehicle turning, whatever the headway allows.
 *
 * A late-evening terminus running every twenty minutes would otherwise let a pairing claim a
 * nineteen-minute stand, which is a great deal to infer from two trips that share only a place.
 * Turns measured across the network run from three minutes to fifteen (`docs/kvv-efa-api.md`), so
 * this sits above the longest of them and well below a sparse headway.
 */
export const MAX_TURNAROUND_STAND_MS = 20 * 60_000;
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
  /** When the feed expects the vehicle here, deviation included — what a stand is drawn from. */
  instant: number;
  /** The published time, which is what the pairing itself is made on. */
  scheduledInstant: number;
  /** Where this run goes away from the end in question, kept once per run rather than per pairing. */
  route: Set<string>;
};

/** The published time at a call, with no deviation folded in: the plan, not the prediction. */
function getScheduledCallInstant(call: TripCall, end: "arrival" | "departure"): number | undefined {
  const published =
    end === "arrival"
      ? (call.scheduledArrivalTime ?? call.scheduledDepartureTime)
      : (call.scheduledDepartureTime ?? call.scheduledArrivalTime);
  const instant = published ? Date.parse(published) : Number.NaN;
  return Number.isFinite(instant) ? instant : undefined;
}

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
 * The service one line runs at one terminus, which is what a stand there is measured against.
 *
 * Grouped by line family and calling point, so a terminus several lines turn at states a headway
 * for each of them rather than one for the platform. Two lines interleaved at five minutes do not
 * make either of them a five-minute service, and it is the line's own repetition that says how long
 * one of its vehicles can be standing before the stand belongs to the vehicle behind.
 */
const getTurnaroundGroupKey = (end: RunEnd): string =>
  `${getLineFamilyId(end.departure.lineId)}@${getCallKey(end.call)}`;

/**
 * How often the line sets out from that terminus, as the closest together two of its departures are
 * published to be.
 *
 * The smallest gap rather than the average or the middle one, because a reading holds the runs it
 * happened to catch: a missing run leaves a gap of two headways and would talk the bound upwards,
 * while an extra working leaves a short one and talks it down. Erring short only refuses pairings,
 * which is the direction this should fail in.
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

/**
 * The longest stand this pairing may claim, from the service the terminus runs.
 *
 * A second short of the headway, because sequences are timed to the second and a stand of the whole
 * headway is the following vehicle's turn rather than this one's.
 */
function findStandWindowMs(headwayMs: number | undefined): number {
  return headwayMs === undefined
    ? DEFAULT_TURNAROUND_WINDOW_MS
    : Math.min(headwayMs - 1_000, MAX_TURNAROUND_STAND_MS);
}

/** Which arrival turns back out as which departure, under the rules stated above. */
export function findTurnarounds(departures: readonly Departure[]): TurnaroundIndex {
  const { arrivals, starts } = findRunEnds(departures);
  const headwayMsByGroup = findHeadwayMsByGroup(starts);
  const turningDepartureKeyByArrivalKey = new Map<string, string>();
  const standFromByDepartureKey = new Map<string, number>();
  // What each departure has been answered by, whether or not that answer was a stand worth drawing.
  // An arrival whose own next departure left too soon to be a turn has been accounted for, and
  // looking past it to a later departure is the invention this exists to refuse.
  const spentStartKeys = new Set<string>();

  // In the order the arrivals are published to come in: a vehicle cannot turn out ahead of one that
  // arrived before it, so pairing them in any other order crosses two of them over each other.
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
    // Beyond the window this arrival simply has no turn to claim here — a vehicle bound for the
    // depot leaves the same way. The departure stays unspent, because an arrival after this one is
    // *closer* to it and may well be the one that runs it.
    if (gap > findStandWindowMs(headwayMsByGroup.get(getTurnaroundGroupKey(soonest)))) continue;
    spentStartKeys.add(soonest.key);
    if (gap < MIN_TURNAROUND_STAND_MS) continue;
    turningDepartureKeyByArrivalKey.set(arrival.key, soonest.key);
    standFromByDepartureKey.set(soonest.key, arrival.instant);
  }
  return { turningDepartureKeyByArrivalKey, standFromByDepartureKey };
}
