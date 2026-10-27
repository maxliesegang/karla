import type { Call } from "../data/transit-types";
import { getRidePosition, type RidePositionFix } from "./ride-position";
import { getCallInstant } from "./calls";

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
  nextCall?: Call;
  /** Minutes until that call, from the feed's clock. */
  minutesToNextCall?: number;
  /** Calls already made. */
  passedCallCount: number;
  /** The Ausstieg, while still ahead. */
  alightingCall?: Call;
  /** Calls before the Ausstieg, the next one included. */
  stopsToAlighting?: number;
  /** The Ausstieg is next: time to stand up. */
  isAlightingNext: boolean;
  /** The Ausstieg is behind, or the journey has made its last call. */
  isFinished: boolean;
  /** Where the ride ended. */
  finalCall?: Call;
};

/**
 * Minutes to the next call: the remaining share of the link at the timetable's pace; none untimed.
 */
function getMinutesFromLinkProgress(
  calls: readonly Call[],
  nextCallIndex: number,
  linkProgress: number,
): number | undefined {
  const departure = getCallInstant(calls[nextCallIndex - 1], "departure");
  const arrival = getCallInstant(calls[nextCallIndex], "arrival");
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
  calls: readonly Call[],
  feedNow: number,
  { alightingStopId, fix }: RideProgressOptions = {},
): RideProgress {
  // An untimed call is neither past nor ahead.
  const isPast = (call: Call) => {
    const instant = getCallInstant(call);
    return instant !== undefined && feedNow > instant;
  };

  const timetabledNextIndex = calls.findIndex((call) => !isPast(call));
  // A fix cannot extend a ride past its last call.
  const position =
    fix && timetabledNextIndex >= 0 ? getRidePosition(calls, fix, timetabledNextIndex) : null;

  const nextIndex = position ? position.nextCallIndex : timetabledNextIndex;
  const passedCallCount = nextIndex < 0 ? calls.length : nextIndex;
  const nextCall = nextIndex < 0 ? undefined : calls[nextIndex];
  const nextCallInstant = getCallInstant(nextCall);
  const timetabledMinutes =
    nextCallInstant === undefined
      ? undefined
      : Math.max(0, Math.round((nextCallInstant - feedNow) / 60_000));
  const positionedMinutes = position
    ? getMinutesFromLinkProgress(calls, position.nextCallIndex, position.linkProgress)
    : undefined;
  const minutesToNextCall = position ? (positionedMinutes ?? timetabledMinutes) : timetabledMinutes;

  const alightingIndex = alightingStopId
    ? calls.findIndex((call) => call.stopPlaceId === alightingStopId)
    : -1;
  const isAlightingPassed = alightingIndex >= 0 && alightingIndex < passedCallCount;
  const alightingCall =
    alightingIndex >= 0 && !isAlightingPassed ? calls[alightingIndex] : undefined;

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
      ? calls[alightingIndex]
      : nextIndex < 0
        ? calls[calls.length - 1]
        : undefined,
  };
}
