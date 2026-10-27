/** Observation posts and dated journey lifetimes for an explicitly bounded area. */
import type { StopEvent, DatedJourneyDiscoveryPost } from "../data/transit-types";
import { statesDatedJourneyEnd } from "./calls";
import { getDatedJourneyTimeline } from "./dated-journey-timeline";
import { isRailStopEvent } from "./zentrum-schematic-plan";

export const DATED_JOURNEY_DISCOVERY_APPROACH_MS = 10 * 60_000;
const AREA_EXIT_GRACE_MS = 2 * 60_000;

export function getDatedJourneyDiscoveryPosts(
  areaStopIds: readonly string[],
  datedJourneys: readonly StopEvent[],
): DatedJourneyDiscoveryPost[] {
  const area = new Set(areaStopIds);
  const posts = new Map<string, DatedJourneyDiscoveryPost>();
  const add = (stopId: string, eventKind: DatedJourneyDiscoveryPost["eventKind"]) => {
    posts.set(`${stopId}:${eventKind}`, { stopId, eventKind });
  };
  for (const datedJourney of datedJourneys) {
    if (!isRailStopEvent(datedJourney) || datedJourney.status === "cancelled") continue;
    const calls = datedJourney.calls ?? [];
    for (const [index, call] of calls.entries()) {
      const stopId = call.stopPlaceId;
      if (!stopId || !area.has(stopId)) continue;
      const next = calls[index + 1];
      if (next && !area.has(next.stopPlaceId ?? "")) add(stopId, "departure");
      if (index === calls.length - 1 && statesDatedJourneyEnd(call)) {
        add(stopId, "departure");
        add(stopId, "arrival");
      }
    }
  }
  return [...posts.values()].sort(
    (a, b) => a.stopId.localeCompare(b.stopId) || a.eventKind.localeCompare(b.eventKind),
  );
}

export function isDatedJourneyInArea(
  datedJourney: StopEvent,
  feedNow: number,
  areaStopIds: ReadonlySet<string>,
): boolean {
  const calls = datedJourney.calls ?? [];
  const timeline = new Map(getDatedJourneyTimeline(calls).map((entry) => [entry.call, entry]));
  for (let index = 0; index < calls.length; index += 1) {
    if (!areaStopIds.has(calls[index].stopPlaceId ?? "")) continue;
    const startsAt = timeline.get(calls[index])?.arrival;
    let end = index;
    while (end + 1 < calls.length && areaStopIds.has(calls[end + 1].stopPlaceId ?? "")) end += 1;
    const endsAt = timeline.get(calls[end])?.departure;
    if (
      startsAt !== undefined &&
      endsAt !== undefined &&
      startsAt <= feedNow + DATED_JOURNEY_DISCOVERY_APPROACH_MS &&
      endsAt + AREA_EXIT_GRACE_MS >= feedNow
    )
      return true;
    index = end;
  }
  return false;
}
