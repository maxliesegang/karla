import type { Departure, TransitLine, TransitStop, TransitNetwork } from "../data/transit-types";
import { createStopSlug } from "./stop-slug";
import { getBaseName } from "./stop-naming";
import { isSameLineFamily } from "./line-families";
import { getCallSequenceKey, getCallsAfterCurrentStop } from "./trip-calls";

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
