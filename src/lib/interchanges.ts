import type {
  DepartureBoard,
  TransitLine,
  TransitNetwork,
  TransportMode,
} from "../data/transit-types";
import { getLineSign } from "../data/line-signs";
import {
  compareLineIds,
  getGroupedLines,
  getLineFamilyId,
  isSameLineFamily,
} from "./line-families";
import { createStopSlug } from "./stop-slug";
import { getDistinctTimetableTrips } from "./trips";

/**
 * Which lines a rider can change to at a stop.
 *
 * Read from the trips themselves rather than from where a line happens to end: every departure the
 * feed answers carries its whole chain of calling points, so a trip of line 4 states every stop
 * line 4 calls at. Collected across the boards in hand, those chains say which lines meet where —
 * including in the middle of a route, which the ends of a line can never say.
 *
 * Nothing here is authored. Two platforms of one place are one stop — the provider answers both
 * levels from either id, so a change between them is a change at the stop, not a walk to another.
 *
 * The index only knows the lines whose trips the boards in hand happened to show. A line that never
 * passes an observation post is not offered as a change — the same rule the rest of the app follows:
 * unobserved is not shown.
 */

/** A line seen calling at a stop, carrying enough to render its sign without a further lookup. */
type ObservedCallingLine = { familyId: string; transportMode: TransportMode };

/** Line families seen calling at a stop, keyed by every id that stop is addressed by. */
export type InterchangeIndex = ReadonlyMap<string, readonly ObservedCallingLine[]>;

const EMPTY_CALLING_LINES: readonly ObservedCallingLine[] = [];

/**
 * A call is addressed by the local stop id where the provider stop resolves to one, and always by
 * the slug of the name it states — which is the id a line diagram row falls back to.
 */
function getCallStopKeys(stopName: string, localStopId: string | undefined): string[] {
  const slug = createStopSlug(stopName);
  return localStopId && localStopId !== slug ? [localStopId, slug] : [slug];
}

export function buildInterchangeIndex(boards: readonly DepartureBoard[]): InterchangeIndex {
  const callingLinesByStopKey = new Map<string, ObservedCallingLine[]>();

  for (const trip of getDistinctTimetableTrips(boards)) {
    const callingLine: ObservedCallingLine = {
      familyId: getLineFamilyId(trip.lineId),
      transportMode: trip.transportMode,
    };

    for (const call of trip.tripCalls ?? []) {
      for (const stopKey of getCallStopKeys(call.stopName, call.localStopId)) {
        const callingLines = callingLinesByStopKey.get(stopKey);
        if (!callingLines) callingLinesByStopKey.set(stopKey, [callingLine]);
        else if (!callingLines.some((seen) => seen.familyId === callingLine.familyId))
          callingLines.push(callingLine);
      }
    }
  }

  // Trams before Stadtbahnen and then by number: the order a rider reads them on a KVV sign, and
  // the order the rest of the app lists lines in.
  for (const callingLines of callingLinesByStopKey.values()) {
    callingLines.sort((a, b) => compareLineIds(a.familyId, b.familyId));
  }

  return callingLinesByStopKey;
}

/**
 * The changes available at one stop of a line diagram: the lines calling there, less the line being
 * viewed, which is never a change from itself.
 */
export function getInterchangesAtStop(
  index: InterchangeIndex,
  network: TransitNetwork,
  stop: { id: string; name: string },
  viewedLineId: string,
): readonly TransitLine[] {
  const lines = getGroupedLines(network.lines);
  const callingLines = getCallStopKeys(stop.name, stop.id).flatMap(
    (stopKey) => index.get(stopKey) ?? EMPTY_CALLING_LINES,
  );

  const interchanges: TransitLine[] = [];
  for (const callingLine of callingLines) {
    if (isSameLineFamily(callingLine.familyId, viewedLineId)) continue;
    if (interchanges.some((line) => line.id === callingLine.familyId)) continue;
    interchanges.push(getLineSign(lines, callingLine.familyId, callingLine.transportMode));
  }

  return interchanges;
}
