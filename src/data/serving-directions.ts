/**
 * The line-directions a stop is served by, learned from the dated journeys read: each dated
 * journey's direction counts for every stop it calls at, so a board at one stop teaches the stops
 * its dated journeys pass. TRIAS states no serving lines.
 */
import type { StopEvent, ServingLine } from "./transit-types";

/**
 * How long one observed dated journey keeps a direction serving a stop: past an hourly line's gap.
 */
export const SERVING_DIRECTION_TTL_MS = 6 * 60 * 60_000;

export class ServingDirections {
  private readonly byStopId = new Map<string, Map<string, { line: ServingLine; seenAt: number }>>();

  remember(stopEvents: readonly StopEvent[], now = Date.now()): void {
    for (const stopEvent of stopEvents) {
      const { lineRef, lineId, ptMode, status } = stopEvent;
      // A cancelled dated journey does not call where it was timetabled to.
      if (!lineRef || status === "cancelled") continue;
      const line: ServingLine = { lineId, lineRef, ptMode };
      const stopIds = new Set([
        stopEvent.boardingLocalStopId,
        ...(stopEvent.calls ?? []).map(({ localStopId }) => localStopId),
      ]);
      for (const stopId of stopIds) {
        if (!stopId) continue;
        const directions = this.byStopId.get(stopId) ?? new Map();
        directions.set(lineRef, { line, seenAt: now });
        this.byStopId.set(stopId, directions);
      }
    }
  }

  /** The directions met here within the TTL, in the order first met. */
  find(stopId: string, now = Date.now()): ServingLine[] {
    const directions = this.byStopId.get(stopId);
    if (!directions) return [];
    for (const [lineRef, { seenAt }] of directions) {
      if (now - seenAt > SERVING_DIRECTION_TTL_MS) directions.delete(lineRef);
    }
    return [...directions.values()].map(({ line }) => line);
  }
}
