import type { LineObservation } from "../lib/line-observation";

/**
 * What the visit has learned about a line's route and its provider direction ids, kept while the
 * app is open.
 *
 * A line's route is discovered from the trips running on it right now, which is less than the line:
 * off-peak every trip through a stop may turn back short, and the stretch past that turnback is
 * then served by nothing the crawl can see — so it is never read, and nothing it would have
 * disclosed is ever learned. Remembering flips that around. The outer stretch has to be seen only
 * once, in the hour it runs through, and every later reading of the line starts from it.
 *
 * Memory only, and deliberately not stored: a route learned by observation is cheap to learn again,
 * and a timetable change should not have to be undone in a rider's browser. Nothing here is
 * rendered — it decides which boards to ask for, and every answer is read from the feed as usual.
 */

/** Enough for the lines one visit reads, which is a handful; past that the oldest is forgotten. */
const LINE_OBSERVATION_MEMORY_CAPACITY = 24;

const observationByLineId = new Map<string, LineObservation>();

export function recallLineObservation(lineId: string): LineObservation | undefined {
  return observationByLineId.get(lineId);
}

export function rememberLineObservation(lineId: string, observation: LineObservation): void {
  if (observation.stopIds.length === 0 && observation.directionIds.length === 0) return;
  // Re-inserted rather than updated in place, so the lines a rider keeps reading stay the ones kept.
  observationByLineId.delete(lineId);
  observationByLineId.set(lineId, observation);
  for (const forgotten of observationByLineId.keys()) {
    if (observationByLineId.size <= LINE_OBSERVATION_MEMORY_CAPACITY) break;
    observationByLineId.delete(forgotten);
  }
}

/** Tests read one visit at a time; nothing in the app forgets a line while it is open. */
export function clearLineObservationMemory(): void {
  observationByLineId.clear();
}
