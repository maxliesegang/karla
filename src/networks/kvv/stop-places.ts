/**
 * The stop places the app addresses by a fixed slug, and the stop points (DHIDs) each page joins.
 * Every other stop place is met through search or a call, and is one stop point.
 *
 * A board answers one stop point, so a place of several is read once per point. Its board is split
 * into boarding places in `lib/boarding-places.ts`, by observed journeys rather than bay codes.
 */
import type { AuthoredStopPlace } from "../network-definition";

export const kvvStopPlaces: Readonly<Record<string, AuthoredStopPlace>> = {
  "muehlburger-tor": { stopPoints: ["de:08212:39"] },
  // The street and bus bays, and the tunnel; four boarding places.
  europaplatz: { stopPoints: ["de:08212:37", "de:08212:1004"] },
  // The Kaiserstraße tunnel and the one beneath the pyramid; the S1 calls at both (Pyramide `4(U)`,
  // then Kaiserstraße `1(U)`).
  marktplatz: { stopPoints: ["de:08212:1003", "de:08212:1011"] },
  kronenplatz: { stopPoints: ["de:08212:1002", "de:08212:80"] },
  "durlacher-tor": { stopPoints: ["de:08212:1001", "de:08212:3"] },
  karlstor: { stopPoints: ["de:08212:61"] },
  mathystrasse: { stopPoints: ["de:08212:62"] },
  kolpingplatz: { stopPoints: ["de:08212:63"] },
  ebertstrasse: { stopPoints: ["de:08212:91"] },
  albtalbahnhof: { stopPoints: ["de:08212:1201"] },
  // The station and the Vorplatz tram stop.
  hauptbahnhof: { stopPoints: ["de:08212:90", "de:08212:89"] },
  "ettlinger-tor": { stopPoints: ["de:08212:1012", "de:08212:71"] },
  kongresszentrum: { stopPoints: ["de:08212:1013", "de:08212:72"] },
  konzerthaus: { stopPoints: ["de:08212:510"] },
  augartenstrasse: { stopPoints: ["de:08212:74"] },
  "rueppurrer-tor": { stopPoints: ["de:08212:85"] },
  tivoli: { stopPoints: ["de:08212:84"] },
  // The Zentrum's edges, so their addresses do not depend on discovery.
  werderstrasse: { stopPoints: ["de:08212:83"] },
  poststrasse: { stopPoints: ["de:08212:98"] },
  ostendstrasse: { stopPoints: ["de:08212:622"] },
  "philipp-reis-strasse": { stopPoints: ["de:08212:621"] },
  "karl-wilhelm-platz": { stopPoints: ["de:08212:401"] },
  "gottesauer-platz": { stopPoints: ["de:08212:6"] },
  tullastrasse: { stopPoints: ["de:08212:7"] },
  "wolfartsweierer-strasse": { stopPoints: ["de:08212:623"] },
  "schloss-gottesaue": { stopPoints: ["de:08212:624"] },
  zkm: { stopPoints: ["de:08212:65"] },
  welfenstrasse: { stopPoints: ["de:08212:6218"] },
  barbarossaplatz: { stopPoints: ["de:08212:5003"] },
  arbeitsagentur: { stopPoints: ["de:08212:64"] },
  lessingstrasse: { stopPoints: ["de:08212:507"] },
  "otto-sachs-strasse": { stopPoints: ["de:08212:508"] },
  // Reach posts, addressable before discovery. The station and the tram stop in front are one place.
  "durlach-bahnhof": { stopPoints: ["de:08212:802", "de:08212:801"] },
  rheinbergstrasse: { stopPoints: ["de:08212:107"] },
  entenfang: { stopPoints: ["de:08212:51"] },
  zuendhuetle: { stopPoints: ["de:08212:4492"] },
  turmberg: { stopPoints: ["de:08212:18"] },
};
