import type { TripCall } from "../data/transit-types";
import { toLocalMeters, type LocalPoint } from "./geo";

/**
 * Where the rider is, read off the device rather than off the timetable.
 *
 * On board, the estimate the feed states and the vehicle the rider is sitting in are two different
 * facts, and the device knows which one is true: a trip may be timed to have left Marktplatz while
 * the tram is still standing in it. So when the rider has granted location, the ride reads its own
 * position instead — the calls carry coordinates, so the fix is projected onto the link it falls on
 * and the next stop is that link's far end.
 *
 * What this must never do is place a rider it cannot place. A fix is only used when the browser's
 * own accuracy radius is small enough to distinguish one link from the next, when the calls it is
 * measured against actually carry coordinates, and when it lands near the line at all — a rider who
 * is nowhere near this trip is not somewhere along it. In every one of those cases the answer is
 * `null` and the ride goes back to reading the feed, which is a worse estimate but still a true
 * statement about the trip.
 *
 * A line that doubles back on itself passes the same ground twice, and a fix alone cannot say which
 * pass it is. Where two links are equally good the one nearest the timetable's own reading wins:
 * the feed is a poor clock but a reliable account of the order stops come in.
 */

export type RidePositionFix = {
  latitude: number;
  longitude: number;
  /** The browser's stated accuracy radius in metres. Without one a fix cannot be judged at all. */
  accuracyMeters: number;
};

/** Wider than this and the fix cannot tell one link of an urban line from the next. */
export const MAX_FIX_ACCURACY_METERS = 250;
/** How far off the line a fix may land before it stops being evidence about this trip. */
export const MAX_OFF_ROUTE_METERS = 400;
/** Two links this close to equally good are not distinguished by distance; the timetable decides. */
const AMBIGUOUS_LINK_MARGIN_METERS = 120;

export type RideLocation = {
  /** Index into the trip's calls of the stop the vehicle is running towards. */
  nextCallIndex: number;
  /** 0 at the call behind, 1 at the call ahead: how far along that link the fix sits. */
  linkProgress: number;
  /** Metres still to run along the link to that call. */
  metersToNextCall: number;
  /** How far the fix sits from the line itself, which is what its trustworthiness is judged on. */
  offRouteMeters: number;
};

/** How far along `from`→`to` the origin falls, and how far it sits from that link. */
function projectOntoLink(from: LocalPoint, to: LocalPoint) {
  const deltaX = to.x - from.x;
  const deltaY = to.y - from.y;
  const lengthSquared = deltaX ** 2 + deltaY ** 2;
  // Two calls at one coordinate — a stop complex naming both of its halves — have no direction to
  // project onto; the fix is simply at that point.
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

/**
 * The fix placed on the trip, or nothing when it cannot honestly be placed.
 *
 * `preferredCallIndex` is the timetable's own reading of which call is next; it settles a tie
 * between two passes over the same ground and is ignored where the fix is unambiguous.
 */
export function locateOnTripCalls(
  calls: readonly TripCall[],
  fix: RidePositionFix,
  preferredCallIndex?: number,
): RideLocation | null {
  if (!Number.isFinite(fix.accuracyMeters) || fix.accuracyMeters > MAX_FIX_ACCURACY_METERS) {
    return null;
  }

  const points = calls.map((call) =>
    call.latitude === undefined || call.longitude === undefined
      ? null
      : toLocalMeters(call.latitude, call.longitude, fix),
  );

  // A link needs both of its ends. Where the feed omits a call's coordinates the ground on either
  // side of it is simply not covered, rather than being spanned by a link that skips a stop.
  const candidates: RideLocation[] = [];
  for (let index = 0; index < calls.length - 1; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    if (!from || !to) continue;
    const { progress, length, distance } = projectOntoLink(from, to);
    if (distance > MAX_OFF_ROUTE_METERS + fix.accuracyMeters) continue;
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
  // Among the links the fix cannot tell apart, the timetable's own place in the sequence decides.
  const distanceFromPreferred = (candidate: RideLocation) =>
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
