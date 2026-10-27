/** The Karlsruher Verkehrsverbund: Karlsruhe and its region (`docs/networks/kvv.md`). */
import type { NetworkScope } from "../../data/network-scope";
import type { NetworkDefinition } from "../network-definition";
import { bayPositionByKey } from "./generated/bay-positions";
import { bayRunByKey } from "./generated/bay-runs";
import { nonDailyLineIds } from "./generated/line-days";
import { findCatalogStop, stopCatalog } from "./generated/stop-catalog";
import { getKvvLineColor } from "./line-colors";
import { kvvStopPlaces } from "./stop-places";

/**
 * KVV's own lines in its tariff area (Karlsruhe, Rastatt, Baden-Baden, Pforzheim, Enzkreis,
 * Südpfalz). Other pools sharing KVV's modes stay out: DB's S-Bahn Rhein-Neckar (`ddb:`) and rail
 * replacement (`rab:`). Measured 5 September 2026.
 */
const scope: NetworkScope = {
  pools: new Set(["kvv"]),
  bounds: {
    /** Renchen and Achern in; the Ortenau beyond out. */
    south: 48.55,
    /** Lingenfeld in the Germersheim district stays in; Speyer, already VRN, stays out. */
    north: 49.28,
    /** Dahn in the Südliche Weinstraße stays in; Pirmasens stays out. */
    west: 7.75,
    /** Mühlacker at the Enzkreis edge stays in; Stuttgart stays out. */
    east: 8.9,
  },
};

export const kvvNetwork: NetworkDefinition = {
  id: "kvv",
  operator: {
    name: "KVV",
    nominative: "Der KVV",
    genitive: "des KVV",
    fullGenitive: "des Karlsruher Verkehrsverbunds (KVV)",
    openData: { url: "https://www.kvv.de/fahrplan/fahrplaene/open-data.html", licence: "CC0" },
  },
  scope,
  /** The feed names Karlsruhe's stops `KA Marktplatz` or `Karlsruhe Marktplatz`. */
  home: { placeName: "Karlsruhe", stopNamePrefix: /^(?:KA|Karlsruhe) (?=\S)/ },
  stopPlaces: kvvStopPlaces,
  stopCatalog,
  findCatalogStop,
  bayPositionByKey,
  bayRunByKey,
  nonDailyLineIds,
  getLineColor: getKvvLineColor,
  /** S11 → S1, S51 → S5. S4 and S41 part north of the city, so it does not mean they run together. */
  getLineTrunkId: (lineId) => lineId.match(/^S\d/)?.[0],
  catalogSource: {
    stopIdPrefix: "de:08212:",
    bounds: { south: 48.93, north: 49.1, west: 8.27, east: 8.55 },
    gtfs: {
      url: "https://www.nvbw.de/fileadmin/user_upload/service/open_data/fahrplandaten_ohne_liniennetz/bwgesamt.zip",
      publisher: "NVBW",
      licence: "Datenlizenz Deutschland – Namensnennung 2.0",
      licenceUrl: "https://www.govdata.de/dl-de/by-2-0",
    },
  },
};
