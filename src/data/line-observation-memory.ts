import type { LineObservation } from "../lib/line-observation";

/**
 * What the visit learned about each line's route and direction ids, kept in memory: an outer
 * stretch seen once (off-peak trips may turn short) is read on every later visit. Not persisted, so
 * timetable changes need no undoing.
 */

/** Lines remembered; the oldest is forgotten past this. */
const LINE_OBSERVATION_MEMORY_CAPACITY = 24;

const observationByLineId = new Map<string, LineObservation>();

export function recallLineObservation(lineId: string): LineObservation | undefined {
  return observationByLineId.get(lineId);
}

export function rememberLineObservation(lineId: string, observation: LineObservation): void {
  if (observation.stopIds.length === 0 && observation.directionIds.length === 0) return;
  // Re-inserted, so recently read lines are the ones kept.
  observationByLineId.delete(lineId);
  observationByLineId.set(lineId, observation);
  for (const forgotten of observationByLineId.keys()) {
    if (observationByLineId.size <= LINE_OBSERVATION_MEMORY_CAPACITY) break;
    observationByLineId.delete(forgotten);
  }
}
