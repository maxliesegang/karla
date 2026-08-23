import type { TransitStop } from "../data/transit-types";
import { getDistanceMeters } from "./geo";

export const MAX_NEARBY_DISTANCE_METERS = 900;
export const MAX_NEARBY_STOP_COUNT = 6;

export type NearbyStop = { stop: TransitStop; distanceMeters: number };

/** Nearby, locatable stops in distance order, bounded so a remote stop is never offered as local. */
export function getNearbyStops(
  stops: readonly TransitStop[],
  latitude: number,
  longitude: number,
  maxDistanceMeters = MAX_NEARBY_DISTANCE_METERS,
  stopCount = MAX_NEARBY_STOP_COUNT,
): NearbyStop[] {
  return stops
    .map((stop) => ({ stop, distanceMeters: getDistanceMeters(latitude, longitude, stop) }))
    .filter(({ distanceMeters }) => distanceMeters <= maxDistanceMeters)
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, stopCount);
}
