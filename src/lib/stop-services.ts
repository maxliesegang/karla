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
  if (line.farthestRunTermini?.length) return [...line.farthestRunTermini];
  return [...new Set(line.destinations)].slice(0, 2);
}

/**
 * The farthest run observed for one line among these departures, as its calls.
 *
 * Reach is the run's own length — the number of distinct calls — which is what makes a whole run
 * beat the short workings beside it, whatever order the boards were read in.
 */
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

/** The ends of one run, qualified the way a compact heading has to state them. */
function getRunTermini(calls: readonly TripCall[]): {
  firstTerminus: string;
  lastTerminus: string;
} {
  // Rows can state a stop's locality on a separate line, but a heading cannot. Fold it into an end
  // whose bare stop name does not identify the place: KVV calls line 2's western end plain `Nord`
  // inside `Knielingen`, for example, so the heading must read `Knielingen Nord`.
  const homePlaceName = findHomePlaceName(calls);
  return {
    firstTerminus: getQualifiedStopName(calls[0], homePlaceName),
    lastTerminus: getQualifiedStopName(calls[calls.length - 1], homePlaceName),
  };
}

/**
 * The two ends the line was seen running between at its farthest, as a line list reads them.
 *
 * The same observation `getFarthestLineRun` draws a whole-line view out of, read once for the
 * list instead of per view: the farthest run observed for the line states where it actually runs,
 * where its destinations — the words on the vehicle's front, with the short workings among them —
 * only suggest it. `undefined` where no run was observed far enough, and where the farthest run
 * turns on itself: a loop's two ends are one place, and the line's destinations still say which
 * one it serves.
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

/** The farthest run observed for a line, as a whole-line reading of it needs it. */
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
 * The farthest complete run observed for a line, oriented like the diagram on screen.
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

  // Diagram rows run from destination back toward origin. Two shared calls say which physical end
  // belongs at its top even when the farthest observation came from a trip in the other direction.
  const runsTowardStart =
    firstDiagramIndex !== undefined && nextDiagramIndex !== undefined
      ? nextDiagramIndex > firstDiagramIndex
      : getCallKey(diagramCalls[0] ?? last) === getCallKey(first);
  const calls = runsTowardStart ? farthestCalls : [...farthestCalls].reverse();
  return { ...getRunTermini(calls), calls };
}
