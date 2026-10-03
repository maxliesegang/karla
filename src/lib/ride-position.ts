import type { TripCall } from "../data/transit-types";
import { toLocalMeters, type LocalPoint } from "./geo";

/**
 * Where the rider is, from the device: a fix projected onto the trip's links, the next stop being
 * that link's far end. `null` unless the fix is accurate enough, the calls have coordinates, and it
 * lands near the line. Where a line doubles back, the link nearest the timetable's reading wins.
 */

export type RidePositionFix = {
  latitude: number;
  longitude: number;
  /** The browser's accuracy radius in metres. */
  accuracyMeters: number;
};

/** Wider than this, a fix cannot tell one urban link from the next. */
export const MAX_RIDE_POSITION_FIX_ACCURACY_METERS = 250;
/** How far off the line a fix may land and still be about this trip. */
const MAX_RIDE_POSITION_OFF_ROUTE_METERS = 400;
/** Links this close in distance are tied; the timetable decides. */
const AMBIGUOUS_LINK_MARGIN_METERS = 120;

export type RidePosition = {
  /** Index of the call the vehicle is running towards. */
  nextCallIndex: number;
  /** 0 at the call behind, 1 at the call ahead. */
  linkProgress: number;
  /** Metres still to run along the link to that call. */
  metersToNextCall: number;
  /** Distance from the line, which the fix is trusted by. */
  offRouteMeters: number;
};

/** How far along `from`→`to` the origin falls, and how far it sits from that link. */
function projectOntoLink(from: LocalPoint, to: LocalPoint) {
  const deltaX = to.x - from.x;
  const deltaY = to.y - from.y;
  const lengthSquared = deltaX ** 2 + deltaY ** 2;
  // Two calls at one coordinate (a complex's halves) have no direction; the fix is at that point.
  const progress =
    lengthSquared === 0
      ? 1
      : Math.min(1, Math.max(0, (-from.x * deltaX + -from.y * deltaY) / lengthSquared));
  const nearestX = from.x + deltaX * progress;
  const nearestY = from.y + deltaY * progress;
  return {
    progress,
    length: Math.sqrt(lengthSquared),
    distance: Math.sqrt(nearestX ** 2 + nearestY ** 2),
  };
}

/** The fix placed on the trip, or `null`. `preferredCallIndex` (the timetable's) breaks ties. */
export function getRidePosition(
  calls: readonly TripCall[],
  fix: RidePositionFix,
  preferredCallIndex?: number,
): RidePosition | null {
  if (
    !Number.isFinite(fix.accuracyMeters) ||
    fix.accuracyMeters > MAX_RIDE_POSITION_FIX_ACCURACY_METERS
  ) {
    return null;
  }

  const points = calls.map((call) =>
    call.latitude === undefined || call.longitude === undefined
      ? null
      : toLocalMeters(call.latitude, call.longitude, fix),
  );

  // Links need both ends; calls without coordinates leave their ground uncovered.
  const candidates: RidePosition[] = [];
  for (let index = 0; index < calls.length - 1; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    if (!from || !to) continue;
    const { progress, length, distance } = projectOntoLink(from, to);
    if (distance > MAX_RIDE_POSITION_OFF_ROUTE_METERS + fix.accuracyMeters) continue;
    candidates.push({
      nextCallIndex: index + 1,
      linkProgress: progress,
      metersToNextCall: length * (1 - progress),
      offRouteMeters: distance,
    });
  }
  if (candidates.length === 0) return null;

  const nearest = candidates.reduce((best, candidate) =>
    candidate.offRouteMeters < best.offRouteMeters ? candidate : best,
  );
  if (preferredCallIndex === undefined) return nearest;
  // Among tied links, the one nearest the timetable's reading wins.
  const distanceFromPreferred = (candidate: RidePosition) =>
    Math.abs(candidate.nextCallIndex - preferredCallIndex);
  return candidates
    .filter(
      (candidate) =>
        candidate.offRouteMeters <= nearest.offRouteMeters + AMBIGUOUS_LINK_MARGIN_METERS,
    )
    .reduce((best, candidate) =>
      distanceFromPreferred(candidate) < distanceFromPreferred(best) ? candidate : best,
    );
}
