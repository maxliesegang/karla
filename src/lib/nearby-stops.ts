import type { Bounds } from "../data/network-scope";
import type { StopPlace } from "../data/transit-types";
import { getDistanceMeters } from "./geo";

const MAX_NEARBY_DISTANCE_METERS = 900;
const MAX_NEARBY_STOP_COUNT = 6;
/** The grid an area search snaps to, so only a cell of about 500 m leaves the device. */
const SEARCH_CELL_DEGREES = 0.005;
const METERS_PER_DEGREE_LATITUDE = 111_320;

export type NearbyStop = { stop: StopPlace; distanceMeters: number };

/** Nearby, locatable stops in distance order, bounded so a remote stop is never offered as local. */
export function getNearbyStops(
  stops: readonly StopPlace[],
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

/**
 * The area to ask for stops: every stop in reach of any point of the position's grid cell, edges in
 * whole thousandths of a degree.
 */
export function getNearbySearchBounds(
  latitude: number,
  longitude: number,
  maxDistanceMeters = MAX_NEARBY_DISTANCE_METERS,
): Bounds {
  const snap = (degrees: number) => Math.round(degrees / SEARCH_CELL_DEGREES) * SEARCH_CELL_DEGREES;
  const cellLatitude = snap(latitude);
  const cellLongitude = snap(longitude);
  const latitudeReach = SEARCH_CELL_DEGREES / 2 + maxDistanceMeters / METERS_PER_DEGREE_LATITUDE;
  // Measured at the edge nearer the pole, where a degree of longitude is shortest.
  const poleward = Math.min(89, Math.abs(cellLatitude) + latitudeReach);
  const longitudeReach =
    SEARCH_CELL_DEGREES / 2 +
    maxDistanceMeters / (METERS_PER_DEGREE_LATITUDE * Math.cos((poleward * Math.PI) / 180));
  const floor = (degrees: number) => Math.floor(degrees * 1_000) / 1_000;
  const ceil = (degrees: number) => Math.ceil(degrees * 1_000) / 1_000;
  return {
    south: floor(cellLatitude - latitudeReach),
    north: ceil(cellLatitude + latitudeReach),
    west: floor(cellLongitude - longitudeReach),
    east: ceil(cellLongitude + longitudeReach),
  };
}
