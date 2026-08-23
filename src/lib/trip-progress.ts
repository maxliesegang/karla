import type { TripCall } from "../data/transit-types";
import { locateOnTripCalls, type RidePositionFix } from "./ride-location";
import { getTripCallInstant } from "./trip-calls";

/**
 * Where a ride has got to.
 *
 * A rider on board asks three things and no others: what the next stop is, how long until they are
 * there, and how many stops until the one they want. Everything here answers one of those, read off
 * the trip's own calls — the schedule the feed states plus the deviation it measures beside it,
 * never a running time assumed from the two.
 *
 * A call is *past* once the vehicle is due to have left it. That is the same reading the line
 * diagram uses, so the row a rider sees highlighted and the stop the ride status names are always the
 * same stop.
 *
 * On board there is a better witness than the timetable, and it is the rider's own device. Where a
 * fix is in hand it decides which call is next and how much of the link to it is left — the feed's
 * estimate says when the vehicle is *due* to have left a stop, the fix says whether it has. The
 * timetable is still what turns the remaining distance into minutes, because it is the only account
 * of how long this link takes. A fix that cannot be placed (see `lib/ride-location.ts`) changes
 * nothing: the reading falls back to the feed's, and says which of the two it is.
 */

export type TripProgress = {
  /** Which witness this reading came from, so a view never presents one as the other. */
  source: "position" | "schedule";
  /** Metres still to run to the next call, where the position placed the vehicle. */
  metersToNextCall?: number;
  /** The call the vehicle is running towards, or nothing once the last one is behind it. */
  nextCall?: TripCall;
  /** Minutes until that call, from the feed's clock. */
  minutesToNextCall?: number;
  /** How many calls the trip has already made, which is what a collapsed history counts. */
  passedCallCount: number;
  /** The rider's marked Ausstieg, when it is still ahead of the vehicle. */
  alightingCall?: TripCall;
  /** Calls still to make before the Ausstieg, the next one included. */
  stopsToAlighting?: number;
  /** The vehicle is due at the Ausstieg next: the point at which a rider has to stand up. */
  isAlightingNext: boolean;
  /** Either the Ausstieg is behind the vehicle, or the trip has made its last call. */
  isFinished: boolean;
  /** Where the ride ended, for the wording that replaces the countdown. */
  finalCall?: TripCall;
};

/**
 * Minutes to the next call from where the rider actually is: the share of the link still ahead of
 * them, spent at the pace the timetable gives that link. Without a timed link there is no pace to
 * spend, and the caller keeps the feed's own countdown.
 */
function getMinutesFromLinkProgress(
  tripCalls: readonly TripCall[],
  nextCallIndex: number,
  linkProgress: number,
): number | undefined {
  const departure = getTripCallInstant(tripCalls[nextCallIndex - 1], "departure");
  const arrival = getTripCallInstant(tripCalls[nextCallIndex], "arrival");
  if (departure === undefined || arrival === undefined) return undefined;
  const linkDuration = arrival - departure;
  if (!(linkDuration > 0)) return undefined;
  return Math.max(0, Math.round((linkDuration * (1 - linkProgress)) / 60_000));
}

/** What a ride reads besides its calls: where the rider is going, and where they are. */
export type TripProgressOptions = {
  /** The stop the rider marked as their Ausstieg, where they have marked one. */
  alightingStopId?: string;
  /** The rider's own position, where they have granted it and it is fresh. */
  fix?: RidePositionFix;
};

export function getTripProgress(
  tripCalls: readonly TripCall[],
  feedNow: number,
  { alightingStopId, fix }: TripProgressOptions = {},
): TripProgress {
  // A call with no time cannot be placed against the clock, so it is neither past nor ahead: the
  // last call that is definitely past is what the position is read from.
  const isPast = (call: TripCall) => {
    const instant = getTripCallInstant(call);
    return instant !== undefined && feedNow > instant;
  };

  const scheduledNextIndex = tripCalls.findIndex((call) => !isPast(call));
  // The trip is over when the feed says its last call is behind the vehicle; a fix cannot extend a
  // ride past its end, so location is only consulted while the trip is still running.
  const location =
    fix && scheduledNextIndex >= 0 ? locateOnTripCalls(tripCalls, fix, scheduledNextIndex) : null;

  const nextIndex = location ? location.nextCallIndex : scheduledNextIndex;
  const passedCallCount = nextIndex < 0 ? tripCalls.length : nextIndex;
  const nextCall = nextIndex < 0 ? undefined : tripCalls[nextIndex];
  const nextCallInstant = getTripCallInstant(nextCall);
  const scheduledMinutes =
    nextCallInstant === undefined
      ? undefined
      : Math.max(0, Math.round((nextCallInstant - feedNow) / 60_000));
  const locatedMinutes = location
    ? getMinutesFromLinkProgress(tripCalls, location.nextCallIndex, location.linkProgress)
    : undefined;
  const minutesToNextCall = location ? (locatedMinutes ?? scheduledMinutes) : scheduledMinutes;

  const alightingIndex = alightingStopId
    ? tripCalls.findIndex((call) => call.localStopId === alightingStopId)
    : -1;
  const isAlightingPassed = alightingIndex >= 0 && alightingIndex < passedCallCount;
  const alightingCall =
    alightingIndex >= 0 && !isAlightingPassed ? tripCalls[alightingIndex] : undefined;

  return {
    // A located reading whose minutes had to come from the timetable is still a located reading:
    // which stop is next is the fact the rider reads first, and that one came from the fix.
    source: location ? "position" : "schedule",
    metersToNextCall: location?.metersToNextCall,
    nextCall,
    minutesToNextCall: nextCall ? minutesToNextCall : undefined,
    passedCallCount,
    alightingCall,
    stopsToAlighting: alightingCall ? alightingIndex - passedCallCount + 1 : undefined,
    isAlightingNext: Boolean(alightingCall) && alightingIndex === passedCallCount,
    isFinished: isAlightingPassed || nextIndex < 0,
    finalCall: isAlightingPassed
      ? tripCalls[alightingIndex]
      : nextIndex < 0
        ? tripCalls[tripCalls.length - 1]
        : undefined,
  };
}
