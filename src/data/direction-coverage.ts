import type {
  Departure,
  DepartureBoard,
  DepartureBoardRequest,
  LiveDepartureBoard,
} from "./transit-types";
import { createRunCollector, isDepartureWithin } from "./departure-runs";
import { sortDeparturesByExpectedTime } from "../lib/departure-order";

/** One supplement answers for every sparse direction at once, so its rows are shared far wider. */
const DIRECTION_SUPPLEMENT_LIMIT = 40;
/**
 * How many filtered passes a completion may spend. Every pass after the first carries only the
 * directions the full answer before it still starved, so it asks for fewer lines than the one
 * before it; the cap is what stops a feed that keeps answering with the wrong rows from being
 * asked forever.
 */
const MAX_DIRECTION_SUPPLEMENT_PASSES = 3;
/**
 * How long a coverage supplement stands. What runs here is not a countdown: an hourly bus found
 * once is still leaving at the same minute five minutes later, and asking again every thirty
 * seconds spent more on rarely-read rows than on the board the rider is reading.
 */
const DIRECTION_SUPPLEMENT_TTL_MS = 5 * 60_000;
const DEFAULT_DIRECTION_COVERAGE_HORIZON_MS = 2 * 60 * 60_000;

/**
 * The completion a request asks for, read once so that the reading kept under a key and the passes
 * that produced it can never disagree about what was asked. A request that wants no completion, or
 * whose calling sequences make one far too heavy to widen, answers nothing here.
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
 * Completes a basic board just far enough for the stop's line overview to answer "what runs here?".
 *
 * Candidate ids come from the same monitor response, but only returned departure rows become
 * visible facts. The completion is a reading of its own with its own life
 * (`DIRECTION_SUPPLEMENT_TTL_MS`), not part of the thirty-second cycle. It has to be, or it never
 * stops: a stop whose rare lines run hourly is under-covered on every single refresh, so a pass
 * tied to the board's cadence asks again forever and spends more than the board it completes.
 *
 * Held rows are published only for departures further away than the reading is old, so a delay
 * that has moved since cannot mislead a rider about something imminent. Anything nearer than that
 * is the fresh board's to state — and at a stop busy enough for this to matter, the fresh board
 * already reaches it. A supplement past its life is dropped rather than aged further, and a failed
 * pass adds nothing at all.
 */
export class DirectionCoverageCompleter {
  /** Query candidates from EFA's monitor metadata; they are never rendered without a live row. */
  private readonly servingDirectionIdsByStopId = new Map<string, readonly string[]>();
  /** The rare directions a live board could not reach, kept as their own short-lived reading. */
  private readonly supplements = new Map<
    string,
    { receivedAt: number; departures: readonly Departure[] }
  >();

  /**
   * What the stop's own board said it serves. Only an unfiltered reading may state this: a filtered
   * board saw only the lines it asked about, so recording it would shrink the very set this reads.
   */
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

    // Counted in one pass over the departures rather than one pass per direction: a busy post
    // answers with forty rows and serves twenty directions, and this is re-asked after every read.
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
      // The limit applies to the combined filtered answer, not once per line. A full answer that
      // still starves some directions earns another pass carrying only those: one retry does not
      // always settle the skew that spends a busy stop's rows on the lines needing them least.
      // A pass runs only after progress, so each one is a smaller ask, never a wider one.
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

  /** The completed reading: the live board's own facts, in one order, inside the stated window. */
  private toCoveredBoard(
    base: LiveDepartureBoard,
    departureById: ReadonlyMap<string, Departure>,
    feedNow: number,
    horizonMs: number,
  ): DepartureBoard {
    return {
      ...base,
      departures: sortDeparturesByExpectedTime(
        [...departureById.values()].filter((departure) =>
          isDepartureWithin(departure, feedNow, feedNow + horizonMs),
        ),
        feedNow,
      ),
    };
  }
}
