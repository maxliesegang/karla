/**
 * Which stops count as the Zentrum: a judgement about the city, written down (a rectangle swept in
 * Schillerstraße and Sophienstraße). Membership only; lines and service are observed live, so a
 * listed stop with no service is not shown. Edges: Mühlburger Tor (west), Albtalbahnhof (south),
 * Karl-Wilhelm-Platz, Gottesauer Platz and Ostendstraße (east).
 */
export const zentrumStopIds: readonly string[] = [
  // The Kaiserstraße axis, west to east; one id per place (tunnel and street answer from either
  // id).
  "muehlburger-tor",
  "europaplatz",
  "marktplatz",
  "kronenplatz",
  "durlacher-tor",
  "gottesauer-platz",
  "karl-wilhelm-platz",
  // The ring of squares inside it.
  "karlstor",
  "ettlinger-tor",
  "rueppurrer-tor",
  "ostendstrasse",
  // West and south-west. Both are closed for construction and answer with nothing; they stay listed
  // and return by themselves with service.
  "lessingstrasse",
  "otto-sachs-strasse",
  "arbeitsagentur",
  "mathystrasse",
  "zkm",
  "welfenstrasse",
  "barbarossaplatz",
  "kolpingplatz",
  // The southern corridor to the stations.
  "kongresszentrum",
  "augartenstrasse",
  "werderstrasse",
  "tivoli",
  "poststrasse",
  "ebertstrasse",
  "hauptbahnhof",
  "albtalbahnhof",
];

const zentrumStopIdSet = new Set(zentrumStopIds);

export function isZentrumStop(stopId: string | undefined): boolean {
  return stopId !== undefined && zentrumStopIdSet.has(stopId);
}
