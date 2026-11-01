/** The Karlsruher Verkehrsverbund: Karlsruhe and its region (`docs/networks/kvv.md`). */
import type { NetworkScope } from "../../data/network-scope";
import type { NetworkDefinition } from "../network-definition";
import { bayPositionByKey } from "./generated/bay-positions";
import { bayRunByKey } from "./generated/bay-runs";
import { nonDailyLineIds } from "./generated/line-days";
import { findCatalogStop, stopCatalog } from "./generated/stop-catalog";
import { stopPlaces } from "./generated/stop-places";
import { homeLineColors, otherLineColors } from "./generated/line-colors";
import { kvvOperatorAreas } from "./operator-areas";
import { kvvStopPlaceOverrides } from "./stop-place-overrides";

/** KVV's own pool, and its tariff area (Karlsruhe to the Südpfalz and Enzkreis). */
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

/** S11 → S1, S51 → S5. S4 and S41 part north of the city, so it does not mean they run together. */
const getLineTrunkId = (lineId: string): string | undefined => lineId.match(/^S\d/)?.[0];

/** Trams first, then by number, branches beside their trunk (S1, S11, S12, S2). */
function compareLineIds(a: string, b: string): number {
  const rank = (id: string) => (id.startsWith("S") ? 1 : 0);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  const number = (id: string) => Number.parseInt(id.replace(/^\D+/, ""), 10) || 0;
  if (a.startsWith("S") && b.startsWith("S")) {
    const trunk = (id: string) => Number.parseInt(getLineTrunkId(id)?.slice(1) ?? "0", 10);
    return trunk(a) - trunk(b) || number(a) - number(b) || a.localeCompare(b);
  }
  return number(a) - number(b) || a.localeCompare(b);
}

export const kvvNetwork: NetworkDefinition = {
  id: "kvv",
  operator: {
    name: "KVV",
    nominative: "Der KVV",
    genitive: "des KVV",
    fullGenitive: "des Karlsruher Verkehrsverbunds (KVV)",
    openData: { url: "https://www.kvv.de/fahrplan/fahrplaene/open-data.html", licence: "CC0" },
  },
  accentColor: "#c9161c",
  scope,
  /** The feed names Karlsruhe's stops `KA Marktplatz` or `Karlsruhe Marktplatz`. */
  home: { placeName: "Karlsruhe", stopNamePrefix: /^(?:KA|Karlsruhe) (?=\S)/ },
  stopPlaces,
  stopPlaceOverrides: kvvStopPlaceOverrides,
  stopCatalog,
  findCatalogStop,
  bayPositionByKey,
  bayRunByKey,
  nonDailyLineIds,
  getLineColor: (lineId, mode) => {
    const published = (mode && homeLineColors[`${lineId}|${mode}`]) || homeLineColors[lineId];
    return published && { color: published[0], textColor: published[1] };
  },
  operatorAreas: kvvOperatorAreas,
  otherLineColors,
  getLineTrunkId,
  compareLineIds,
  defaultStopId: "europaplatz",
  defaultLineId: "2",
  suggestedStopIds: ["marktplatz", "europaplatz", "hauptbahnhof"],
  /**
   * Where tram-trains change system, and bus hubs (`zentrum-stops.ts` has the measurement). Turmberg
   * is marginal (stops seen 82% → 86%) and the first to drop.
   */
  reachObservationPostStopIds: [
    "durlach-bahnhof",
    "knielingen-rheinbergstrasse",
    "entenfang",
    "durlach-zuendhuetle",
    "durlach-turmberg",
  ],
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
  lineColorSource: {
    gtfs: {
      url: "https://projekte.kvv-efa.de/GTFS/google_transit.zip",
      publisher: "KVV",
      licence: "CC0 1.0",
    },
    community: {
      url: "https://raw.githubusercontent.com/Traewelling/line-colors/main/line-colors.csv",
      publisher: "Träwelling line-colors",
      licence: "CC0 1.0",
    },
  },
};
