import type { Departure, PlatformKind } from "../data/transit-types";
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
export function getExpectedDepartureTime(departure: Departure, feedNow?: number): number {
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
export function sortDeparturesByExpectedTime(
  departures: readonly Departure[],
  feedNow?: number,
): readonly Departure[] {
  return [...departures].sort(
    (left, right) =>
      getExpectedDepartureTime(left, feedNow) - getExpectedDepartureTime(right, feedNow),
  );
}

export type DeparturePlatformGroup = {
  /** As the feed spells it. Empty where the feed named no platform for the trip. */
  platformName: string;
  /** The feed's word for this platform, where every trip leaving from it agrees on one. */
  platformKind?: PlatformKind;
  departures: readonly Departure[];
};

/**
 * The three complete readings of one departure board.
 *
 * Each is the whole board — nothing is hidden and nothing is re-sorted, the rows are only gathered
 * differently — so a rider moving between them is reading the same list a second and third way
 * rather than moving to another view. `time` is what leaves next, `platform` is what leaves from
 * where they are standing, `line` is where each line goes from here.
 */
export type DepartureBoardOrder = "time" | "platform" | "line";

const DEPARTURE_BOARD_ORDERS: readonly DepartureBoardOrder[] = ["time", "platform", "line"];

/**
 * The same board, gathered by the platform each trip leaves from.
 *
 * A rider standing at a stop with six platforms reads the board twice: once for what leaves soonest,
 * and once for what leaves from where they are standing. This is the second reading — nothing is
 * hidden and nothing is re-sorted, the departures of one platform simply stand together, still in
 * the order they leave in. Groups are ordered by platform name rather than by their first departure, so
 * the heading a rider is walking towards stays where it was on the previous refresh; trips the feed
 * named no platform for come last, because a group with no name is nowhere to walk to.
 */
export function groupDeparturesByPlatform(
  departures: readonly Departure[],
): readonly DeparturePlatformGroup[] {
  const groups = new Map<string, Departure[]>();
  for (const departure of departures) {
    const platformName = departure.platformName || "";
    const group = groups.get(platformName);
    if (group) group.push(departure);
    else groups.set(platformName, [departure]);
  }
  return [...groups]
    .map(([platformName, groupedDepartures]) => ({
      platformName,
      platformKind: findSharedPlatformKind(groupedDepartures),
      departures: groupedDepartures,
    }))
    .sort((left, right) => {
      if (!left.platformName || !right.platformName) {
        return Number(Boolean(right.platformName)) - Number(Boolean(left.platformName));
      }
      return compareGermanNames(left.platformName, right.platformName);
    });
}

/**
 * Which of the three orders this rider reads a board in, kept between visits.
 *
 * Grouping is not a passing glance at one board: reading by platform is how somebody who uses a stop
 * with six platforms reads every board, reading by line is how somebody who knows which line they
 * want reads every board, and it is the same rider every day. Re-asking them for it on each visit
 * would make the useful order the one they never see. Time order stays the default, because it is
 * the one a rider who has expressed no preference is asking for.
 */
const DEPARTURE_GROUPING_STORAGE_KEY = "karla:departure-grouping";

/**
 * Storage is unavailable in a private window, when site data is blocked, and inside the artifact
 * sandboxes this page may be viewed in — reading it must never be what stops the app rendering.
 */
function readStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Time order is the default: an unreadable preference is the same as never having set one. */
function readKeptDepartureBoardOrder(): DepartureBoardOrder {
  try {
    const kept = readStorage()?.getItem(DEPARTURE_GROUPING_STORAGE_KEY);
    return DEPARTURE_BOARD_ORDERS.find((order) => order === kept) ?? "time";
  } catch {
    return "time";
  }
}

/**
 * The order in hand, so that a preference storage would not keep is still honoured for this session
 * — and so that reading it is the same value every time rather than a fresh trip to storage.
 */
let currentDepartureBoardOrder: DepartureBoardOrder | undefined;

/**
 * Everything currently reading the preference, so that changing it moves the whole app at once.
 *
 * The order used to be one panel's own state, and could be while it decided nothing but how that
 * panel gathered rows it already had. It now also decides what the board is asked for, and the ask
 * is made above the panel — so the preference is one value the app shares rather than two copies
 * that would disagree for as long as it took a rider to notice.
 */
const departureBoardOrderListeners = new Set<() => void>();

export function readDepartureBoardOrder(): DepartureBoardOrder {
  currentDepartureBoardOrder ??= readKeptDepartureBoardOrder();
  return currentDepartureBoardOrder;
}

export function subscribeToDepartureBoardOrder(listener: () => void): () => void {
  departureBoardOrderListeners.add(listener);
  return () => {
    departureBoardOrderListeners.delete(listener);
  };
}

export function writeDepartureBoardOrder(order: DepartureBoardOrder): void {
  currentDepartureBoardOrder = order;
  try {
    readStorage()?.setItem(DEPARTURE_GROUPING_STORAGE_KEY, order);
  } catch {
    // A preference that cannot be kept is still honoured for this session; nothing here is a claim.
  }
  // Announced whether or not storage took it: a rider who cannot keep the preference still chose it.
  for (const listener of departureBoardOrderListeners) listener();
}
