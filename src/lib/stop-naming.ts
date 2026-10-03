import type { TripCall } from "../data/transit-types";

/**
 * Stop names and their municipality. Inside the rider's municipality the qualifier is noise;
 * outside it, `Bahnhof` alone could be any town.
 */

/**
 * The name without the operator's bracketed aside, which says which one: `Forchheim (b Karlsr)` is
 * `Forchheim`, `Marktplatz (Kaiserstraße U)` is a platform of `Marktplatz`.
 */
export const getBaseName = (name: string): string => name.replace(/\s*\(.*$/, "").trim();

/**
 * The diagram's home municipality: the rider's stop's, else the one most calls are in. Asked by
 * stop, since the current-stop marker may come from another stop's reading.
 */
export function findHomePlaceName(
  tripCalls: readonly TripCall[],
  riderStopId?: string,
): string | undefined {
  const riderCall = riderStopId
    ? tripCalls.find(({ localStopId, placeName }) => localStopId === riderStopId && placeName)
    : undefined;
  if (riderCall?.placeName) return getBaseName(riderCall.placeName);

  const callCountByPlaceName = new Map<string, number>();
  for (const { placeName } of tripCalls) {
    if (!placeName) continue;
    const basePlaceName = getBaseName(placeName);
    callCountByPlaceName.set(basePlaceName, (callCountByPlaceName.get(basePlaceName) ?? 0) + 1);
  }

  return [...callCountByPlaceName.entries()].sort(
    ([, first], [, second]) => second - first,
  )[0]?.[0];
}

/**
 * What to add to a stop name to make it unique, or `undefined`; nothing where it already names the
 * town.
 */
export function getStopPlaceQualifier(
  { stopName, placeName }: Pick<TripCall, "stopName" | "placeName">,
  homePlaceName: string | undefined,
): string | undefined {
  if (!placeName) return undefined;
  const basePlaceName = getBaseName(placeName);
  if (!basePlaceName || basePlaceName === homePlaceName) return undefined;
  if (stopName.toLowerCase().includes(basePlaceName.toLowerCase())) return undefined;
  return basePlaceName;
}

/** A stop's full name where its place cannot be shown beside it. */
export function getQualifiedStopName(
  call: Pick<TripCall, "stopName" | "placeName">,
  homePlaceName: string | undefined,
): string {
  const qualifier = getStopPlaceQualifier(call, homePlaceName);
  return qualifier ? `${qualifier} ${call.stopName}` : call.stopName;
}
