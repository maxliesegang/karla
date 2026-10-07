import type {
  Departure,
  DepartureBoard,
  DepartureBoardRequest,
  LiveDepartureBoard,
} from "./transit-types";
import { createRunCollector, isDepartureWithin } from "./departure-runs";
import { sortDeparturesByExpectedInstant } from "../lib/departure-order";
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
  request: DepartureBoardRequest,
): DirectionCoverage | undefined {
  const requested = request.minimumDeparturesPerDirection ?? 0;
  if (request.includeTripCalls || requested <= 0) return undefined;
  const minimum = Math.max(1, Math.floor(requested));
  const horizonMs = Math.max(0, request.coverageHorizonMs ?? DEFAULT_DIRECTION_COVERAGE_HORIZON_MS);
  return { minimum, horizonMs, key: `${minimum}:${horizonMs}` };
}

/** One filtered read of a stop, as the completion asks for it. */
type FetchSupplement = (
  lineIds: readonly string[],
  limit: number,
) => Promise<{ departures: readonly Departure[]; rowLimitReached: boolean }>;

/**
 * Completes a basic board so the line overview can answer "what runs here?". Candidates come from
 * the monitor's metadata; only returned rows are shown. Supplements live on their own TTL, or a
 * stop with hourly lines would re-ask every refresh. Held rows show only for departures further
 * away than the reading is old; expired supplements drop, failed passes add nothing.
 */
export class DirectionCoverageCompleter {
  /** Query candidates from the monitor's metadata; never shown without a live row. */
  private readonly servingDirectionIdsByStopId = new ReadingCache<readonly string[]>(
    DIRECTION_CACHE_CAPACITY,
    SERVING_DIRECTIONS_MAX_AGE_MS,
  );
  /** The short-lived supplements for directions the board missed. */
  private readonly supplements = new ReadingCache<{
    receivedAt: number;
    departures: readonly Departure[];
  }>(DIRECTION_CACHE_CAPACITY, DIRECTION_SUPPLEMENT_TTL_MS);

  /** What the stop's unfiltered board says it serves; a filtered board would shrink the set. */
  rememberServingDirections(stopId: string, directionIds: readonly string[]): void {
    this.servingDirectionIdsByStopId.set(stopId, directionIds);
  }

  async complete(
    base: LiveDepartureBoard,
    coverage: DirectionCoverage,
    fetchSupplement: FetchSupplement,
  ): Promise<DepartureBoard> {
    const { minimum, horizonMs, key: coverageKey } = coverage;
    const feedNow = Date.parse(base.feedUpdatedAt);
    if (!Number.isFinite(feedNow)) return base;

    const candidates = [
      ...new Set([
        ...(this.servingDirectionIdsByStopId.get(base.stopId) ?? []),
        ...base.departures.flatMap(({ routeDirectionId }) =>
          routeDirectionId ? [routeDirectionId] : [],
        ),
      ]),
    ];
    if (candidates.length === 0) return base;

    const supplementKey = `${base.stopId}:${coverageKey}`;
    const held = this.supplements.get(supplementKey);
    const heldAgeMs = held ? Date.now() - held.receivedAt : Number.POSITIVE_INFINITY;
    const isHeldReadable = heldAgeMs < DIRECTION_SUPPLEMENT_TTL_MS;

    const collected = createRunCollector(base.departures);
    if (isHeldReadable && held) {
      for (const departure of held.departures) {
        if (isDepartureWithin(departure, feedNow + heldAgeMs, feedNow + horizonMs)) {
          collected.add(departure);
        }
      }
    }

    // One pass over the departures, not one per direction; re-run after every read.
    const getMissing = () => {
      const coveredByDirection = new Map<string, number>();
      for (const departure of collected.departureById.values()) {
        const directionId = departure.routeDirectionId;
        if (!directionId || !isDepartureWithin(departure, feedNow, feedNow + horizonMs)) continue;
        coveredByDirection.set(directionId, (coveredByDirection.get(directionId) ?? 0) + 1);
      }
      return candidates.filter(
        (directionId) => (coveredByDirection.get(directionId) ?? 0) < minimum,
      );
    };

    if (isHeldReadable)
      return this.toCoveredBoard(base, collected.departureById, feedNow, horizonMs);

    let missing = getMissing();
    if (missing.length === 0) return base;

    const supplemented: Departure[] = [];
    try {
      // The limit applies to the combined answer. A full answer that still starves directions earns
      // a pass for only those, and only after progress.
      for (let pass = 0; pass < MAX_DIRECTION_SUPPLEMENT_PASSES && missing.length > 0; pass += 1) {
        const limit = Math.min(
          DIRECTION_SUPPLEMENT_LIMIT,
          Math.max(minimum, missing.length * minimum),
        );
        const supplement = await fetchSupplement(missing, limit);
        for (const departure of supplement.departures) {
          if (!isDepartureWithin(departure, feedNow, feedNow + horizonMs)) continue;
          if (!collected.add(departure)) continue;
          supplemented.push(departure);
        }
        const nextMissing = getMissing();
        if (!supplement.rowLimitReached || nextMissing.length === missing.length) break;
        missing = nextMissing;
      }
    } catch {
      return base;
    }

    this.supplements.set(supplementKey, { receivedAt: Date.now(), departures: supplemented });
    return this.toCoveredBoard(base, collected.departureById, feedNow, horizonMs);
  }

  /** The completed board: live facts, one order, inside the window. */
  private toCoveredBoard(
    base: LiveDepartureBoard,
    departureById: ReadonlyMap<string, Departure>,
    feedNow: number,
    horizonMs: number,
  ): DepartureBoard {
    return {
      ...base,
      departures: sortDeparturesByExpectedInstant(
        [...departureById.values()].filter((departure) =>
          isDepartureWithin(departure, feedNow, feedNow + horizonMs),
        ),
        feedNow,
      ),
    };
  }
}
