import type { KvvDeparture } from "./kvv-efa-parsers";
import type { Departure } from "./transit-types";
import { getExpectedDepartureTime } from "../lib/departure-order";

/** Whether a departure is expected inside a window, read against the feed's clock. */
export function isDepartureWithin(departure: Departure, from: number, until: number): boolean {
  const expected = getExpectedDepartureTime(departure, from);
  return expected >= from && expected <= until;
}

/**
 * What names one run across two readings of it, where the feed states enough to be sure.
 *
 * The trip id cannot answer this: a line-filtered completion comes back with the same run under a
 * trip id differing from the plain board's in a single segment, so a merge keyed by it publishes
 * that run twice — once with a prediction and once without, which is one vehicle claiming two
 * times on one board. What both readings agree on is the operator's own train number, and with the
 * line, the destination, the platform and the published minute beside it that names the run rather
 * than the reading of it.
 *
 * Deliberately answers nothing where the feed numbered no run, so such a departure is merged by its
 * id exactly as before rather than by a description `createDepartureId` has already refused. Joined
 * portions share a train number but never a destination, so they are never folded into one row.
 */
export function findRunKey(departure: Departure): string | undefined {
  if (!departure.trainNumber) return undefined;
  return [
    departure.trainNumber,
    departure.lineId,
    departure.destination,
    departure.platformName,
    departure.scheduledDepartureTime,
  ].join("|");
}

/**
 * One row per run, keeping the reading that carries a prediction.
 *
 * The monitor answers with the same run twice, under two trip ids differing in a single segment
 * and stating the same operator train number — the S5 to Pforzheim published at 12:05 from Gleis 2
 * comes back once as scheduled and once running six minutes down. Both are the same vehicle, so
 * left as they are the board publishes two times for it, which is the one thing a row may never do.
 * The reading with a prediction is the statement about the vehicle and is the one kept; where
 * neither has one there is nothing to choose between them, and the feed's own order decides.
 */
export function keepOneRowPerRun(departures: readonly Departure[]): Departure[] {
  const indexByRunKey = new Map<string, number>();
  const kept: Departure[] = [];
  for (const departure of departures) {
    const runKey = findRunKey(departure);
    const knownIndex = runKey === undefined ? undefined : indexByRunKey.get(runKey);
    if (knownIndex === undefined) {
      if (runKey !== undefined) indexByRunKey.set(runKey, kept.length);
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
 * Collects the runs of one reading so a second reading can complete it without restating any.
 *
 * The live board is the fresher statement wherever both saw the same trip, so it is laid down
 * first and nothing completing it may state one of its runs a second time — under the trip id a
 * filtered reading happens to have given that run, it would stand beside itself.
 */
export function createRunCollector(base: readonly Departure[]) {
  const departureById = new Map<string, Departure>();
  const runKeys = new Set<string>();
  for (const departure of base) {
    departureById.set(departure.id, departure);
    const runKey = findRunKey(departure);
    if (runKey) runKeys.add(runKey);
  }
  return {
    departureById: departureById as ReadonlyMap<string, Departure>,
    /** Adds a departure unless the run it names has already been stated; says whether it was added. */
    add(departure: Departure): boolean {
      const runKey = findRunKey(departure);
      if (runKey) {
        if (runKeys.has(runKey)) return false;
        runKeys.add(runKey);
      }
      departureById.set(departure.id, departure);
      return true;
    },
  };
}

/**
 * What makes one departure on a board different from every other one on it.
 *
 * The trip is the identity, and the feed's own trip id is the only thing that carries it: a line,
 * a platform, a destination and a scheduled minute do not. Two S8 to Tullastraße leave Augartenstraße
 * Gleis 2 scheduled on the same minute — one delayed three minutes, one not — and describing them
 * by what they look like gave both the same id. That is a rider selecting one and lighting both,
 * a cancelled trip finding itself as its own replacement, and two React rows under one key, which
 * is how a row ends up drawn somewhere its time does not put it.
 *
 * The trip id is used rather than `tripInstanceId` because the latter is refined by the trip's
 * first call, which only a detailed board carries: an id must not change when the same board is
 * fetched with calling sequences. The scheduled minute stays in it so a trip id the operator reuses
 * later in the day is still two departures. Where the feed names no trip at all, the description is
 * all there is, and it is kept as the fallback it always was.
 */
export function createDepartureId(departure: KvvDeparture, stopId: string): string {
  const tripIdentity =
    departure.tripId ?? `${departure.lineId}-${departure.platformName}-${departure.destination}`;
  return `${stopId}-${tripIdentity}-${departure.scheduledDepartureTime}`;
}
