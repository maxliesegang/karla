import type { TripCall } from "../data/transit-types";
import { getRidePosition, type RidePositionFix } from "./ride-position";
import { getTripCallInstant } from "./trip-calls";

/**
 * Where a ride has got to: the next stop, minutes to it, stops to the Ausstieg. A call is past once
 * the vehicle is due to have left it, as in the line diagram. Where the rider's position is placed,
 * it decides the next call and remaining distance; the timetable turns that into minutes. Otherwise
 * the feed's schedule decides, and `source` says which.
 */

export type RideProgress = {
  /** Which source this reading came from. */
  source: "position" | "schedule";
  /** Metres to the next call, where the position placed the vehicle. */
  metersToNextCall?: number;
  /** The call ahead; none once the last is behind. */
  nextCall?: TripCall;
  /** Minutes until that call, from the feed's clock. */
  minutesToNextCall?: number;
  /** Calls already made. */
  passedCallCount: number;
  /** The Ausstieg, while still ahead. */
  alightingCall?: TripCall;
  /** Calls before the Ausstieg, the next one included. */
  stopsToAlighting?: number;
  /** The Ausstieg is next: time to stand up. */
  isAlightingNext: boolean;
  /** The Ausstieg is behind, or the trip has made its last call. */
  isFinished: boolean;
  /** Where the ride ended. */
  finalCall?: TripCall;
};

/**
 * Minutes to the next call: the remaining share of the link at the timetable's pace; none untimed.
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

/** A ride's options besides its calls. */
export type RideProgressOptions = {
  /** The rider's Ausstieg. */
  alightingStopId?: string;
  /** The rider's position, where granted and fresh. */
  fix?: RidePositionFix;
};

export function getRideProgress(
  tripCalls: readonly TripCall[],
  feedNow: number,
  { alightingStopId, fix }: RideProgressOptions = {},
): RideProgress {
  // An untimed call is neither past nor ahead.
  const isPast = (call: TripCall) => {
    const instant = getTripCallInstant(call);
    return instant !== undefined && feedNow > instant;
  };

  const scheduledNextIndex = tripCalls.findIndex((call) => !isPast(call));
  // A fix cannot extend a ride past its last call.
  const position =
    fix && scheduledNextIndex >= 0 ? getRidePosition(tripCalls, fix, scheduledNextIndex) : null;

  const nextIndex = position ? position.nextCallIndex : scheduledNextIndex;
  const passedCallCount = nextIndex < 0 ? tripCalls.length : nextIndex;
  const nextCall = nextIndex < 0 ? undefined : tripCalls[nextIndex];
  const nextCallInstant = getTripCallInstant(nextCall);
  const scheduledMinutes =
    nextCallInstant === undefined
      ? undefined
      : Math.max(0, Math.round((nextCallInstant - feedNow) / 60_000));
  const positionedMinutes = position
    ? getMinutesFromLinkProgress(tripCalls, position.nextCallIndex, position.linkProgress)
    : undefined;
  const minutesToNextCall = position ? (positionedMinutes ?? scheduledMinutes) : scheduledMinutes;

  const alightingIndex = alightingStopId
    ? tripCalls.findIndex((call) => call.localStopId === alightingStopId)
    : -1;
  const isAlightingPassed = alightingIndex >= 0 && alightingIndex < passedCallCount;
  const alightingCall =
    alightingIndex >= 0 && !isAlightingPassed ? tripCalls[alightingIndex] : undefined;

  return {
    // The next stop came from the fix, even if the minutes came from the timetable.
    source: position ? "position" : "schedule",
    metersToNextCall: position?.metersToNextCall,
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
