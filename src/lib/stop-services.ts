import type {
  StopEvent,
  TransitLine,
  TransitNetwork,
  StopPlace,
  Call,
} from "../data/transit-types";
import { createStopSlug } from "./stop-slug";
import { findHomePlaceName, getBaseName, getQualifiedStopName } from "./stop-naming";
import { isRowOfLine, isSameLine } from "./line-identity";
import { getCallKey, getCallSequenceKey, getCallsAfterCurrentStop, runsInOrderOf } from "./calls";

/** Every name a stop goes by. */
const getStopNameVariants = (stop: StopPlace): string[] =>
  [stop.name, stop.formerName].filter((name): name is string => Boolean(name));

/**
 * Resolves a call's stop name to a stop place, also by base name, since a call names its bay
 * (`Marktplatz (Kaiserstraße U)`). The fallback where the stop point did not resolve.
 */
export function findStopByName(network: TransitNetwork, name: string): StopPlace | undefined {
  const baseName = getBaseName(name);
  const slugs = new Set([createStopSlug(name), createStopSlug(baseName)]);
  return network.stops.find(
    (stop) =>
      slugs.has(stop.id) ||
      getStopNameVariants(stop).some((variant) => variant === name || variant === baseName),
  );
}

/** Whether two departures share direction and route pattern. */
export function hasCompatibleStopPattern(first: StopEvent, second: StopEvent): boolean {
  if (!isSameLine(first, second)) return false;
  if (first.destinationText !== second.destinationText) return false;

  const firstCalls = getCallsAfterCurrentStop(first);
  const secondCalls = getCallsAfterCurrentStop(second);
  // A basic board cannot show a branch difference; destination is the best evidence.
  if (firstCalls.length === 0 || secondCalls.length === 0) return true;
  return getCallSequenceKey(firstCalls) === getCallSequenceKey(secondCalls);
}

/** The next running journey on the same observed route. */
export function findNextCompatibleStopEvent(
  stopEvents: readonly StopEvent[],
  stopEvent: StopEvent,
): StopEvent | undefined {
  const currentIndex = stopEvents.indexOf(stopEvent);
  if (currentIndex < 0) return undefined;
  return stopEvents
    .slice(currentIndex + 1)
    .find(
      (candidate) =>
        candidate.status !== "cancelled" && hasCompatibleStopPattern(stopEvent, candidate),
    );
}

/** The line's ends as seen from one stop; one where it only leaves one way. */
export function getLineTermini(line: TransitLine): string[] {
  if (line.farthestDatedJourneyTermini?.length) return [...line.farthestDatedJourneyTermini];
  return [...new Set(line.destinations)].slice(0, 2);
}

/**
 * The farthest dated journey observed for a line, by distinct calls, so a whole dated journey beats
 * short workings.
 */
function findFarthestLineDatedJourneyCalls(
  lineId: string,
  stopEvents: readonly Pick<StopEvent, "lineId" | "lineRef" | "calls">[],
  identity?: string,
): readonly Call[] | undefined {
  let farthestCalls: readonly Call[] | undefined;
  let farthestReach = 0;
  for (const stopEvent of stopEvents) {
    if (!isRowOfLine(stopEvent, lineId, identity) || !stopEvent.calls?.length) continue;
    const reach = new Set(stopEvent.calls.map(getCallKey)).size;
    if (reach > farthestReach) {
      farthestCalls = stopEvent.calls;
      farthestReach = reach;
    }
  }
  return farthestCalls;
}

/** A dated journey's ends, qualified for a compact heading. */
function getDatedJourneyTermini(calls: readonly Call[]): {
  firstTerminus: string;
  lastTerminus: string;
} {
  // Headings fold in the locality where the bare name is ambiguous (line 2's `Nord` in
  // `Knielingen`).
  const homePlaceName = findHomePlaceName(calls);
  return {
    firstTerminus: getQualifiedStopName(calls[0], homePlaceName),
    lastTerminus: getQualifiedStopName(calls[calls.length - 1], homePlaceName),
  };
}

/**
 * The line's ends at its farthest observed dated journey, for the line list. `undefined` where none
 * reached far enough or it loops; the destinations then stand in.
 */
export function getFarthestLineDatedJourneyTermini(
  lineId: string,
  stopEvents: readonly Pick<StopEvent, "lineId" | "lineRef" | "calls">[],
): readonly string[] | undefined {
  const calls = findFarthestLineDatedJourneyCalls(lineId, stopEvents);
  if (!calls || calls.length < 2) return undefined;
  const { firstTerminus, lastTerminus } = getDatedJourneyTermini(calls);
  return firstTerminus === lastTerminus ? undefined : [firstTerminus, lastTerminus];
}

/** The farthest dated journey observed for a line. */
export type FarthestLineDatedJourney = {
  firstTerminus: string;
  lastTerminus: string;
  /** Its calls, oriented like the diagram; `undefined` where none reached far enough. */
  calls: readonly Call[] | undefined;
};

/**
 * The farthest complete dated journey observed for a line, oriented like the diagram, so a view
 * first drawn from a short working can show the whole line.
 */
export function getFarthestLineDatedJourney(
  line: TransitLine,
  stopEvents: readonly StopEvent[],
  diagramCalls: readonly Call[],
): FarthestLineDatedJourney {
  const farthestCalls = findFarthestLineDatedJourneyCalls(line.id, stopEvents, line.identity);

  if (!farthestCalls || farthestCalls.length < 2) {
    const [firstTerminus, lastTerminus] = getLineTermini(line);
    return { firstTerminus, lastTerminus, calls: undefined };
  }
  const first = farthestCalls[0];
  const last = farthestCalls[farthestCalls.length - 1];
  // Rows run destination to origin; two shared calls decide which end is on top.
  const runsTowardStart =
    runsInOrderOf(farthestCalls, diagramCalls) ??
    getCallKey(diagramCalls[0] ?? last) === getCallKey(first);
  const calls = runsTowardStart ? farthestCalls : [...farthestCalls].reverse();
  return { ...getDatedJourneyTermini(calls), calls };
}
