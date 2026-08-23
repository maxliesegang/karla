/** Live boards contain every KVV line calling at a stop, so ids from the feed are open. */
export type LineId = string;

export type TransportMode = "tram" | "lightRail" | "bus" | "other";

/**
 * What kind of boarding place a departure leaves from, as the feed states it.
 *
 * KVV words this itself — `Gleis` for a rail-bound departure, `Bstg.` for a bus one — and prints
 * those words on the stop's own signage, so a view repeats the operator's word rather than picking
 * one. It cannot be inferred from the mode: lines 50 and 62 are buses and the feed reports them at
 * `Gleis 24` at the Hauptbahnhof, because that is where they board. Left `undefined` where the feed
 * states no kind, which is the one case a view has to word generically.
 */
export type PlatformKind = "track" | "stand";

export type TransitStop = {
  id: string;
  name: string;
  /** A second name the stop is known by: a former name, or the municipality for a stop outside. */
  alias?: string;
  /** Where the stop really is. Required for projected core-network stops; other stops may omit it. */
  latitude?: number;
  longitude?: number;
};

/**
 * What the feed states about boarding the vehicle.
 *
 * There are three states, not two, and the third is why this is not a boolean: the feed may state
 * a step-free vehicle, may state a vehicle that is not one, and may state nothing at all. A
 * departure with no reading is *unstated* — never a vehicle with steps — and no view may word it
 * as one. It is the one fact on a board that decides whether a rider can board at all, so it is
 * carried from the feed rather than inferred from the mode or the line.
 */
export type VehicleAccess = "stepFree" | "notStepFree";

/** How much of a departure is measured rather than scheduled. */
export type DepartureStatus = "realtime" | "scheduled" | "cancelled" | "diverted";

export type TripCall = {
  stopName: string;
  /**
   * The municipality the feed states for this calling point. The name beside it is the local one —
   * every second town has a `Bahnhof` — so a view outside that municipality has to say which one.
   */
  placeName?: string;
  platformName?: string;
  /** Present when the provider stop can be resolved to one of our supported local stop pages. */
  localStopId?: string;
  /** The stop whose board produced this departure. */
  isCurrentStop?: boolean;
  /** Where this calling point really is, as the feed states it. */
  latitude?: number;
  longitude?: number;
  /** Scheduled call times as ISO strings; the feed states these to the second. */
  scheduledArrivalTime?: string;
  scheduledDepartureTime?: string;
  /**
   * Realtime deviation at this calling point, as the departure side states it — the headline
   * deviation a row prints. `undefined` means this call is not monitored.
   */
  delayMinutes?: number;
  /**
   * The deviation stated for the *arrival*, where the feed states one of its own.
   *
   * A vehicle that pulls in four minutes down and leaves one minute down has recovered three
   * minutes standing at the platform, and the two numbers are the only evidence of it. Folding
   * them into one would have a mark stand at the stop until the arrival deviation says it may go,
   * which is the one place a diagram most obviously disagrees with the vehicle a rider is watching.
   * `undefined` means the feed stated no separate arrival deviation, and `delayMinutes` describes
   * both ends of the call.
   */
  arrivalDelayMinutes?: number;
};

