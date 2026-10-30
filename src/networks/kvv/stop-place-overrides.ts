/** Where KVV's stop places differ from what the catalog's names say (`lib/stop-places.ts`). */
import type { StopPlaceOverrides } from "../network-definition";

export const kvvStopPlaceOverrides: StopPlaceOverrides = {
  // Durlach's station (`Bahnhof`) and the tram stop in front (`Karlsruhe-Durlach`).
  joins: [["de:08212:802", "de:08212:801"]],
  // Renamed in 2021.
  formerNames: { "rueppurrer-tor": "Mendelssohnplatz" },
  // The stations' tracks, which the name rule would call by the place's own name.
  partNames: {
    "de:08212:90": "Bahnhof",
    "de:08212:802": "Bahnhof",
    "de:08212:801": "Straßenbahn",
  },
};
