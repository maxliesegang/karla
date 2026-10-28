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
  /** The dated journey's calls; `rowCall` names the one the asking row was read at. */
  fetchTripInfo(journey: DatedJourneyRef, rowCall?: RowCallRef): Promise<FeedTripInfo>;
  searchStops(query: string): Promise<FeedStopSearchResult[]>;
  /** A line-direction's stops, addressed through one of its dated journeys. */
  fetchLineRoute(journey: DatedJourneyRef): Promise<FeedCall[]>;
}

/** A call as the feed states it: its stop point, not yet resolved to a stop place. */
export type FeedCall = Call;

/** One dated journey, as TRIAS addresses it: its `JourneyRef` on its `OperatingDayRef`. */
export type DatedJourneyRef = { journeyRef: string; operatingDayRef: string };

/** A row's own call: its stop point and timetabled instant, which tell a double call apart. */
export type RowCallRef = { stopPointId: string; timetabledTime: string };

export type FeedTripInfo = {
  serverTime: string;
  calls: FeedCall[];
  /** Only exceptional whole-journey states override the fresher stop-specific row. */
  status?: Extract<StopEventStatus, "cancelled" | "diverted">;
};

export type FeedStopEvent = {
  /** The stop point the vehicle departs from; a stop place reports several of these. */
  stopPointId: string;
  stopPointName: string;
  /** The timetable-journey identity, TRIAS's `JourneyRef`. */
  journeyRef?: string;
  /** TRIAS's `OperatingDayRef` (`YYYY-MM-DD`), which differs from the calendar day after midnight. */
  operatingDayRef?: string;
  /** `journeyRef@operatingDayRef` (`getDatedJourneyId`). */
  datedJourneyId?: string;
  /** The train number (`PublishedJourneyNumber`), shared where two separately addressed portions run as one. */
  publishedJourneyNumber?: string;
  lineId: string;
  /** Opaque identity for this line and operating direction (`kvv:21005:E:R:s26`). */
  lineRef: string;
  ptMode: PtMode;
  destinationText: string;
  /** TRIAS's `OriginStopPointRef` and `DestinationStopPointRef`, as DHIDs. */
  originStopPointId?: string;
  destinationStopPointId?: string;
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
  stopPointId: string;
  name: string;
  /** The municipality the stop is in, as the feed states it. */
  placeName?: string;
  /** Where the stop stands, so the source can tell what is inside the network's area. */
  latitude?: number;
  longitude?: number;
};

/** A dated journey's id: its journey, which repeats daily, on its operating day. */
export const getDatedJourneyId = ({ journeyRef, operatingDayRef }: DatedJourneyRef): string =>
  `${journeyRef}@${operatingDayRef}`;

const OPERATING_DAY_REF_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** An `OperatingDayRef` as TRIAS states it: `YYYY-MM-DD`. */
export const isOperatingDayRef = (value: string): boolean => OPERATING_DAY_REF_PATTERN.test(value);

/** `getDatedJourneyId` read back; none for an id that names no operating day. */
export function parseDatedJourneyId(id: string): DatedJourneyRef | undefined {
  const separator = id.lastIndexOf("@");
  const operatingDayRef = id.slice(separator + 1);
  return separator > 0 && isOperatingDayRef(operatingDayRef)
    ? { journeyRef: id.slice(0, separator), operatingDayRef }
    : undefined;
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
