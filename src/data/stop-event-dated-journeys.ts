import type { KvvStopEvent } from "./kvv-feed";
import type { StopEvent } from "./transit-types";
import { getExpectedDepartureInstant } from "../lib/stop-event-order";

/** Whether a departure is expected inside a window, read against the feed's clock. */
export function isStopEventWithin(stopEvent: StopEvent, from: number, until: number): boolean {
  const expected = getExpectedDepartureInstant(stopEvent, from);
  return expected >= from && expected <= until;
}

/**
 * A key naming one dated journey across readings: train number, line, destination, bay and
 * published minute. Journey ids differ by a segment between plain and filtered boards, so they
 * cannot. Nothing where the feed numbered no dated journey. Joined portions share a number but
 * never a destination.
 */
export function getBoardRowKey(stopEvent: StopEvent): string | undefined {
  if (!stopEvent.publishedJourneyNumber) return undefined;
  return [
    stopEvent.publishedJourneyNumber,
    stopEvent.lineId,
    stopEvent.destinationText,
    stopEvent.bay,
    stopEvent.timetabledDepartureTime,
  ].join("|");
}

/**
 * One row per dated journey, preferring the reading with a prediction: the monitor can return a
 * dated journey twice under journey ids differing by one segment (S5 to Pforzheim, 12:05 Gleis 2,
 * once on time, once six minutes late). Without predictions, the feed's order decides.
 */
export function keepOneRowPerDatedJourney(stopEvents: readonly StopEvent[]): StopEvent[] {
  const indexByDatedJourneyKey = new Map<string, number>();
  const kept: StopEvent[] = [];
  for (const stopEvent of stopEvents) {
    const boardRowKey = getBoardRowKey(stopEvent);
    const knownIndex =
      boardRowKey === undefined ? undefined : indexByDatedJourneyKey.get(boardRowKey);
    if (knownIndex === undefined) {
      if (boardRowKey !== undefined) indexByDatedJourneyKey.set(boardRowKey, kept.length);
      kept.push(stopEvent);
      continue;
    }
    if (kept[knownIndex].delayMinutes === undefined && stopEvent.delayMinutes !== undefined) {
      kept[knownIndex] = stopEvent;
    }
  }
  return kept;
}

/**
 * Collects one reading's dated journeys so a second reading can complete it without restating any.
 * The live board goes first, being fresher.
 */
export function createDatedJourneyCollector(base: readonly StopEvent[]) {
  const stopEventById = new Map<string, StopEvent>();
  const boardRowKeys = new Set<string>();
  for (const stopEvent of base) {
    stopEventById.set(stopEvent.id, stopEvent);
    const boardRowKey = getBoardRowKey(stopEvent);
    if (boardRowKey) boardRowKeys.add(boardRowKey);
  }
  return {
    stopEventById: stopEventById as ReadonlyMap<string, StopEvent>,
    /**
     * Adds a departure unless its dated journey is already stated; returns whether it was added.
     */
    add(stopEvent: StopEvent): boolean {
      const boardRowKey = getBoardRowKey(stopEvent);
      if (boardRowKey) {
        if (boardRowKeys.has(boardRowKey)) return false;
        boardRowKeys.add(boardRowKey);
      }
      stopEventById.set(stopEvent.id, stopEvent);
      return true;
    },
  };
}

/**
 * A departure's id on a board: the feed's journey id plus the timetabled minute (journey ids recur
 * later in the day). A description is not unique (two S8 to Tullastraße leave Augartenstraße Gleis
 * 2 on the same minute), so it is only the fallback without a journey id. Not `datedJourneyId`,
 * which changes once a detailed board adds calls.
 */
export function createStopEventId(stopEvent: KvvStopEvent, stopId: string): string {
  const journeyIdentity =
    stopEvent.journeyRef ?? `${stopEvent.lineId}-${stopEvent.bay}-${stopEvent.destinationText}`;
  return `${stopId}-${journeyIdentity}-${stopEvent.timetabledDepartureTime}`;
}
