/**
 * Straight-line distances and local projections, for ranking and placement only, never as routes.
 */

const EARTH_RADIUS_METERS = 6_371_000;
const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/** Anything the feed may locate; either coordinate may be missing. */
export type Located = { latitude?: number; longitude?: number };

/** Great-circle distance; infinity where the other place is unlocated. */
export function getDistanceMeters(latitude: number, longitude: number, other: Located): number {
  if (other.latitude === undefined || other.longitude === undefined)
    return Number.POSITIVE_INFINITY;
  const latitudeDelta = toRadians(other.latitude - latitude);
  const longitudeDelta = toRadians(other.longitude - longitude);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(toRadians(latitude)) *
      Math.cos(toRadians(other.latitude)) *
      Math.sin(longitudeDelta / 2) ** 2;
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Metres east and north of an origin. */
export type LocalPoint = { x: number; y: number };

/** Metres east and north of the origin; a flat projection is ample over a few kilometres. */
export function toLocalMeters(
  latitude: number,
  longitude: number,
  origin: { latitude: number; longitude: number },
): LocalPoint {
  return {
    x:
      toRadians(longitude - origin.longitude) *
      EARTH_RADIUS_METERS *
      Math.cos(toRadians(origin.latitude)),
    y: toRadians(latitude - origin.latitude) * EARTH_RADIUS_METERS,
  };
}

/** A distance as a rider reads it: metres, then kilometres; rounded to ten metres. */
export function formatDistance(meters: number): string {
  return meters < 1_000
    ? `${Math.max(10, Math.round(meters / 10) * 10)} m`
    : `${(meters / 1_000).toFixed(1).replace(".", ",")} km`;
}
