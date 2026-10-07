/** Live boards contain every KVV line calling at a stop, so ids from the feed are open. */
export type LineId = string;
/**
 * `LineId` is the rider-facing sign. The provider's key (`servingLine.stateless`) is a different
 * fact and keeps its spelling: a locator's `line`, run keys, wire filters.
 */

export type TransportMode = "tram" | "lightRail" | "bus" | "other";

/**
 * The boarding place's kind as the feed words it: `Gleis` or `Bstg.`. Not inferable from the mode
 * (buses 50 and 62 board at `Gleis 24` at the Hauptbahnhof).
 */
export type PlatformKind = "track" | "stand";

export type TransitStop = {
  id: string;
  name: string;
  /** A second name the stop is known by: a former name, or the municipality for a stop outside. */
  alias?: string;
  /** Required for projected core-network stops. */
  latitude?: number;
  longitude?: number;
};

/** What the feed states about boarding. Absent is unstated, never a vehicle with steps. */
export type VehicleAccess = "stepFree" | "notStepFree";

/** How much of a departure is measured rather than scheduled. */
export type DepartureStatus = "realtime" | "scheduled" | "cancelled" | "diverted";

export type TripCall = {
  stopName: string;
  /**
   * The municipality of this call, since local names repeat (every second town has a `Bahnhof`).
   */
  placeName?: string;
  /** The operator's worded platform from a sequence (`Gleis 3`, `Bstg. A`). */
  platformLabel?: string;
  /**
   * The bare platform code a row states (`3`, `1(U)`, `A`), needed to compare a call with a row and
   * to derive boarding places.
   */
  platformCode?: string;
  /** The EFA stop point, finer than `localStopId`: it tells Marktplatz's two tunnels apart. */
  providerStopPointId?: string;
  /** Present when the provider stop can be resolved to one of our supported local stop pages. */
  localStopId?: string;
  /** The stop whose board produced this departure. */
  isCurrentStop?: boolean;
  /** Where this calling point really is, as the feed states it. */
  latitude?: number;
  longitude?: number;
  /** ISO strings, to the second. */
  scheduledArrivalTime?: string;
  scheduledDepartureTime?: string;
  /** Departure-side deviation, the one a row prints. `undefined`: the call is not monitored. */
  delayMinutes?: number;
  /**
   * The arrival deviation where the feed states a separate one: a vehicle can arrive four minutes
   * late and leave one minute late. `undefined`: `delayMinutes` covers both ends.
   */
  arrivalDelayMinutes?: number;
};

export type Departure = {
  /** Stop-specific fallback identity for a board entry; URLs prefer `tripId`. */
  id: string;
  /** EFA `RealtimeTripId`, or `AVMSTripID` fallback, shared by the timetable trip across dates. */
  tripId?: string;
  /** Dated identity, for matching older shared links and deduplicating operating instances. */
  tripInstanceId?: string;
  /** Operator train number; equal numbers can relate separately addressed joined portions. */
  trainNumber?: string;
  lineId: LineId;
  /** Opaque feed identity for the line's operating direction, stable across its headsigns. */
  routeDirectionId?: string;
  transportMode: TransportMode;
  destination: string;
  /**
   * The feed's countdown when the board was read. Views count from the schedule instead
   * (`lib/feed-clock.ts`) and fall back to this only without a schedule.
   */
  minutesUntilDeparture: number;
  /** Realtime deviation in minutes; `undefined` when the trip is not monitored. */
  delayMinutes?: number;
  platformCode: string;
  /** The feed's own word for that platform; `undefined` where it stated none. */
  platformKind?: PlatformKind;
  /**
   * The local stop this row departs from, which can differ from the board's (a complex's page lists
   * all its stop points). Same grain as `TripCall.localStopId`.
   */
  boardingLocalStopId: string;
  /**
   * The EFA stop point and its name, as `TripCall` carries them. The name is the operator's signage
   * (`Marktplatz (Pyramide U)`), which tells tunnel and street level apart.
   */
  boardingProviderStopPointId: string;
  boardingProviderStopPointName: string;
  status: DepartureStatus;
  /** Scheduled departure as an ISO string, used for stable labels on displays. */
  scheduledDepartureTime: string;
  /** The provider's prediction. Absent means there is no realtime basis. */
  predictedDepartureTime?: string;
  /** Operator-provided remark such as a diversion, already trimmed for rider-facing copy. */
  serviceNote?: string;
  /** How the feed says this vehicle is boarded. Absent means the feed said nothing about it. */
  vehicleAccess?: VehicleAccess;
  /** Calling points, where the board or a trip read supplied them. */
  tripCalls?: readonly TripCall[];
  /**
   * When the row and the sequence merged into it were read, on the device's clock, so copies of one
   * run can be ranked. Set by `TransitSource` on every departure; optional only for fixtures.
   */
  readAt?: DepartureReadingTimes;
};

/** `sequenceReadAt` only where there are calls; a row without them has nothing to go stale. */
export type DepartureReadingTimes = {
  rowReadAt: number;
  sequenceReadAt?: number;
  coverageReadAt?: number;
};

/**
 * A run's calling sequence from one reading. Not a `Departure`: the row it was discovered through
 * carries facts about one stop that would mislead every other stop reading the copy.
 */
