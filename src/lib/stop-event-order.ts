import type { StopEvent, BayKind } from "../data/transit-types";
import { findBoardingPlace, type BoardingPlace, type StopBoardingPlaces } from "./boarding-places";
import { findExpectedDepartureInstant } from "./feed-clock";
import { findSharedBayKind } from "./bay-naming";
import { compareGermanNames } from "./text";

/**
 * Boards in the order vehicles leave: expected time, not the feed's schedule order, so countdowns
 * never read 7, 3, 5.
 */

/**
 * The instant a departure is expected at; a cancelled journey uses its schedule. `feedNow` is used
 * only where there is no schedule; without it such a departure sorts last.
 */
export function getExpectedDepartureInstant(stopEvent: StopEvent, feedNow?: number): number {
  const timetabled = Date.parse(stopEvent.timetabledDepartureTime);
  if (!Number.isFinite(timetabled)) {
    return feedNow === undefined
      ? Number.POSITIVE_INFINITY
      : feedNow + stopEvent.minutesUntilDeparture * 60_000;
  }
  // The instant the row publishes, prediction included, so order matches the printed times.
  if (stopEvent.status === "cancelled") return timetabled;
  return (
    findExpectedDepartureInstant(
      stopEvent.timetabledDepartureTime,
      stopEvent.estimatedDepartureTime,
      stopEvent.delayMinutes,
    ) ?? timetabled
  );
}

/** The board in expected order; stable, so untimed departures keep the feed's order. */
export function sortStopEventsByExpectedInstant(
  stopEvents: readonly StopEvent[],
  feedNow?: number,
): readonly StopEvent[] {
  return [...stopEvents].sort(
    (left, right) =>
      getExpectedDepartureInstant(left, feedNow) - getExpectedDepartureInstant(right, feedNow),
  );
}

export type StopEventBayGroup = {
  /** As the feed spells it; empty where none. */
  bay: string;
  /** The bay kind, where every journey from it agrees. */
  bayKind?: BayKind;
  stopEvents: readonly StopEvent[];
};

/**
 * The board grouped by bay, each group in departure order. Groups sort by bay code so
 * headings do not move between refreshes; journeys without a bay come last.
 */
export function groupStopEventsByBay(
  stopEvents: readonly StopEvent[],
): readonly StopEventBayGroup[] {
  const groups = new Map<string, StopEvent[]>();
  for (const stopEvent of stopEvents) {
    const bay = stopEvent.bay || "";
    const group = groups.get(bay);
    if (group) group.push(stopEvent);
    else groups.set(bay, [stopEvent]);
  }
  return [...groups]
    .map(([bay, groupedStopEvents]) => ({
      bay,
      bayKind: findSharedBayKind(groupedStopEvents),
      stopEvents: groupedStopEvents,
    }))
    .sort((left, right) => {
      if (!left.bay || !right.bay) {
        return Number(Boolean(right.bay)) - Number(Boolean(left.bay));
      }
      return compareGermanNames(left.bay, right.bay);
    });
}

/** A boarding place's bays. */
export type StopEventBoardingPlaceGroup = {
  /** `undefined` at a single-place stop. */
  boardingPlace: BoardingPlace | undefined;
  bayGroups: readonly StopEventBayGroup[];
};

/**
 * The bay groups under their boarding places (Europaplatz's `Gleis 3` and `Gleis 5` are 100 m
 * apart; `Gleis 1(U)` is underground). A single-place stop reads as one unheaded group.
 */
export function groupStopEventsByBoardingPlace(
  stopEvents: readonly StopEvent[],
  boardingPlaces: StopBoardingPlaces,
): readonly StopEventBoardingPlaceGroup[] {
  if (boardingPlaces.length < 2)
    return [{ boardingPlace: undefined, bayGroups: groupStopEventsByBay(stopEvents) }];

  const byPlaceId = new Map<string, StopEvent[]>();
  const unplaced: StopEvent[] = [];
  for (const stopEvent of stopEvents) {
    const place = findBoardingPlace(boardingPlaces, stopEvent);
    if (!place) {
      unplaced.push(stopEvent);
      continue;
    }
    const gathered = byPlaceId.get(place.id);
    if (gathered) gathered.push(stopEvent);
    else byPlaceId.set(place.id, [stopEvent]);
  }

  const groups = boardingPlaces.flatMap((boardingPlace) => {
    const gathered = byPlaceId.get(boardingPlace.id);
    return gathered ? [{ boardingPlace, bayGroups: groupStopEventsByBay(gathered) }] : [];
  });
  // Rows no place accounts for are kept, under no place.
  return unplaced.length > 0
    ? [...groups, { boardingPlace: undefined, bayGroups: groupStopEventsByBay(unplaced) }]
    : groups;
}
