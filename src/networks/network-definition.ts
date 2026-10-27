/**
 * What the app knows about one network beyond the feed: its scope, its authored stop places and its
 * timetable data. A build reads one network (`networks/network.ts`).
 */
import type { Bounds, NetworkScope } from "../data/network-scope";
import type { PtMode } from "../data/transit-types";
import type { BayRun } from "../lib/bay-runs";

/** A stop the app addresses by a fixed slug, and the stop points (DHIDs) its page joins. */
export type AuthoredStopPlace = {
  /** The first names and places the page. */
  stopPoints: readonly [string, ...string[]];
};

/** What the timetable states about one stop (`npm run refresh:stops`). */
export type CatalogStop = {
  /** The stop's DHID. */
  globalId: string;
  /** The operator's name for the stop, without its municipality. */
  name: string;
  latitude: number;
  longitude: number;
  /** The locality: the municipality itself, or a district of it such as Durlach. */
  placeName: string;
  /** Distinct lines calling here in the timetable period. Zero where the period schedules none. */
  lineCount: number;
  /** Calls here in the timetable period. Ranks stops against each other; it is not a frequency. */
  callCount: number;
};

export type NetworkDefinition = {
  /** Its folder under `src/networks/` and its `VITE_NETWORK` value. */
  id: string;
  /** The operator, in the forms German copy needs. */
  operator: {
    /** As a compound's first part: `KVV-Feed`, `KVV-Angebot`. */
    name: string;
    /** `Der KVV`, `des KVV`, and spelled out `des Karlsruher Verkehrsverbunds (KVV)`. */
    nominative: string;
    genitive: string;
    fullGenitive: string;
    /** Where it publishes the line colours, and under which licence. */
    openData: { url: string; licence: string };
  };
  scope: NetworkScope;
  /** The municipality the network centres on, which the feed prefixes its stop names with. */
  home: { placeName: string; stopNamePrefix: RegExp };
  stopPlaces: Readonly<Record<string, AuthoredStopPlace>>;
  stopCatalog: readonly CatalogStop[];
  findCatalogStop(globalId: string): CatalogStop | undefined;
  /** Rail bays by `DHID|bay`: where each stands, and which way it runs. */
  bayPositionByKey: ReadonlyMap<string, { latitude: number; longitude: number }>;
  bayRunByKey: ReadonlyMap<string, BayRun>;
  /** Rail and tram lines that miss a weekday in the timetable period. */
  nonDailyLineIds: ReadonlySet<string>;
  /** The operator's colour for a line; some names need the mode. */
  getLineColor(lineId: string, mode?: PtMode): string | undefined;
  /** The trunk a branch's name is built on (S11 → S1), by the operator's numbering. */
  getLineTrunkId(lineId: string): string | undefined;
  /** What `npm run refresh:stops` reads: the home municipality's stops, and the timetable. */
  catalogSource: {
    /** The DHID prefix of the municipality's stops (`de:08212:`), and a rectangle around them. */
    stopIdPrefix: string;
    bounds: Bounds;
    gtfs: { url: string; publisher: string; licence: string; licenceUrl: string };
  };
};
