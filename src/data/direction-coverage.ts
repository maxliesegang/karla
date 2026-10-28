import type {
  StopEvent,
  StopEventBoard,
  StopEventBoardRequest,
  LiveStopEventBoard,
} from "./transit-types";
import { createDatedJourneyCollector, isStopEventWithin } from "./stop-event-dated-journeys";
import { sortStopEventsByExpectedInstant } from "../lib/stop-event-order";
import { ReadingCache } from "./reading-cache";

/** One supplement serves every sparse direction, so it gets more rows. */
const DIRECTION_SUPPLEMENT_LIMIT = 40;
/**
 * Filtered passes per completion; each asks for fewer directions, and the cap stops endless
 * retries.
 */
const MAX_DIRECTION_SUPPLEMENT_PASSES = 3;
/** How long a supplement stands: an hourly bus found once still leaves at the same minute. */
const DIRECTION_SUPPLEMENT_TTL_MS = 5 * 60_000;
const DIRECTION_CACHE_CAPACITY = 256;
const SERVING_DIRECTIONS_MAX_AGE_MS = 30 * 60_000;
const DEFAULT_DIRECTION_COVERAGE_HORIZON_MS = 2 * 60 * 60_000;

/**
 * The completion a request asks for, read once; nothing where none is wanted or calls make it too
 * heavy.
 */
export type DirectionCoverage = { minimum: number; horizonMs: number; key: string };

export function readDirectionCoverage(
  request: StopEventBoardRequest,
): DirectionCoverage | undefined {
  const requested = request.minimumStopEventsPerDirection ?? 0;
  if (request.includeCalls || requested <= 0) return undefined;
  const minimum = Math.max(1, Math.floor(requested));
  const horizonMs = Math.max(0, request.coverageHorizonMs ?? DEFAULT_DIRECTION_COVERAGE_HORIZON_MS);
  return { minimum, horizonMs, key: `${minimum}:${horizonMs}` };
}

/** One filtered read of a stop, as the completion asks for it. */
type FetchSupplement = (
  lineIds: readonly string[],
  limit: number,
) => Promise<{ stopEvents: readonly StopEvent[]; rowLimitReached: boolean }>;

/**
 * Completes a basic board so the line overview can answer "what runs here?". Candidates come from
 * the monitor's metadata; only returned rows are shown. Supplements live on their own TTL, or a
 * stop with hourly lines would re-ask every refresh. Held rows show only for departures further
 * away than the reading is old; expired supplements drop, failed passes add nothing.
 */
export class DirectionCoverageCompleter {
  /** Query candidates from the monitor's metadata; never shown without a live row. */
  private readonly servingLineRefsByStopId = new ReadingCache<readonly string[]>(
    DIRECTION_CACHE_CAPACITY,
    SERVING_DIRECTIONS_MAX_AGE_MS,
  );
  /** The short-lived supplements for directions the board missed. */
  private readonly supplements = new ReadingCache<{
    receivedAt: number;
    stopEvents: readonly StopEvent[];
  }>(DIRECTION_CACHE_CAPACITY, DIRECTION_SUPPLEMENT_TTL_MS);

  /** What the stop's unfiltered board says it serves; a filtered board would shrink the set. */
  rememberServingDirections(stopId: string, lineRefs: readonly string[]): void {
    this.servingLineRefsByStopId.set(stopId, lineRefs);
  }

  /**
   * `readingId` is what the board reads: the stop (`rememberServingDirections`'s id) or one part of
   * it, which has supplements of its own and no serving directions.
   */
  async complete(
    readingId: string,
    base: LiveStopEventBoard,
    coverage: DirectionCoverage,
    fetchSupplement: FetchSupplement,
  ): Promise<StopEventBoard> {
    const { minimum, horizonMs, key: coverageKey } = coverage;
    const feedNow = Date.parse(base.feedUpdatedAt);
    if (!Number.isFinite(feedNow)) return base;

    const candidates = [
      ...new Set([
        ...(this.servingLineRefsByStopId.get(readingId) ?? []),
        ...base.stopEvents.flatMap(({ lineRef }) => (lineRef ? [lineRef] : [])),
      ]),
    ];
    if (candidates.length === 0) return base;

    const supplementKey = `${readingId}:${coverageKey}`;
    const held = this.supplements.get(supplementKey);
    const heldAgeMs = held ? Date.now() - held.receivedAt : Number.POSITIVE_INFINITY;
    const isHeldReadable = heldAgeMs < DIRECTION_SUPPLEMENT_TTL_MS;

    const collected = createDatedJourneyCollector(base.stopEvents);
    if (isHeldReadable && held) {
      for (const stopEvent of held.stopEvents) {
        if (isStopEventWithin(stopEvent, feedNow + heldAgeMs, feedNow + horizonMs)) {
          collected.add(stopEvent);
        }
      }
    }

    // One pass over the departures, not one per direction; re-run after every read.
    const getMissing = () => {
      const coveredByDirection = new Map<string, number>();
      for (const stopEvent of collected.stopEventById.values()) {
        const lineRef = stopEvent.lineRef;
        if (!lineRef || !isStopEventWithin(stopEvent, feedNow, feedNow + horizonMs)) continue;
        coveredByDirection.set(lineRef, (coveredByDirection.get(lineRef) ?? 0) + 1);
      }
      return candidates.filter((lineRef) => (coveredByDirection.get(lineRef) ?? 0) < minimum);
    };

    if (isHeldReadable)
      return this.toCoveredBoard(base, collected.stopEventById, feedNow, horizonMs);

    let missing = getMissing();
    if (missing.length === 0) return base;

    const supplemented: StopEvent[] = [];
    try {
      // The limit applies to the combined answer. A full answer that still starves directions earns
      // a pass for only those, and only after progress.
      for (let pass = 0; pass < MAX_DIRECTION_SUPPLEMENT_PASSES && missing.length > 0; pass += 1) {
        const limit = Math.min(
          DIRECTION_SUPPLEMENT_LIMIT,
          Math.max(minimum, missing.length * minimum),
        );
        const supplement = await fetchSupplement(missing, limit);
        for (const stopEvent of supplement.stopEvents) {
          if (!isStopEventWithin(stopEvent, feedNow, feedNow + horizonMs)) continue;
          if (!collected.add(stopEvent)) continue;
          supplemented.push(stopEvent);
        }
        const nextMissing = getMissing();
        if (!supplement.rowLimitReached || nextMissing.length === missing.length) break;
        missing = nextMissing;
      }
    } catch {
      return base;
    }

    this.supplements.set(supplementKey, { receivedAt: Date.now(), stopEvents: supplemented });
    return this.toCoveredBoard(base, collected.stopEventById, feedNow, horizonMs);
  }

  /** The completed board: live facts, one order, inside the window. */
  private toCoveredBoard(
    base: LiveStopEventBoard,
    stopEventById: ReadonlyMap<string, StopEvent>,
    feedNow: number,
    horizonMs: number,
  ): StopEventBoard {
    return {
      ...base,
      stopEvents: sortStopEventsByExpectedInstant(
        [...stopEventById.values()].filter((stopEvent) =>
          isStopEventWithin(stopEvent, feedNow, feedNow + horizonMs),
        ),
        feedNow,
      ),
    };
  }
}
