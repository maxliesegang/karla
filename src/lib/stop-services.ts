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

/** Every name a stop goes by. */
const getStopNameVariants = (stop: TransitStop): string[] =>
  [stop.name, stop.alias].filter((name): name is string => Boolean(name));

/**
 * Resolves a call's stop name to a local stop, also by base name, since a call names its platform
 * (`Marktplatz (Kaiserstraße U)`). The fallback where the provider id did not resolve.
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

/** Whether two departures share direction and route pattern. */
export function hasCompatibleStopPattern(first: Departure, second: Departure): boolean {
  if (!isSameLineFamily(first.lineId, second.lineId)) return false;
  if (first.destination !== second.destination) return false;

  const firstCalls = getCallsAfterCurrentStop(first);
  const secondCalls = getCallsAfterCurrentStop(second);
  // A basic board cannot show a branch difference; destination is the best evidence.
  if (firstCalls.length === 0 || secondCalls.length === 0) return true;
  return getCallSequenceKey(firstCalls) === getCallSequenceKey(secondCalls);
}

/** The next running trip on the same observed route. */
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

/** The line's ends as seen from one stop; one where it only leaves one way. */
export function getLineTermini(line: TransitLine): string[] {
  if (line.farthestRunTermini?.length) return [...line.farthestRunTermini];
  return [...new Set(line.destinations)].slice(0, 2);
}

/** The farthest run observed for a line, by distinct calls, so a whole run beats short workings. */
function findFarthestLineRunCalls(
  lineId: string,
  departures: readonly Pick<Departure, "lineId" | "tripCalls">[],
): readonly TripCall[] | undefined {
  let farthestCalls: readonly TripCall[] | undefined;
  let farthestReach = 0;
  for (const departure of departures) {
    if (!isSameLineFamily(departure.lineId, lineId) || !departure.tripCalls?.length) continue;
    const reach = new Set(departure.tripCalls.map(getCallKey)).size;
    if (reach > farthestReach) {
      farthestCalls = departure.tripCalls;
      farthestReach = reach;
    }
  }
  return farthestCalls;
}

/** A run's ends, qualified for a compact heading. */
function getRunTermini(calls: readonly TripCall[]): {
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
 * The line's ends at its farthest observed run, for the line list. `undefined` where none reached
 * far enough or it loops; the destinations then stand in.
 */
export function getFarthestLineRunTermini(
  lineId: string,
  departures: readonly Pick<Departure, "lineId" | "tripCalls">[],
): readonly string[] | undefined {
  const calls = findFarthestLineRunCalls(lineId, departures);
  if (!calls || calls.length < 2) return undefined;
  const { firstTerminus, lastTerminus } = getRunTermini(calls);
  return firstTerminus === lastTerminus ? undefined : [firstTerminus, lastTerminus];
}

/** The farthest run observed for a line. */
export type FarthestLineRun = {
  firstTerminus: string;
  lastTerminus: string;
  /** Its calls, oriented like the diagram; `undefined` where none reached far enough. */
  calls: readonly TripCall[] | undefined;
};

/**
 * The farthest complete run observed for a line, oriented like the diagram, so a view first drawn
 * from a short working can show the whole line.
 */
export function getFarthestLineRun(
  line: TransitLine,
  departures: readonly Departure[],
  diagramCalls: readonly TripCall[],
): FarthestLineRun {
  const farthestCalls = findFarthestLineRunCalls(line.id, departures);

  if (!farthestCalls || farthestCalls.length < 2) {
    const [firstTerminus, lastTerminus] = getLineTermini(line);
    return { firstTerminus, lastTerminus, calls: undefined };
  }
  const first = farthestCalls[0];
  const last = farthestCalls[farthestCalls.length - 1];
  const indexByKey = new Map(farthestCalls.map((call, index) => [getCallKey(call), index]));
  const diagramIndices = diagramCalls.flatMap((call) => {
    const index = indexByKey.get(getCallKey(call));
    return index === undefined ? [] : [index];
  });
  const firstDiagramIndex = diagramIndices[0];
  const nextDiagramIndex = diagramIndices.find((index) => index !== firstDiagramIndex);

  // Rows run destination to origin; two shared calls decide which end is on top.
  const runsTowardStart =
    firstDiagramIndex !== undefined && nextDiagramIndex !== undefined
      ? nextDiagramIndex > firstDiagramIndex
      : getCallKey(diagramCalls[0] ?? last) === getCallKey(first);
  const calls = runsTowardStart ? farthestCalls : [...farthestCalls].reverse();
  return { ...getRunTermini(calls), calls };
}
