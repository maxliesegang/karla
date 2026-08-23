import type { TripCall } from "../data/transit-types";

/**
 * The municipality a stop name belongs to, and whether a view has to say it.
 *
 * The feed states a calling point twice: the local name (`Bahnhof`, `Rathaus`, `Schloss`) and the
 * municipality it is in. Inside the municipality a rider is reading from, the local name is the one
 * on the sign and the qualifier is noise. One stop further out it is the whole of the meaning —
 * `Bahnhof` alone is every second town on the line.
 */

/**
 * The name a rider says, once the operator's parenthetical aside is off it.
 *
 * One function because the operator has one convention, and it says the same thing about a place
 * and about a stop point: `Forchheim (b Karlsr)` is the place `Forchheim`, told apart from the
 * other Forchheims, and `Marktplatz (Kaiserstraße U)` is one platform of `Marktplatz`, told apart
 * from the other platform. What is inside the brackets is which one; what is outside it is what
 * the stop is called.
 */
export const getBaseName = (name: string): string => name.replace(/\s*\(.*$/, "").trim();

/**
 * The municipality the diagram is read from, whose stops need no qualifier. The rider's own stop
 * states it; a trip read on its own names no stop, so the municipality most of its calls are in
 * stands in — on a KVV trip that is the city the line runs through, which is the same answer.
 */
export function findHomePlaceName(tripCalls: readonly TripCall[]): string | undefined {
  const currentCall = tripCalls.find(({ isCurrentStop }) => isCurrentStop);
  if (currentCall?.placeName) return getBaseName(currentCall.placeName);

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
 * What a view has to add to a stop name for it to name one place, or `undefined` when the name
 * already does. Nothing is added where the feed's own name carries the municipality already
 * (`Durmersheim Nord`, `Karlsruhe Albtalbahnhof`), so no stop reads as its town twice.
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