export type Departure = {
  /** Stop-specific fallback identity for a board entry; URLs prefer `tripId`. */
  id: string;
  /** EFA `RealtimeTripId`, or `AVMSTripID` fallback, shared by the timetable trip across dates. */
  tripId?: string;
  /** Dated identity retained for matching older shared links and deduplicating operating instances. */
  tripInstanceId?: string;
  /** Operator train number; equal numbers can relate separately addressed joined portions. */
  trainNumber?: string;
  lineId: LineId;
  /** Opaque feed identity for the line's operating direction, stable across its headsigns. */
  routeDirectionId?: string;
  transportMode: TransportMode;
  destination: string;
  /**
   * The countdown the feed stated when the board was read. It ages with the board, so a view counts
   * the minutes itself from the schedule and its deviation (`lib/feed-clock.ts`) and falls back to
   * this only for a departure the feed gave no schedule for.
   */
  minutesUntilDeparture: number;
  /** Realtime deviation in minutes; `undefined` when the trip is not monitored. */
  delayMinutes?: number;
  platformName: string;
  /** The feed's own word for that platform; `undefined` where it stated none. */
  platformKind?: PlatformKind;
  /** The physical stop point this row departs from, which may differ from its stop-complex board. */
  boardingStopId: string;
  status: DepartureStatus;
  /** Scheduled departure as an ISO string, used for stable labels on displays. */
  scheduledDepartureTime: string;
  /** Provider prediction for this calling point. Absent means there is no realtime position basis. */
  predictedDepartureTime?: string;
  /** Operator-provided remark such as a diversion, already trimmed for rider-facing copy. */
  serviceNote?: string;
  /** How the feed says this vehicle is boarded. Absent means the feed said nothing about it. */
  vehicleAccess?: VehicleAccess;
  /** Exact calling points for this train; requested from the live feed for the stop detail view. */
  tripCalls?: readonly TripCall[];
};

export type TransitLine = {
  id: LineId;
  name: string;
  color: string;
  textColor: string;
  /** The ends the line was seen running between, most frequent first. */
  destinations: readonly string[];
  zentrumStopIds: readonly string[];
};

export type TransitNetwork = {
  stops: readonly TransitStop[];
  lines: readonly TransitLine[];
};

type DepartureBoardReading = {
  stopId: string;
  /** When this board reached us, on the device's clock, so its age and the feed's clock are known. */
  receivedAt: number;
  departures: readonly Departure[];
};

/**
 * One trip's calls, and when that reading was actually made.
 *
 * A board dates itself and a trip has to as well, because the two are read on different cadences
 * and a trip is not always re-read when it is asked for: a sequence still inside the caller's
 * tolerance is answered from the one already in hand, and a row that arrived carrying its own
 * calls is never re-read at all. `receivedAt` is when the reading was taken, never when it was
 * handed over, so nothing downstream can restate an old reading as a fresh one.
 */
export type TripReading = { trip: Departure; receivedAt: number };

/** One stop's board plus the provenance the views have to disclose. */
export type DepartureBoard = DepartureBoardReading &
  (
    | {
        dataStatus: "live";
        /** Time the data was produced, taken from the feed's own server clock. */
        feedUpdatedAt: string;
      }
    | {
        dataStatus: "unavailable";
        /** Why live data is unavailable, in German, for direct presentation. */
        errorMessage: string;
      }
  );

/**
 * A disruption the operator has published, rather than one read off a departure.
 *
 * The two are different facts and are never merged: a departure board says what is happening to
 * one trip in the next half hour, and a notice says what KVV has announced about a line or a stop
 * — a closure that starts on Monday, a replacement service running for six weeks. A notice is not
 * evidence that anything is running late right now, and a calm board is not evidence that no
 * notice exists.
 */
export type ServiceNotice = {
  id: string;
  /** The operator's own headline for the notice, which is what a rider reads first. */
  title: string;
  /** The lines the notice names, in our line ids. Empty when it names none. */
  lineIds: readonly LineId[];
  /** The named stops that resolve to a stop page of ours. */
  stopIds: readonly string[];
  /** The named stops as published, including those we cannot resolve. */
  stopNames: readonly string[];
  /** The operator's full wording, in the paragraphs it published, neither shortened nor rewritten. */
  details: readonly string[];
  /** When the operator says the disruption applies, as ISO strings. */
  validFrom?: string;
  validUntil?: string;
  /** The operator's own ranking; only `high` is set apart in a view. */
  priority: "normal" | "high";
};

/**
 * The published notices, with the provenance a view has to disclose. A failed read is not an empty
 * feed: "nichts gemeldet" is a claim, and it may only be made from a board that was actually read.
 */
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
