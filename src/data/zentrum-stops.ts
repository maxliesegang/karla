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
 * The observation posts, in two tiers on two cadences: these Zentrum posts feed the list a rider
 * sees; the network's reach posts (`reachObservationPostStopIds`) describe the slower rest. Chosen
 * by measurement at six service patterns (Mon 08:00, 12:00, 17:00, Sat 18:00, Sun 11:00, Sun 03:00),
 * on the worst-case share of the network's stop-and-line pairs seen:
 *
 *     worst-case share of the network seen   stop*line   stops   lines
 *     the five Zentrum posts                     51%      57%     48%
 *     with the reach posts (nine)                81%      82%     78%
 *
 * The nine also see 85% of the Zentrum's own pairs against 65%. A fifth Zentrum post (Kronenplatz,
 * Ettlinger Tor) added nothing at the worst reading.
 */
export const ZENTRUM_OBSERVATION_POST_STOP_IDS = [
  "europaplatz",
  "karlstor",
  "hauptbahnhof",
  "albtalbahnhof",
] as const;
