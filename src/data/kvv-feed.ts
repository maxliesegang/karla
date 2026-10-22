/**
 * The provider boundary below `TransitSource`: what a KVV feed answers, in one model whichever
 * interface (EFA or TRIAS) read it.
 */
import type { StopEventStatus, BayKind, PtMode, Call, VehicleAccess } from "./transit-types";

export type KvvStopEventBoardOptions = {
  limit?: number;
  includeCalls?: boolean;
  /** Line-direction ids (`lineRef`) to filter by. */
  lineIds?: readonly string[];
  eventKind?: "departure" | "arrival";
};

/**
 * What the app reads from KVV, through one interface for the whole session (`kvv-feed-config.ts`).
 * Every method rejects when the provider could not be read.
 */
export interface KvvFeed {
  fetchStopEventBoard(
    stopPointId: string,
    options?: KvvStopEventBoardOptions,
  ): Promise<KvvStopEventBoard>;
  fetchTripInfo(locator: KvvJourneyLocator): Promise<KvvTripInfo>;
  searchStops(query: string): Promise<KvvStopSearchResult[]>;
  /** A line-direction's stops, addressed through one of its dated journeys. */
  fetchLineRoute(locator: KvvJourneyLocator): Promise<KvvCall[]>;
}

/** A calling point as the feed states it, still carrying the provider stop id it was read from. */
export type KvvCall = Call & { providerId?: string };

/**
 * The provider tuple that identifies one dated journey; every field is copied from its board row.
 */
export type KvvJourneyLocator = {
  journeyCode: string;
  /** The provider's own key for the service designation (`servingLine.stateless`), not the sign. */
  lineRef: string;
  stopPointId: string;
  /** The row's timetabled calendar day and minute, `YYYYMMDD` and `HHMM`, in network time. */
  date: string;
  time: string;
  /** TRIAS's `OperatingDayRef` (`YYYY-MM-DD`), which differs from `date` after midnight. */
  operatingDayRef?: string;
};

export type KvvTripInfo = {
  serverTime: string;
  calls: KvvCall[];
  /** Only exceptional whole-journey states override the fresher stop-specific DM row. */
  status?: Extract<StopEventStatus, "cancelled" | "diverted">;
};

export type KvvStopEvent = {
  /** Provider stop point the vehicle departs from; a complex reports several of these. */
  stopPointId: string;
  stopPointName: string;
  /**
   * The timetable-journey identity: EFA's `RealtimeTripId` (AVMS as fallback), TRIAS's
   * `JourneyRef`.
   */
  journeyRef?: string;
  /** Dated identity, for matching older shared links and deduplicating operating instances. */
  datedJourneyId?: string;
  /** `servingLine.trainNum`, including where two separately addressed portions share one train. */
  publishedJourneyNumber?: string;
  lineId: string;
  /** Opaque identity for this line and operating direction (`kvv:21005:E:R:s26`). */
  lineRef?: string;
  ptMode: PtMode;
  destinationText: string;
  minutesUntilDeparture: number;
  delayMinutes?: number;
  bay: string;
  bayKind?: BayKind;
  status: StopEventStatus;
  timetabledDepartureTime: string;
  estimatedDepartureTime?: string;
  /** The prediction is stated to the second (TRIAS); EFA's is truncated to the minute. */
  isEstimatedToTheSecond?: boolean;
  serviceNote?: string;
  /** What the feed states about boarding this vehicle, where it states anything at all. */
  vehicleAccess?: VehicleAccess;
  /** Opaque provider state used below `TransitSource` to load only this journey. */
  journeyLocator?: KvvJourneyLocator;
  calls?: KvvCall[];
};

export type KvvStopEventBoard = {
  stopPointId: string;
  stopName: string;
  /** Server time of the feed, so countdowns are anchored to the source, not the browser clock. */
  serverTime: string;
  /**
   * Timetabled line-directions the stop monitor can query; never evidence of a departure itself.
   * EFA states them; TRIAS does not, so its boards leave them empty.
   */
  servingLines: KvvServingLine[];
  stopEvents: KvvStopEvent[];
};

/**
 * A line-direction a stop serves, paired with the line's name. Direction ids are opaque, so this
 * pairing is the only way to name a line with no departure on the board.
 */
export type KvvServingLine = {
  lineId?: string;
  lineRef: string;
  ptMode?: PtMode;
};

export type KvvStopSearchResult = {
  providerId: string;
  name: string;
  /** The municipality the stop is in, as the feed states it. */
  placeName?: string;
  /** Where the stop stands, so the source can tell what is inside the network's area. */
  latitude?: number;
  longitude?: number;
};

/**
 * A dated journey id: the journey id is reused on later dates, so it is paired with the first
 * timetabled call. Exported so a single-journey reading yields the same id as a board's.
 */
export function getDatedJourneyId(
  journeyRef: string | undefined,
  calls:
    | readonly { timetabledArrivalTime?: string; timetabledDepartureTime?: string }[]
    | undefined,
): string | undefined {
  if (!journeyRef) return undefined;
  const firstCall = calls?.[0];
  const journeyStartTime = firstCall?.timetabledDepartureTime ?? firstCall?.timetabledArrivalTime;
  // To the minute: rows publish the first call to the minute, sequences to the second.
  return journeyStartTime ? `${journeyRef}@${journeyStartTime.slice(0, 16)}` : journeyRef;
}
