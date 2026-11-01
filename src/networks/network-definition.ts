/**
 * What the app knows about one network beyond the feed: its scope, its authored stop places and its
 * timetable data. A build reads one network (`networks/network.ts`).
 */
import type { Bounds, NetworkScope } from "../data/network-scope";
import type { PtMode } from "../data/transit-types";
import type { BayRun } from "../lib/bay-runs";

/** A stop place: one page, addressed by its slug, joining one or more stop points (DHIDs). */
export type StopPlaceDefinition = {
  /** The operator's name without its bracketed aside (`Marktplatz`). */
  name: string;
  /** The district, outside the home municipality (`Durlach`). */
  placeName?: string;
  /** A name riders still use (`Mendelssohnplatz`). */
  formerName?: string;
  /** The busiest first; it places the page. */
  stopPoints: readonly [string, ...string[]];
  /** Each stop point's name on the page (`Unten`, `Vorplatz`), where there are several. */
  parts?: readonly string[];
};

/** What the stop places' name rule (`lib/stop-places.ts`) misses, by DHID. */
export type StopPlaceOverrides = {
  /** Stop points that are one place though named apart. */
  joins?: readonly (readonly string[])[];
  /** Stop points that stay their own place though named alike. */
  splits?: readonly string[];
  /** A slug pinned by any of the place's stop points. */
  slugs?: Readonly<Record<string, string>>;
  /** Former names, by slug. */
  formerNames?: Readonly<Record<string, string>>;
  /** A part's name, by its stop point. */
  partNames?: Readonly<Record<string, string>>;
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

/**
 * Where one operator family's lines run: its operator names in the community colours (`vrn-`), and
 * the districts (`de:08222`) or whole states (`de:08`) its journeys start and end in.
 */
export type OperatorArea = {
  operators: readonly string[];
  districts: readonly string[];
  /** The network's own operators, whose lines take the network's colours. */
  isHome?: boolean;
};

/** A line's colour as its operator publishes it, with the text colour where one is given. */
export type PublishedLineColor = { color: string; textColor?: string };

/** The network's own colours by name, or by `name|mode` where a name has one per mode. */
export type HomeLineColors = Readonly<Record<string, readonly [color: string, textColor?: string]>>;

/** Other operators' colours by line name without spaces (`RE1`): each with its `OperatorArea` index. */
export type OtherLineColors = Readonly<
  Record<string, readonly (readonly [color: string, areaIndex: number, textColor?: string])[]>
>;

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
  /** The operator's brand colour: the shell's accent where no line lends its own. */
  accentColor: string;
  scope: NetworkScope;
  /** The municipality the network centres on, which the feed prefixes its stop names with. */
  home: { placeName: string; stopNamePrefix: RegExp };
  /** Every catalog stop's place, by slug (`npm run refresh:stops`). */
  stopPlaces: Readonly<Record<string, StopPlaceDefinition>>;
  stopPlaceOverrides: StopPlaceOverrides;
  stopCatalog: readonly CatalogStop[];
  findCatalogStop(globalId: string): CatalogStop | undefined;
  /** Rail bays by `DHID|bay`: where each stands, and which way it runs. */
  bayPositionByKey: ReadonlyMap<string, { latitude: number; longitude: number }>;
  bayRunByKey: ReadonlyMap<string, BayRun>;
  /** Rail and tram lines that miss a weekday in the timetable period. */
  nonDailyLineIds: ReadonlySet<string>;
  /** The operator's colour for a line; some names need the mode. */
  getLineColor(lineId: string, mode?: PtMode): PublishedLineColor | undefined;
  /** Operator families around the network, for telling other operators' lines of one name apart. */
  operatorAreas: readonly OperatorArea[];
  otherLineColors: OtherLineColors;
  /** The trunk a branch's name is built on (S11 → S1), by the operator's numbering. */
  getLineTrunkId(lineId: string): string | undefined;
  /** Its own lines in the order its signs list them. */
  compareLineIds(a: string, b: string): number;
  /** Where an address naming no stop or no line lands. */
  defaultStopId: string;
  defaultLineId: string;
  /** The stops a first visit is offered, before any is remembered. */
  suggestedStopIds: readonly string[];
  /** Boards read beyond the Zentrum's posts, for the network's slower-changing rest. */
  reachObservationPostStopIds: readonly string[];
  /** What `npm run refresh:stops` reads: the home municipality's stops, and the timetable. */
  catalogSource: {
    /** The DHID prefix of the municipality's stops (`de:08212:`), and a rectangle around them. */
    stopIdPrefix: string;
    bounds: Bounds;
    gtfs: { url: string; publisher: string; licence: string; licenceUrl: string };
  };
  /** What `npm run refresh:line-colors` reads: the operator's own GTFS, and community colours. */
  lineColorSource: {
    gtfs: { url: string; publisher: string; licence: string };
    community: { url: string; publisher: string; licence: string };
  };
};
