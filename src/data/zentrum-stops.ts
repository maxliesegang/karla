/** Area membership; stops and corridors appear only with observed rail service. */
export const zentrumStopIds: readonly string[] = [
  // The Kaiserstraße axis, west to east; one id per place (tunnel and street answer from either
  // id).
  "muehlburger-tor",
  "europaplatz",
  "marktplatz",
  "kronenplatz",
  "durlacher-tor",
  "gottesauer-platz",
  "tullastrasse",
  "wolfartsweierer-strasse",
  "schloss-gottesaue",
  "karl-wilhelm-platz",
  // The ring of squares inside it.
  "karlstor",
  "ettlinger-tor",
  "rueppurrer-tor",
  "ostendstrasse",
  "philipp-reis-strasse",
  // West and south-west. Both are closed for construction and answer with nothing; they stay listed
  // and return by themselves with service.
  "lessingstrasse",
  "otto-sachs-strasse",
  "arbeitsagentur",
  "mathystrasse",
  "konzerthaus",
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

/**
 * The posts that feed the list a rider sees; the network's reach posts describe the slower rest.
 * Measured worst case across six service patterns: 51% of stop-line pairs seen, 81% with the reach
 * posts; a fifth Zentrum post added nothing.
 */
export const ZENTRUM_OBSERVATION_POST_STOP_IDS = [
  "europaplatz",
  "karlstor",
  "hauptbahnhof",
  "albtalbahnhof",
] as const;
