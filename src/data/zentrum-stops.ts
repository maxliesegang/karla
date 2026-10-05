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
