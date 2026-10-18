/**
 * The provider boundary below `TransitSource`: what a KVV feed answers, in one model whichever
 * interface (EFA or TRIAS) read it.
 */
import type {
  DepartureStatus,
  PlatformKind,
  TransportMode,
  TripCall,
  VehicleAccess,
} from "./transit-types";

export type KvvDepartureBoardOptions = {
  limit?: number;
  includeTripCalls?: boolean;
  /** Line-direction ids (`routeDirectionId`) to filter by. */
  lineIds?: readonly string[];
  eventKind?: "departure" | "arrival";
};

/** Timed KVV readings. Every method rejects when the provider could not be read. */
export interface KvvLiveFeed {
  fetchDepartureBoard(
    stopPointId: string,
    options?: KvvDepartureBoardOptions,
  ): Promise<KvvDepartureBoard>;
  fetchTrip(locator: KvvTripLocator): Promise<KvvTrip>;
  searchStops(query: string): Promise<KvvStopSearchResult[]>;
}

/** EFA also supplies timetable routes and published notices. */
export interface KvvFeed extends KvvLiveFeed {
  fetchLineRoute(locator: KvvTripLocator): Promise<KvvTripCall[]>;
  fetchServiceNotices(): Promise<KvvServiceNotice[]>;
}

/** A calling point as the feed states it, still carrying the provider stop id it was read from. */
export type KvvTripCall = TripCall & { providerId?: string };

/** The provider tuple that identifies one dated trip; every field is copied from its board row. */
export type KvvTripLocator = {
  tripCode: string;
  /** The provider's own key for the service designation (`servingLine.stateless`), not the sign. */
  line: string;
  stopPointId: string;
  /** The row's scheduled calendar day and minute, `YYYYMMDD` and `HHMM`, in network time. */
  date: string;
  time: string;
  /** TRIAS's `OperatingDayRef` (`YYYY-MM-DD`), which differs from `date` after midnight. */
  operatingDay?: string;
};

export type KvvTrip = {
  serverTime: string;
  tripCalls: KvvTripCall[];
  /** Only exceptional whole-trip states override the fresher stop-specific DM row. */
  status?: Extract<DepartureStatus, "cancelled" | "diverted">;
};

export type KvvDeparture = {
  /** Provider stop point the vehicle departs from; a complex reports several of these. */
  stopPointId: string;
  stopPointName: string;
  /** The timetable-trip identity: EFA's `RealtimeTripId` (AVMS as fallback), TRIAS's `JourneyRef`. */
  tripId?: string;
  /** Dated identity, for matching older shared links and deduplicating operating instances. */
  tripInstanceId?: string;
  /** `servingLine.trainNum`, including where two separately addressed portions share one train. */
  trainNumber?: string;
  lineId: string;
  /** Opaque identity for this line and operating direction (`kvv:21005:E:R:s26`). */
  routeDirectionId?: string;
  transportMode: TransportMode;
  destination: string;
  minutesUntilDeparture: number;
  delayMinutes?: number;
  platformCode: string;
  platformKind?: PlatformKind;
  status: DepartureStatus;
  scheduledDepartureTime: string;
  predictedDepartureTime?: string;
  /** The prediction is stated to the second (TRIAS); EFA's is truncated to the minute. */
  isPredictedToTheSecond?: boolean;
  serviceNote?: string;
  /** What the feed states about boarding this vehicle, where it states anything at all. */
  vehicleAccess?: VehicleAccess;
  /** Opaque provider state used below `TransitSource` to load only this trip. */
  tripLocator?: KvvTripLocator;
  tripCalls?: KvvTripCall[];
};

export type KvvDepartureBoard = {
  stopPointId: string;
  stopName: string;
  /** Server time of the feed, so countdowns are anchored to the source, not the browser clock. */
  serverTime: string;
  /** Scheduled line-directions the stop monitor can query; never evidence of a departure itself. */
  servingLines: KvvServingLine[];
  departures: KvvDeparture[];
};

/**
 * A line-direction a stop serves, paired with the line's name. Direction ids are opaque, so this
 * pairing is the only way to name a line with no departure on the board.
 */
export type KvvServingLine = {
  lineId?: string;
  directionId: string;
  transportMode?: TransportMode;
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

/** A published notice in the operator's terms: its line spellings and provider stop ids. */
export type KvvServiceNotice = {
  id: string;
  title: string;
  /** Line numbers as published, normalised to the form a departure states (`007` is line 7). */
  lineNumbers: string[];
  concernedStops: { providerId?: string; name: string }[];
  /** The operator's own wording, as the paragraphs it published it in. */
  details: string[];
  validFrom?: string;
  validUntil?: string;
  priority: "normal" | "high";
};

/**
 * A dated run id: the trip id is reused on later dates, so it is paired with the first
 * scheduled call. Exported so a single-trip reading yields the same id as a board's.
 */
export function getTripInstanceId(
  tripId: string | undefined,
  tripCalls:
    | readonly { scheduledArrivalTime?: string; scheduledDepartureTime?: string }[]
    | undefined,
): string | undefined {
  if (!tripId) return undefined;
  const firstCall = tripCalls?.[0];
  const tripStartTime = firstCall?.scheduledDepartureTime ?? firstCall?.scheduledArrivalTime;
  // To the minute: rows publish the first call to the minute, sequences to the second.
  return tripStartTime ? `${tripId}@${tripStartTime.slice(0, 16)}` : tripId;
}
