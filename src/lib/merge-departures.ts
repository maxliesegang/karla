import type { Departure } from "../data/transit-types";
import { getRunTimeline, type TimedRunCall } from "./run-timeline";
import { collapseTurnaroundCalls } from "./trip-calls";

/** Departures into a merge, read from the runs themselves: where the order of trams is decided. */

const getStopTimeline = (run: Departure): TimedRunCall[] =>
  getRunTimeline(collapseTurnaroundCalls(run.tripCalls ?? []).filter((call) => call.localStopId));

/** Lettered sections (`2a`, `2b`) are one track. Unstated, a platform is taken as shared. */
const getTrack = ({ call }: TimedRunCall) => call.platformCode?.replace(/[a-z]$/i, "") ?? "";

/** One run's approach to a stop it leaves for the same next stop as others. */
type Approach = { from: string; track: string };

const getStopId = ({ call }: TimedRunCall) => call.localStopId ?? "";

/**
 * Each run's expected departures, as feed instants, where its way joins another's: a stop reached
 * from two stops and left for the same one. Joining before that stop (one shared track there) is
 * decided leaving the stop behind; joining after it (separate tracks) leaving the stop itself.
 * Opposite directions never share a next stop, so they never count.
 */
export function getMergeDepartureInstants(
  runs: readonly (readonly [rowId: string, run: Departure])[],
): Map<string, number[]> {
  const timelines = runs.map(([rowId, run]) => [rowId, getStopTimeline(run)] as const);
  const isPassage = (timeline: readonly TimedRunCall[], index: number) =>
    index > 0 &&
    index + 1 < timeline.length &&
    getStopId(timeline[index - 1]) !== getStopId(timeline[index]) &&
    getStopId(timeline[index]) !== getStopId(timeline[index + 1]);
  const getLinkKey = (timeline: readonly TimedRunCall[], index: number) =>
    `${getStopId(timeline[index])}>${getStopId(timeline[index + 1])}`;

  const approachesByLink = new Map<string, Approach[]>();
  for (const [, timeline] of timelines) {
    for (let index = 1; index + 1 < timeline.length; index += 1) {
      if (!isPassage(timeline, index)) continue;
      const key = getLinkKey(timeline, index);
      const approaches = approachesByLink.get(key) ?? [];
      approaches.push({ from: getStopId(timeline[index - 1]), track: getTrack(timeline[index]) });
      approachesByLink.set(key, approaches);
    }
  }

  const instants = new Map<string, number[]>();
  for (const [rowId, timeline] of timelines) {
    const departures: number[] = [];
    for (let index = 1; index + 1 < timeline.length; index += 1) {
      if (!isPassage(timeline, index)) continue;
      const approaches = approachesByLink.get(getLinkKey(timeline, index)) ?? [];
      const from = getStopId(timeline[index - 1]);
      if (!approaches.some((approach) => approach.from !== from)) continue;
      const track = getTrack(timeline[index]);
      const joinsBefore = approaches.some(
        (approach) =>
          approach.from !== from && (approach.track === track || !approach.track || !track),
      );
      departures.push(joinsBefore ? timeline[index - 1].departure : timeline[index].departure);
    }
    if (departures.length > 0)
      instants.set(
        rowId,
        [...new Set(departures)].sort((a, b) => a - b),
      );
  }
  return instants;
}
