import type { Call, StopPlace } from "../data/transit-types";

/**
 * Stop names and their municipality. Inside the rider's municipality the qualifier is noise;
 * outside it, `Bahnhof` alone could be any town.
 */

/**
 * The name without the operator's bracketed aside, which says which one: `Forchheim (b Karlsr)` is
 * `Forchheim`, `Marktplatz (Kaiserstraße U)` is a bay of `Marktplatz`.
 */
export const getBaseName = (name: string): string => name.replace(/\s*\(.*$/, "").trim();

/**
 * The diagram's home municipality: the rider's stop's, else the one most calls are in. Asked by
 * stop, since the current-stop marker may come from another stop's reading.
 */
export function findHomePlaceName(
  calls: readonly Call[],
  riderStopId?: string,
): string | undefined {
  const riderCall = riderStopId
    ? calls.find(({ stopPlaceId, placeName }) => stopPlaceId === riderStopId && placeName)
    : undefined;
  if (riderCall?.placeName) return getBaseName(riderCall.placeName);

  const callCountByPlaceName = new Map<string, number>();
  for (const { placeName } of calls) {
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
  { stopName, placeName }: Pick<Call, "stopName" | "placeName">,
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
  call: Pick<Call, "stopName" | "placeName">,
  homePlaceName: string | undefined,
): string {
  const qualifier = getStopPlaceQualifier(call, homePlaceName);
  return qualifier ? `${qualifier} ${call.stopName}` : call.stopName;
}

/**
 * Where a stop is, as said beside its name (`Karlsruhe`, `Karlsruhe-Durlach`, `Pforzheim`); nothing
 * where the name already says the town (`Karlsruhe Westbahnhof`).
 */
function getStopPlaceTown({ name, placeName, municipality }: StopPlace): string | undefined {
  const town = municipality ?? placeName;
  if (!town) return undefined;
  const district = municipality && placeName;
  if (name.toLowerCase().includes(town.toLowerCase())) return district || undefined;
  return district ? `${municipality}-${placeName}` : town;
}

/** What is printed under a stop's name: its town and district, its former name. */
export const getStopPlaceSubtitle = (stop: StopPlace): string | undefined =>
  [getStopPlaceTown(stop), stop.formerName].filter(Boolean).join(" · ") || undefined;