export type RunSequence = {
  tripCalls: readonly TripCall[];
  /** The dated identity this sequence's first call refines, where the reading names one. */
  tripInstanceId?: string;
  status: DepartureStatus;
  /** When these calls were read, on the device's clock. Absent only on a fixture. */
  readAt?: number;
  /** Oldest reading retained where a newer response supplied only part of the route. */
  coverageReadAt?: number;
};

export type TransitLine = {
  id: LineId;
  name: string;
  /** The mode the line was seen running under. */
  transportMode?: TransportMode;
  color: string;
  textColor: string;
  /** The ends the line was seen running between, most frequent first. */
  destinations: readonly string[];
  /**
   * The ends of the farthest observed run, as a heading names them (`Knielingen Nord`, not `Nord`).
   * Absent where none was observed far enough or it loops; the destinations stand in.
   */
  farthestRunTermini?: readonly string[];
  /** The Zentrum calls: where this line was seen calling inside the Zentrum's membership. */
  zentrumCalls: readonly string[];
};

export type TransitNetwork = {
  stops: readonly TransitStop[];
  lines: readonly TransitLine[];
};

type DepartureBoardReading = {
  stopId: string;
  /** When this board arrived, on the device's clock. */
  receivedAt: number;
  departures: readonly Departure[];
  /**
   * The line-directions known at this stop, only on an unfiltered board. Scheduled metadata, never
   * evidence of a departure: nothing is rendered from it. It names the ids a board can be filtered
   * to, so lines without a row on a busy stop's board are still read.
   */
  servingLines?: readonly ServingLine[];
};

/** A line-direction a stop states: the provider's opaque id, with the line's name where known. */
export type ServingLine = { lineId?: string; directionId: string; transportMode?: TransportMode };

/** One stop's board plus the provenance the views have to disclose. */
export type DepartureBoard = DepartureBoardReading &
  (
    | {
        dataStatus: "live";
        /** Time the data was produced, taken from the feed's own server clock. */
        feedUpdatedAt: string;
        /** When a later refresh failed, where this is the last live reading kept on screen. */
        refreshFailedAt?: number;
      }
    | {
        dataStatus: "unavailable";
        /** Why live data is unavailable, in German, for direct presentation. */
        errorMessage: string;
      }
  );

export type LiveDepartureBoard = Extract<DepartureBoard, { dataStatus: "live" }>;

/**
 * A disruption the operator announced. Never merged with departures: a notice is not evidence of a
 * delay now, and a calm board is not evidence there is no notice.
 */
export type ServiceNotice = {
  id: string;
  /** The operator's headline. */
  title: string;
  /** The lines the notice names, in our line ids. Empty when it names none. */
  lineIds: readonly LineId[];
  /** The named stops that resolve to a stop page of ours. */
  stopIds: readonly string[];
  /** The named stops as published, including those we cannot resolve. */
  stopNames: readonly string[];
  /** The operator's full wording, verbatim. */
  details: readonly string[];
  /** When the operator says the disruption applies, as ISO strings. */
  validFrom?: string;
  validUntil?: string;
  /** The operator's own ranking; only `high` is set apart in a view. */
  priority: "normal" | "high";
};

/** The published notices. A failed read is not an empty feed: "nichts gemeldet" needs a reading. */
type ServiceNoticeBoardReading = {
  /** When this reading arrived, on the device's clock. */
  receivedAt: number;
  notices: readonly ServiceNotice[];
};

export type ServiceNoticeBoard = ServiceNoticeBoardReading &
  (
    | { dataStatus: "live" }
    | {
        dataStatus: "unavailable";
        /** Why the notices are unavailable, in German, for direct presentation. */
        errorMessage: string;
      }
  );

/** How many boards in a multi-stop observation answered its latest refresh. */
export type DepartureBoardCoverage = {
  status: "loading" | "complete" | "partial" | "unavailable";
  expectedBoardCount: number;
  liveBoardCount: number;
};

/** What a caller wants of a board beyond its stop. Unstated means smallest and freshest. */
export type DepartureBoardRequest = {
  /**
   * The calling sequence behind every departure, and most of a board's weight. Used to discover the
   * network; a selected line's trips use the one-trip endpoint.
   */
  includeTripCalls?: boolean;
  /** How old a board in hand may be and still answer. Zero asks the feed. */
  maxAgeMs?: number;
  /** Fill sparse line-directions with filtered reads. Stop overview only. */
  minimumDeparturesPerDirection?: number;
  /** Only supplemented departures expected inside this live window may be added. */
  coverageHorizonMs?: number;
  /**
   * Restrict to these `routeDirectionId`s. A stop's forty rows then cover one line about ninety
   * minutes ahead instead of every line for twenty.
   */
  routeDirectionIds?: readonly string[];
};

/** Stops and event directions used to discover runs, independently of passenger boards. */
export type RunDiscoveryPost = {
  stopId: string;
  eventKind: "departure" | "arrival";
};

export type RunDiscoveryReading = {
  runDepartures: readonly Departure[];
  clockBoard: DepartureBoard | null;
  failedStopIds: readonly string[];
};
