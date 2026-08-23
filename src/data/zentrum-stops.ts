/**
 * Which stops count as the Zentrum.
 *
 * This replaced a rectangle on the ground. A rectangle was the smaller decision, but the Zentrum is
 * not a rectangle: sweeping a box wide enough to reach Karl-Wilhelm-Platz in the east also swept in
 * Schillerstraße and Sophienstraße in the west, which no rider counts as the middle of Karlsruhe.
 * Where the Zentrum ends is a judgement about the city, so it is written down as one.
 *
 * Membership is the *only* thing it decides. Which lines run and where they call is still read from
 * live trips — a line that stops running leaves the view by itself, and a stop listed here that
 * nothing calls at is simply not shown. Nothing here is a claim that any of it is running today.
 * The order below is written for whoever edits this file — the Zentrum is listed alphabetically.
 *
 * The edges are deliberate: the west ends at Mühlburger Tor, the south at the Albtalbahnhof, and
 * the east at Karl-Wilhelm-Platz, Gottesauer Platz and Ostendstraße.
 */
export const zentrumStopIds: readonly string[] = [
  // The Kaiserstraße axis, west to east. One id a place: the provider answers the tunnel and the
  // street platforms from either of their stop ids, so a place is one page and one entry here.
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
  // West and south-west.
  // Both are out of service for construction: their ids are correct and their boards answer with
  // nothing at every hour of the week. They stay listed because the view is observed — nothing
  // calls there, so nothing is shown, and they return by themselves when the service does.
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
