import type { Departure, PlatformKind } from "../data/transit-types";
import { findBoardingPlace, type BoardingPlace, type StopBoardingPlaces } from "./boarding-places";
import { findExpectedDepartureInstant } from "./feed-clock";
import { findSharedPlatformKind } from "./platform-naming";
import { compareGermanNames } from "./text";

/**
 * The order a board is read in, which is the order a rider catches the vehicles.
 *
 * The feed answers in schedule order, but every countdown on the board is counted from the schedule
 * *plus its deviation* (`lib/feed-clock.ts`). Left in the feed's order a delayed tram sits above one
 * that will leave before it, and the countdown column reads 7, 3, 5 — three true numbers in an
 * order that says something false about which vehicle leaves first.
 */

/**
 * The instant a departure is actually expected at. A cancelled trip has no deviation to apply, for
 * the same reason its row publishes no expected time: it is expected nowhere.
 *
 * `feedNow` is consulted only for a departure the feed gave no schedule for, where the stated
 * countdown is all there is; without it such a departure sorts last rather than being given a time
 * the feed never stated.
 */
export function getExpectedDepartureInstant(departure: Departure, feedNow?: number): number {
  const scheduled = Date.parse(departure.scheduledDepartureTime);
  if (!Number.isFinite(scheduled)) {
    return feedNow === undefined
      ? Number.POSITIVE_INFINITY
      : feedNow + departure.minutesUntilDeparture * 60_000;
  }
  // The same instant the row publishes and its countdown is read from, prediction included: sorted
  // by the stated deviation instead, two rows a minute apart can sit in the opposite order to the
  // times printed on them.
  if (departure.status === "cancelled") return scheduled;
  return (
    findExpectedDepartureInstant(
      departure.scheduledDepartureTime,
      departure.predictedDepartureTime,
      departure.delayMinutes,
    ) ?? scheduled
  );
}

/**
 * The board in expected-departure order. Stable, so departures the feed states no time for keep the
 * order it listed them in rather than shuffling between refreshes.
 */
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
  /** As the feed spells it. Empty where the feed named no platform for the trip. */
  platformCode: string;
  /** The feed's word for this platform, where every trip leaving from it agrees on one. */
  platformKind?: PlatformKind;
  departures: readonly Departure[];
};

/**
 * The same board, gathered by the platform each trip leaves from.
 *
 * A rider standing at a stop with six platforms reads the board twice: once for what leaves soonest,
 * and once for what leaves from where they are standing. This is the second reading — nothing is
 * hidden and nothing is re-sorted, the departures of one platform simply stand together, still in
 * the order they leave in. Groups are ordered by platform code rather than by their first departure, so
 * the heading a rider is walking towards stays where it was on the previous refresh; trips the feed
 * named no platform for come last, because a group with no name is nowhere to walk to.
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

/** The platforms of one place to stand, under the place a rider walks to before reading them. */
export type DepartureBoardingPlaceGroup = {
  /** `undefined` at a stop that is one place, which is nearly every stop. */
  boardingPlace: BoardingPlace | undefined;
  platformGroups: readonly DeparturePlatformGroup[];
};

/**
 * The platform reading, given the level between a stop and its platforms.
 *
 * A rider reading by platform is asking which way to walk, and at Europaplatz or Marktplatz the
 * platform code alone cannot answer it: `Gleis 3` and `Gleis 5` are a hundred metres apart under
 * one name, and `Gleis 1(U)` is under the street. So the platforms stand beneath the place they
 * belong to, and the place is what the rider chooses between first.
 *
 * A stop with one place — nearly every stop — reads exactly as it always did: one group carrying no
 * heading of its own, and the platform signposts underneath it unchanged.
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
  // A row the places could not account for is still a departure, and is never dropped: it reads
  // under no place at all, exactly as it would at a stop that has none.
  return unplaced.length > 0
    ? [...groups, { boardingPlace: undefined, platformGroups: groupDeparturesByPlatform(unplaced) }]
    : groups;
}
