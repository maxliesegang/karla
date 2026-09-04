import type {
  Departure,
  TransitLine,
  TransitNetwork,
  TransitStop,
  TripCall,
} from "../data/transit-types";
import { createStopSlug } from "./stop-slug";
import { findHomePlaceName, getBaseName, getQualifiedStopName } from "./stop-naming";
import { isSameLineFamily } from "./line-families";
import { getCallKey, getCallSequenceKey, getCallsAfterCurrentStop } from "./trip-calls";

/** Every name a stop goes by, for matching a name the feed states against our own stops. */
const getStopNameVariants = (stop: TransitStop): string[] =>
  [stop.name, stop.alias].filter((name): name is string => Boolean(name));

/**
 * Resolves a stop name from a trip call to a supported local stop, without leaking name-derived ids
 * into views.
 *
 * Matched on the base name as well as the one the feed stated, because the two are not the same
 * string: a local stop is the place (`Marktplatz`), and a call names the platform it is made at
 * (`Marktplatz (Kaiserstraße U)`). This is the fallback for a call the provider id did not resolve,
 * so the name is all there is to go on.
 */
export function findStopByName(network: TransitNetwork, name: string): TransitStop | undefined {
  const baseName = getBaseName(name);
  const slugs = new Set([createStopSlug(name), createStopSlug(baseName)]);
  return network.stops.find(
    (stop) =>
      slugs.has(stop.id) ||
      getStopNameVariants(stop).some((variant) => variant === name || variant === baseName),
  );
}

/** Whether two observed departures are interchangeable as the same direction and route pattern. */
export function hasCompatibleStopPattern(first: Departure, second: Departure): boolean {
  if (!isSameLineFamily(first.lineId, second.lineId)) return false;
  if (first.destination !== second.destination) return false;

  const firstCalls = getCallsAfterCurrentStop(first);
  const secondCalls = getCallsAfterCurrentStop(second);
  // A basic board cannot prove a branch difference. Destination is the narrowest available fact.
  if (firstCalls.length === 0 || secondCalls.length === 0) return true;
  return getCallSequenceKey(firstCalls) === getCallSequenceKey(secondCalls);
}

/** The next non-cancelled trip that offers the same observed route after this departure. */
export function findNextCompatibleDeparture(
  departures: readonly Departure[],
  departure: Departure,
): Departure | undefined {
  const currentIndex = departures.indexOf(departure);
  if (currentIndex < 0) return undefined;
  return departures
    .slice(currentIndex + 1)
    .find(
      (candidate) =>
        candidate.status !== "cancelled" && hasCompatibleStopPattern(departure, candidate),
    );
}

/** The two ends a line runs between as seen from one stop, or one end where it only leaves one way. */
export function getLineTermini(line: TransitLine): string[] {
  return [...new Set(line.destinations)].slice(0, 2);
}

/** The furthest run observed for a line, as a whole-line reading of it needs it. */
export type FarthestLineRun = {
  firstTerminus: string;
  lastTerminus: string;
  /**
   * The run's calls, oriented like the diagram on screen — the chain a whole-line view is drawn
   * out to. `undefined` where no run has been observed far enough to draw, which leaves the view
   * with the chain it was drawn from and the ends the line's destinations name.
   */
  calls: readonly TripCall[] | undefined;
};

/**
 * The furthest complete run observed for a line, oriented like the diagram on screen.
 *
 * A line view is often first drawn from a short working because that is the next trip at the
 * rider's stop. That trip is a truthful shape for its own run, but its ends are not the ends of the
 * whole line. The other line boards are already in hand to place vehicles; their longest distinct
 * call sequence is both the best observation of how far the line reaches and the shape that reach
 * is drawn in.
 */
export function getFarthestLineRun(
  line: TransitLine,
  departures: readonly Departure[],
  diagramCalls: readonly TripCall[],
): FarthestLineRun {
  let furthestCalls: readonly TripCall[] | undefined;
  let furthestReach = 0;
  for (const departure of departures) {
    if (!isSameLineFamily(departure.lineId, line.id) || !departure.tripCalls?.length) continue;
    const reach = new Set(departure.tripCalls.map(getCallKey)).size;
    if (reach > furthestReach) {
      furthestCalls = departure.tripCalls;
      furthestReach = reach;
    }
  }

  if (!furthestCalls || furthestCalls.length < 2) {
    const [firstTerminus, lastTerminus] = getLineTermini(line);
    return { firstTerminus, lastTerminus, calls: undefined };
  }
  const first = furthestCalls[0];
  const last = furthestCalls[furthestCalls.length - 1];
  const indexByKey = new Map(furthestCalls.map((call, index) => [getCallKey(call), index]));
  const diagramIndices = diagramCalls.flatMap((call) => {
    const index = indexByKey.get(getCallKey(call));
    return index === undefined ? [] : [index];
  });
  const firstDiagramIndex = diagramIndices[0];
  const nextDiagramIndex = diagramIndices.find((index) => index !== firstDiagramIndex);

  // Diagram rows run from destination back toward origin. Two shared calls say which physical end
  // belongs at its top even when the furthest observation came from a trip in the other direction.
  const runsTowardStart =
    firstDiagramIndex !== undefined && nextDiagramIndex !== undefined
      ? nextDiagramIndex > firstDiagramIndex
      : getCallKey(diagramCalls[0] ?? last) === getCallKey(first);
  const calls = runsTowardStart ? furthestCalls : [...furthestCalls].reverse();
  const homePlaceName = findHomePlaceName(calls);
  return {
    // Rows can state a stop's locality on a separate line, but this compact heading cannot. Fold
    // it into an end whose bare stop name does not identify the place: KVV calls line 2's western
    // end plain `Nord` inside `Knielingen`, for example, so the title must read `Knielingen Nord`.
    firstTerminus: getQualifiedStopName(calls[0], homePlaceName),
    lastTerminus: getQualifiedStopName(calls[calls.length - 1], homePlaceName),
    calls,
  };
}
