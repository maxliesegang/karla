/**
 * Distances on the ground, for the two questions the app asks of a coordinate: how far apart two
 * places are, and where one of them falls relative to another.
 *
 * Both readings are approximations and are only ever presented as such — a straight line between
 * two points, never a route someone could walk or ride. What they are used for is ranking and
 * placement, where the error of a spherical earth is orders of magnitude below the accuracy of the
 * fixes being ranked.
 */

const EARTH_RADIUS_METERS = 6_371_000;
const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/** Anything the feed gives a place to — a stop, a calling point — which it may also leave unplaced. */
export type Located = { latitude?: number; longitude?: number };

/** Great-circle distance, or infinity where the other place is not located at all. */
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

/**
 * A place as metres east and north of the origin. Over the few kilometres anything here spans, the
 * flat projection is accurate to well under the accuracy of the fixes measured against it.
 */
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

/**
 * A distance as a rider reads it: metres while they are worth counting, kilometres once they are
 * not. Rounded to ten metres, because a straight-line estimate does not know the last five.
 */
export function formatDistance(meters: number): string {
  return meters < 1_000
    ? `${Math.max(10, Math.round(meters / 10) * 10)} m`
    : `${(meters / 1_000).toFixed(1).replace(".", ",")} km`;
}
