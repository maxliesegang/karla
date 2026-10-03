/**
 * A bounding box around the KVV tariff area (Karlsruhe, Rastatt, Baden-Baden, Pforzheim, Enzkreis,
 * Südpfalz). The stop finder searches all of Germany, so results outside are dropped.
 */
const KVV_AREA_BOUNDS = {
  /** Renchen and Achern in; the Ortenau beyond out. */
  south: 48.55,
  /** Lingenfeld in the Germersheim district stays in; Speyer, already VRN, stays out. */
  north: 49.28,
  /** Dahn in the Südliche Weinstraße stays in; Pirmasens stays out. */
  west: 7.75,
  /** Mühlacker at the Enzkreis edge stays in; Stuttgart stays out. */
  east: 8.9,
} as const;

export function isWithinKvvArea(latitude: number, longitude: number): boolean {
  return (
    latitude >= KVV_AREA_BOUNDS.south &&
    latitude <= KVV_AREA_BOUNDS.north &&
    longitude >= KVV_AREA_BOUNDS.west &&
    longitude <= KVV_AREA_BOUNDS.east
  );
}
