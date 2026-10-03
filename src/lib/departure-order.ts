import type { Departure, PlatformKind } from "../data/transit-types";
import { findBoardingPlace, type BoardingPlace, type StopBoardingPlaces } from "./boarding-places";
import { findExpectedDepartureInstant } from "./feed-clock";
import { findSharedPlatformKind } from "./platform-naming";
import { compareGermanNames } from "./text";

/**
 * Boards in the order vehicles leave: expected time, not the feed's schedule order, so countdowns
 * never read 7, 3, 5.
 */

/**
 * The instant a departure is expected at; a cancelled trip uses its schedule. `feedNow` is used
 * only where there is no schedule; without it such a departure sorts last.
 */
export function getExpectedDepartureInstant(departure: Departure, feedNow?: number): number {
  const scheduled = Date.parse(departure.scheduledDepartureTime);
  if (!Number.isFinite(scheduled)) {
    return feedNow === undefined
      ? Number.POSITIVE_INFINITY
      : feedNow + departure.minutesUntilDeparture * 60_000;
  }
  // The instant the row publishes, prediction included, so order matches the printed times.
  if (departure.status === "cancelled") return scheduled;
  return (
    findExpectedDepartureInstant(
      departure.scheduledDepartureTime,
      departure.predictedDepartureTime,
      departure.delayMinutes,
    ) ?? scheduled
  );
}

/** The board in expected order; stable, so untimed departures keep the feed's order. */
export function sortDeparturesByExpectedInstant(
  departures: readonly Departure[],
  feedNow?: number,
): readonly Departure[] {
  return [...departures].sort(
    (left, right) =>
      getExpectedDepartureInstant(left, feedNow) - getExpectedDepartureInstant(right, feedNow),
  );
}

export type DeparturePlatformGroup = {
  /** As the feed spells it; empty where none. */
  platformCode: string;
  /** The platform kind, where every trip from it agrees. */
  platformKind?: PlatformKind;
  departures: readonly Departure[];
};

/**
 * The board grouped by platform, each group in departure order. Groups sort by platform code so
 * headings do not move between refreshes; trips without a platform come last.
 */
export function groupDeparturesByPlatform(
  departures: readonly Departure[],
): readonly DeparturePlatformGroup[] {
  const groups = new Map<string, Departure[]>();
  for (const departure of departures) {
    const platformCode = departure.platformCode || "";
    const group = groups.get(platformCode);
    if (group) group.push(departure);
    else groups.set(platformCode, [departure]);
  }
  return [...groups]
    .map(([platformCode, groupedDepartures]) => ({
      platformCode,
      platformKind: findSharedPlatformKind(groupedDepartures),
      departures: groupedDepartures,
    }))
    .sort((left, right) => {
      if (!left.platformCode || !right.platformCode) {
        return Number(Boolean(right.platformCode)) - Number(Boolean(left.platformCode));
      }
      return compareGermanNames(left.platformCode, right.platformCode);
    });
}

/** A boarding place's platforms. */
export type DepartureBoardingPlaceGroup = {
  /** `undefined` at a single-place stop. */
  boardingPlace: BoardingPlace | undefined;
  platformGroups: readonly DeparturePlatformGroup[];
};

/**
 * The platform groups under their boarding places (Europaplatz's `Gleis 3` and `Gleis 5` are 100 m
 * apart; `Gleis 1(U)` is underground). A single-place stop reads as one unheaded group.
 */
export function groupDeparturesByBoardingPlace(
  departures: readonly Departure[],
  boardingPlaces: StopBoardingPlaces,
): readonly DepartureBoardingPlaceGroup[] {
  if (boardingPlaces.length < 2)
    return [{ boardingPlace: undefined, platformGroups: groupDeparturesByPlatform(departures) }];

  const byPlaceId = new Map<string, Departure[]>();
  const unplaced: Departure[] = [];
  for (const departure of departures) {
    const place = findBoardingPlace(boardingPlaces, departure);
    if (!place) {
      unplaced.push(departure);
      continue;
    }
    const gathered = byPlaceId.get(place.id);
    if (gathered) gathered.push(departure);
    else byPlaceId.set(place.id, [departure]);
  }

  const groups = boardingPlaces.flatMap((boardingPlace) => {
    const gathered = byPlaceId.get(boardingPlace.id);
    return gathered ? [{ boardingPlace, platformGroups: groupDeparturesByPlatform(gathered) }] : [];
  });
  // Rows no place accounts for are kept, under no place.
  return unplaced.length > 0
    ? [...groups, { boardingPlace: undefined, platformGroups: groupDeparturesByPlatform(unplaced) }]
    : groups;
}
