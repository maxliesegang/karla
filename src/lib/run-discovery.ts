/** Observation posts and run lifetimes for an explicitly bounded area. */
import type { Departure, RunDiscoveryPost } from "../data/transit-types";
import { statesRunEnd } from "./trip-calls";
import { getRunTimeline } from "./run-timeline";
import { isRailDeparture } from "./zentrum-schematic-plan";

export const RUN_DISCOVERY_APPROACH_MS = 10 * 60_000;
const AREA_EXIT_GRACE_MS = 2 * 60_000;

export function getRunDiscoveryPosts(
  areaStopIds: readonly string[],
  runs: readonly Departure[],
): RunDiscoveryPost[] {
  const area = new Set(areaStopIds);
  const posts = new Map<string, RunDiscoveryPost>();
  const add = (stopId: string, eventKind: RunDiscoveryPost["eventKind"]) => {
    posts.set(`${stopId}:${eventKind}`, { stopId, eventKind });
  };
  for (const run of runs) {
    if (!isRailDeparture(run) || run.status === "cancelled") continue;
    const calls = run.tripCalls ?? [];
    for (const [index, call] of calls.entries()) {
      const stopId = call.localStopId;
      if (!stopId || !area.has(stopId)) continue;
      const next = calls[index + 1];
      if (next && !area.has(next.localStopId ?? "")) add(stopId, "departure");
      if (index === calls.length - 1 && statesRunEnd(call)) {
        add(stopId, "departure");
        add(stopId, "arrival");
      }
    }
  }
  return [...posts.values()].sort(
    (a, b) => a.stopId.localeCompare(b.stopId) || a.eventKind.localeCompare(b.eventKind),
  );
}

export function isRunInArea(
  run: Departure,
  feedNow: number,
  areaStopIds: ReadonlySet<string>,
): boolean {
  const calls = run.tripCalls ?? [];
  const timeline = new Map(getRunTimeline(calls).map((entry) => [entry.call, entry]));
  for (let index = 0; index < calls.length; index += 1) {
    if (!areaStopIds.has(calls[index].localStopId ?? "")) continue;
    const startsAt = timeline.get(calls[index])?.arrival;
    let end = index;
    while (end + 1 < calls.length && areaStopIds.has(calls[end + 1].localStopId ?? "")) end += 1;
    const endsAt = timeline.get(calls[end])?.departure;
    if (
      startsAt !== undefined &&
      endsAt !== undefined &&
      startsAt <= feedNow + RUN_DISCOVERY_APPROACH_MS &&
      endsAt + AREA_EXIT_GRACE_MS >= feedNow
    )
      return true;
    index = end;
  }
  return false;
}
