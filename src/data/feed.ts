/** The provider boundary below `TransitSource`: what the TRIAS feed answers, decoded. */
import { findExpectedDepartureInstant } from "../lib/feed-clock";
import type { StopEventStatus, BayKind, PtMode, Call, VehicleAccess } from "./transit-types";

export type FeedStopEventBoardOptions = {
  limit?: number;
  includeCalls?: boolean;
  /** Line-direction ids (`lineRef`) to filter by. */
  lineIds?: readonly string[];
  eventKind?: "departure" | "arrival";
};

/**
 * What the app reads from the feed.
 * Every method rejects when the provider could not be read.
 */
export interface Feed {
  fetchStopEventBoard(
    stopPointId: string,
    options?: FeedStopEventBoardOptions,
  ): Promise<FeedStopEventBoard>;
  fetchTripInfo(locator: JourneyLocator): Promise<FeedTripInfo>;
  searchStops(query: string): Promise<FeedStopSearchResult[]>;
  /** A line-direction's stops, addressed through one of its dated journeys. */
  fetchLineRoute(locator: JourneyLocator): Promise<FeedCall[]>;
}

/** A calling point as the feed states it, still carrying the provider stop id it was read from. */
export type FeedCall = Call & { providerId?: string };

/**
 * The provider tuple that identifies one dated journey; every field is copied from its board row.
 */
export type JourneyLocator = {
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

export type FeedTripInfo = {
  serverTime: string;
  calls: FeedCall[];
  /** Only exceptional whole-journey states override the fresher stop-specific DM row. */
  status?: Extract<StopEventStatus, "cancelled" | "diverted">;
};

export type FeedStopEvent = {
  /** Provider stop point the vehicle departs from; a stop place reports several of these. */
  stopPointId: string;
  stopPointName: string;
  /** The timetable-journey identity, TRIAS's `JourneyRef`. */
  journeyRef?: string;
  /** Dated identity, for matching older shared links and deduplicating operating instances. */
  datedJourneyId?: string;
  /** The train number (`PublishedJourneyNumber`), shared where two separately addressed portions run as one. */
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
  /** The prediction is stated to the second; some pools state whole minutes. */
  isEstimatedToTheSecond?: boolean;
  serviceNote?: string;
  /** What the feed states about boarding this vehicle, where it states anything at all. */
  vehicleAccess?: VehicleAccess;
  /** Opaque provider state used below `TransitSource` to load only this journey. */
  journeyLocator?: JourneyLocator;
  calls?: FeedCall[];
};

export type FeedStopEventBoard = {
  stopPointId: string;
  stopName: string;
  /** Server time of the feed, so countdowns are anchored to the source, not the browser clock. */
  serverTime: string;
  stopEvents: FeedStopEvent[];
};

export type FeedStopSearchResult = {
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

const getExpectedInstant = (stopEvent: FeedStopEvent): number =>
  findExpectedDepartureInstant(
    stopEvent.timetabledDepartureTime,
    stopEvent.estimatedDepartureTime,
    stopEvent.delayMinutes,
  ) ?? Number.POSITIVE_INFINITY;

/**
 * Boards read apart (a stop place's stop points, a line filter split across requests) as one. A
 * board that answered `limit` rows may have more after its last, so the joined board ends there:
 * past it, only the quieter boards' rows would show.
 */
export function joinStopEventBoards(
  boards: readonly FeedStopEventBoard[],
  limit: number,
): FeedStopEventBoard {
  if (boards.length === 1) return boards[0];
  const end = Math.min(
    ...boards
      .filter(({ stopEvents }) => stopEvents.length >= limit)
      .map(({ stopEvents }) => Math.max(...stopEvents.map(getExpectedInstant))),
  );
  return {
    ...boards[0],
    stopEvents: boards
      .flatMap(({ stopEvents }) => stopEvents)
      .filter((stopEvent) => getExpectedInstant(stopEvent) <= end),
  };
}

/** A stop place's board: each of its stop points read, and joined. */
export async function fetchStopPlaceBoard(
  feed: Feed,
  stopPoints: readonly string[],
  options: FeedStopEventBoardOptions & { limit: number },
): Promise<FeedStopEventBoard> {
  const boards = await Promise.all(
    stopPoints.map((stopPointId) => feed.fetchStopEventBoard(stopPointId, options)),
  );
  return joinStopEventBoards(boards, options.limit);
}
