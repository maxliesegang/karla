/** Which way a stop's bays run, snapped to the plan's four axes; shared with the refresh script. */
import { toLocalMeters } from "./geo";

export type BayRun = "level" | "upright" | "rising" | "falling";

/** A plan direction: east and south. */
export type PlanDirection = { x: number; y: number };

type Position = { latitude: number; longitude: number };

/** How far bays must spread for their line to set the run, not their journeys. */
const BAY_RUN_SPREAD_METERS = 15;

const getAngleBetween = (left: number, right: number): number => {
  const turn = Math.abs(left - right) % (2 * Math.PI);
  return Math.min(turn, 2 * Math.PI - turn);
};

/** The eight plan directions, nearest a direction (east, south) first. */
export const getOctilinearDirections = (east: number, south: number): readonly PlanDirection[] => {
  const angle = Math.atan2(south, east);
  return Array.from({ length: 8 }, (_, index) => (index * Math.PI) / 4)
    .sort((left, right) => getAngleBetween(left, angle) - getAngleBetween(right, angle))
    .map((turn) => ({ x: Math.round(Math.cos(turn)), y: Math.round(Math.sin(turn)) }));
};

const getBayRun = (east: number, south: number): BayRun => {
  const { x, y } = getOctilinearDirections(east, south)[0];
  return y === 0 ? "level" : x === 0 ? "upright" : x === y ? "falling" : "rising";
};

/** One journey's way through a bay, previous call to next, as an axis to sum (double angle). */
export const getTravelAxis = (previous: Position, next: Position): PlanDirection => {
  const run = toLocalMeters(next.latitude, next.longitude, previous);
  const angle = 2 * Math.atan2(run.y, run.x);
  return { x: Math.cos(angle), y: Math.sin(angle) };
};

/** The run along bays where they spread, else along their journeys' summed axes. */
export const measureBayRun = (
  positions: readonly Position[],
  travel: PlanDirection,
): BayRun | undefined => {
  let widest: PlanDirection | undefined;
  let widestDistance = 0;
  for (let left = 0; left < positions.length; left += 1) {
    for (let right = left + 1; right < positions.length; right += 1) {
      const offset = toLocalMeters(
        positions[right].latitude,
        positions[right].longitude,
        positions[left],
      );
      const distance = Math.hypot(offset.x, offset.y);
      if (distance > widestDistance) {
        widest = offset;
        widestDistance = distance;
      }
    }
  }
  if (widest && widestDistance >= BAY_RUN_SPREAD_METERS) {
    return getBayRun(widest.x, -widest.y);
  }
  if (Math.hypot(travel.x, travel.y) < 1e-9) return undefined;
  const angle = Math.atan2(travel.y, travel.x) / 2;
  return getBayRun(Math.cos(angle), -Math.sin(angle));
};
