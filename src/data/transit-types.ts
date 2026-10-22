/** Live boards contain every KVV line calling at a stop, so ids from the feed are open. */
export type LineId = string;
/**
 * `LineId` is the rider-facing sign. The provider's key (`servingLine.stateless`) is a different
 * fact and keeps its spelling: a locator's `line`, dated journey keys, wire filters.
 */

export type PtMode = "tram" | "lightRail" | "bus" | "other";

/**
 * The boarding place's kind as the feed words it: `Gleis` or `Bstg.`. Not inferable from the mode
 * (buses 50 and 62 board at `Gleis 24` at the Hauptbahnhof).
 */
export type BayKind = "track" | "stand";

export type StopPlace = {
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

/** How much of a departure is measured rather than timetabled. */
export type StopEventStatus = "realtime" | "scheduled" | "cancelled" | "diverted";

export type Call = {
  stopName: string;
  /**
   * The municipality of this call, since local names repeat (every second town has a `Bahnhof`).
   */
  placeName?: string;
  /** The operator's worded bay from a sequence (`Gleis 3`, `Bstg. A`). */
  bayText?: string;
  /**
   * The bare bay code a row states (`3`, `1(U)`, `A`), needed to compare a call with a row and
   * to derive boarding places.
   */
  bay?: string;
  /** The EFA stop point, finer than `localStopId`: it tells Marktplatz's two tunnels apart. */
  providerStopPointId?: string;
  /** Present when the provider stop can be resolved to one of our supported local stop pages. */
  localStopId?: string;
  /** The stop whose board produced this departure. */
  isThisCall?: boolean;
  /** Where this calling point really is, as the feed states it. */
  latitude?: number;
  longitude?: number;
  /** ISO strings, to the second. */
  timetabledArrivalTime?: string;
  timetabledDepartureTime?: string;
  /**
   * Predictions to the second where the feed states them (TRIAS); they win over schedule plus
   * deviation. The whole-minute delays below are then their rounded, printable form.
   */
  estimatedArrivalTime?: string;
  estimatedDepartureTime?: string;
  /**
   * Departure-side deviation in whole minutes, the one a row prints. `undefined`: the call is not
   * monitored.
   */
  delayMinutes?: number;
  /**
   * The arrival deviation where the feed states a separate one: a vehicle can arrive four minutes
   * late and leave one minute late. `undefined`: `delayMinutes` covers both ends.
   */
  arrivalDelayMinutes?: number;
};

export type StopEvent = {
  /** Stop-specific fallback identity for a board entry; URLs prefer `journeyRef`. */
  id: string;
  /**
   * EFA `RealtimeTripId`, or `AVMSTripID` fallback, shared by the timetable journey across dates.
   */
  journeyRef?: string;
  /** Dated identity, for matching older shared links and deduplicating operating instances. */
  datedJourneyId?: string;
  /** Operator train number; equal numbers can relate separately addressed joined portions. */
  publishedJourneyNumber?: string;
  lineId: LineId;
  /** Opaque feed identity for the line's operating direction, stable across its headsigns. */
  lineRef?: string;
  ptMode: PtMode;
  destinationText: string;
  /**
   * The feed's countdown when the board was read. Views count from the schedule instead
   * (`lib/feed-clock.ts`) and fall back to this only without a schedule.
   */
  minutesUntilDeparture: number;
  /** Realtime deviation in minutes; `undefined` when the journey is not monitored. */
  delayMinutes?: number;
  bay: string;
  /** The feed's own word for that bay; `undefined` where it stated none. */
  bayKind?: BayKind;
  /**
   * The local stop this row departs from, which can differ from the board's (a complex's page lists
   * all its stop points). Same grain as `Call.localStopId`.
   */
  boardingLocalStopId: string;
  /**
   * The EFA stop point and its name, as `Call` carries them. The name is the operator's signage
   * (`Marktplatz (Pyramide U)`), which tells tunnel and street level apart.
   */
  boardingProviderStopPointId: string;
  boardingProviderStopPointName: string;
  status: StopEventStatus;
  /** Timetabled departure as an ISO string, used for stable labels on displays. */
  timetabledDepartureTime: string;
  /** The provider's prediction. Absent means there is no realtime basis. */
  estimatedDepartureTime?: string;
  /** The prediction is stated to the second (TRIAS); EFA's is truncated to the minute. */
  isEstimatedToTheSecond?: boolean;
  /** Operator-provided remark such as a diversion, already trimmed for rider-facing copy. */
  serviceNote?: string;
  /** How the feed says this vehicle is boarded. Absent means the feed said nothing about it. */
  vehicleAccess?: VehicleAccess;
  /** Calling points, where the board or a journey read supplied them. */
  calls?: readonly Call[];
  /**
   * When the row and the sequence merged into it were read, on the device's clock, so copies of one
   * dated journey can be ranked. Set by `TransitSource` on every departure; optional only for
   * fixtures.
   */
  readAt?: StopEventReadingTimes;
};

/** `sequenceReadAt` only where there are calls; a row without them has nothing to go stale. */
export type StopEventReadingTimes = {
  rowReadAt: number;
  sequenceReadAt?: number;
  sequenceRefreshFailedAt?: number;
  coverageReadAt?: number;
};

/**
 * A dated journey's calling sequence from one reading. Not a `StopEvent`: the row it was discovered
 * through carries facts about one stop that would mislead every other stop reading the copy.
 */
export type DatedJourneyCalls = {
  calls: readonly Call[];
  /** The dated identity this sequence's first call refines, where the reading names one. */
  datedJourneyId?: string;
  status: StopEventStatus;
  /** When these calls were read, on the device's clock. Absent only on a fixture. */
  readAt?: number;
  /** Oldest reading retained where a newer response supplied only part of the route. */
  coverageReadAt?: number;
};

export type TransitLine = {
  id: LineId;
  name: string;
  /** The mode the line was seen running under. */
  ptMode?: PtMode;
  color: string;
  textColor: string;
  /** The ends the line was seen running between, most frequent first. */
  destinations: readonly string[];
  /**
   * The ends of the farthest observed dated journey, as a heading names them (`Knielingen Nord`,
   * not `Nord`). Absent where none was observed far enough or it loops; the destinations stand in.
   */
  farthestDatedJourneyTermini?: readonly string[];
  /** The Zentrum calls: where this line was seen calling inside the Zentrum's membership. */
  zentrumCalls: readonly string[];
};

export type TransitNetwork = {
  stops: readonly StopPlace[];
  lines: readonly TransitLine[];
};

type StopEventBoardReading = {
  stopId: string;
  /** When this board arrived, on the device's clock. */
  receivedAt: number;
  stopEvents: readonly StopEvent[];
  /**
   * The line-directions known at this stop, only on an unfiltered board. Timetabled metadata, never
   * evidence of a departure: nothing is rendered from it. It names the ids a board can be filtered
   * to, so lines without a row on a busy stop's board are still read.
   */
  servingLines?: readonly ServingLine[];
};

/** A line-direction a stop states: the provider's opaque id, with the line's name where known. */
export type ServingLine = { lineId?: string; lineRef: string; ptMode?: PtMode };

/** One stop's board plus the provenance the views have to disclose. */
export type StopEventBoard = StopEventBoardReading &
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

export type LiveStopEventBoard = Extract<StopEventBoard, { dataStatus: "live" }>;

/** How many boards in a multi-stop observation answered its latest refresh. */
export type StopEventBoardCoverage = {
  status: "loading" | "complete" | "partial" | "unavailable";
  expectedBoardCount: number;
  liveBoardCount: number;
};

/** What a caller wants of a board beyond its stop. Unstated means smallest and freshest. */
export type StopEventBoardRequest = {
  /**
   * The calling sequence behind every departure, and most of a board's weight. Used to discover the
   * network; a selected line's journeys use the one-journey endpoint.
   */
  includeCalls?: boolean;
  /** How old a board in hand may be and still answer. Zero asks the feed. */
  maxAgeMs?: number;
  /** Fill sparse line-directions with filtered reads. Stop overview only. */
  minimumStopEventsPerDirection?: number;
  /** Only supplemented departures expected inside this live window may be added. */
  coverageHorizonMs?: number;
  /**
   * Restrict to these `lineRef`s. A stop's forty rows then cover one line about ninety
   * minutes ahead instead of every line for twenty.
   */
  lineRefs?: readonly string[];
};

/**
 * Stops and event directions used to discover dated journeys, independently of passenger boards.
 */
export type DatedJourneyDiscoveryPost = {
  stopId: string;
  eventKind: "departure" | "arrival";
};

export type DatedJourneyDiscoveryReading = {
  datedJourneyStopEvents: readonly StopEvent[];
  clockBoard: StopEventBoard | null;
  failedStopIds: readonly string[];
};
