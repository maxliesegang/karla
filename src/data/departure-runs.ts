import type { KvvDeparture } from "./kvv-efa-parsers";
import type { Departure } from "./transit-types";
import { getExpectedDepartureInstant } from "../lib/departure-order";

/** Whether a departure is expected inside a window, read against the feed's clock. */
export function isDepartureWithin(departure: Departure, from: number, until: number): boolean {
  const expected = getExpectedDepartureInstant(departure, from);
  return expected >= from && expected <= until;
}

/**
 * A key naming one run across readings: train number, line, destination, platform and published
 * minute. Trip ids differ by a segment between plain and filtered boards, so they cannot. Nothing
 * where the feed numbered no run. Joined portions share a number but never a destination.
 */
export function getBoardRowKey(departure: Departure): string | undefined {
  if (!departure.trainNumber) return undefined;
  return [
    departure.trainNumber,
    departure.lineId,
    departure.destination,
    departure.platformCode,
    departure.scheduledDepartureTime,
  ].join("|");
}

/**
 * One row per run, preferring the reading with a prediction: the monitor can return a run twice
 * under trip ids differing by one segment (S5 to Pforzheim, 12:05 Gleis 2, once on time, once six
 * minutes late). Without predictions, the feed's order decides.
 */
export function keepOneRowPerRun(departures: readonly Departure[]): Departure[] {
  const indexByRunKey = new Map<string, number>();
  const kept: Departure[] = [];
  for (const departure of departures) {
    const boardRowKey = getBoardRowKey(departure);
    const knownIndex = boardRowKey === undefined ? undefined : indexByRunKey.get(boardRowKey);
    if (knownIndex === undefined) {
      if (boardRowKey !== undefined) indexByRunKey.set(boardRowKey, kept.length);
      kept.push(departure);
      continue;
    }
    if (kept[knownIndex].delayMinutes === undefined && departure.delayMinutes !== undefined) {
      kept[knownIndex] = departure;
    }
  }
  return kept;
}

/**
 * Collects one reading's runs so a second reading can complete it without restating any. The live
 * board goes first, being fresher.
 */
export function createRunCollector(base: readonly Departure[]) {
  const departureById = new Map<string, Departure>();
  const boardRowKeys = new Set<string>();
  for (const departure of base) {
    departureById.set(departure.id, departure);
    const boardRowKey = getBoardRowKey(departure);
    if (boardRowKey) boardRowKeys.add(boardRowKey);
  }
  return {
    departureById: departureById as ReadonlyMap<string, Departure>,
    /** Adds a departure unless its run is already stated; returns whether it was added. */
    add(departure: Departure): boolean {
      const boardRowKey = getBoardRowKey(departure);
      if (boardRowKey) {
        if (boardRowKeys.has(boardRowKey)) return false;
        boardRowKeys.add(boardRowKey);
      }
      departureById.set(departure.id, departure);
      return true;
    },
  };
}

/**
 * A departure's id on a board: the feed's trip id plus the scheduled minute (trip ids recur later
 * in the day). A description is not unique (two S8 to Tullastraße leave Augartenstraße Gleis 2 on
 * the same minute), so it is only the fallback without a trip id. Not `tripInstanceId`, which
 * changes once a detailed board adds calls.
 */
export function createDepartureId(departure: KvvDeparture, stopId: string): string {
  const tripIdentity =
    departure.tripId ?? `${departure.lineId}-${departure.platformCode}-${departure.destination}`;
  return `${stopId}-${tripIdentity}-${departure.scheduledDepartureTime}`;
}
