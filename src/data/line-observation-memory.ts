import { isSameLineIdentity } from "../lib/line-identity";
import type { LineObservation } from "../lib/line-observation";

/**
 * What the visit learned about each line's route and direction ids, kept in memory: an outer
 * stretch seen once (off-peak journeys may turn short) is read on every later visit. Not persisted,
 * so timetable changes need no undoing.
 */

/** Lines remembered; the oldest is forgotten past this. */
const LINE_OBSERVATION_MEMORY_CAPACITY = 24;

/** By name; the identity tells another network's line of the same name apart. */
const observationByLineId = new Map<string, { identity?: string; observation: LineObservation }>();

export function recallLineObservation(
  lineId: string,
  identity?: string,
): LineObservation | undefined {
  const remembered = observationByLineId.get(lineId);
  return remembered && isSameLineIdentity(remembered.identity, identity)
    ? remembered.observation
    : undefined;
}

export function rememberLineObservation(
  lineId: string,
  observation: LineObservation,
  identity?: string,
): void {
  if (observation.stopIds.length === 0 && observation.lineRefs.length === 0) return;
  // Re-inserted, so recently read lines are the ones kept.
  observationByLineId.delete(lineId);
  observationByLineId.set(lineId, { identity, observation });
  for (const forgotten of observationByLineId.keys()) {
    if (observationByLineId.size <= LINE_OBSERVATION_MEMORY_CAPACITY) break;
    observationByLineId.delete(forgotten);
  }
}
