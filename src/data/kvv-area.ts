/**
 * The KVV tariff area, as a bounding box drawn around it: Karlsruhe city and district, Rastatt,
 * Baden-Baden, Pforzheim and the Enzkreis, and the Südpfalz with Germersheim, Landau and the
 * Südliche Weinstraße. The operator's stop finder reads stops from the whole country, so a search
 * keeps what falls inside the box and leaves the rest of Germany to other apps.
 */
export const KVV_AREA_BOUNDS = {
  /** The Rastatt district's southern stops around Renchen and Achern stay in; the Ortenau beyond stays out. */
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
