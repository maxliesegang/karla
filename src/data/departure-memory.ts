import type { KvvTrip, KvvTripLocator } from "./kvv-efa-parsers";
import type { Departure } from "./transit-types";
import { findFinalCallInstant } from "../lib/trip-calls";

/** Provider locators are short-lived board state, never an unbounded timetable cache. */
const TRIP_LOCATOR_CAPACITY = 1_024;

/** One provider reading of a trip's sequence, with the instant it was taken. */
export type CachedTrip = { receivedAt: number; trip: KvvTrip };

/** Everything the session remembers about one observed departure row. */
type RememberedDeparture = {
  departure: Departure;
  /**
   * When the row was read, so a row answered from memory can state its real age.
   *
   * A detailed board's row carries its own calls and is never re-requested, so without this the
   * only date it could be given is the instant it was asked for — which is how a frozen reading
   * comes to claim it was just taken.
   */
  readAt: number;
  /** The private EFA locator behind the row, where the reading carried one. */
  locator?: KvvTripLocator;
  /**
   * When the run is expected to be over, wherever a reading has stated its calls.
   *
   * What this decides is eviction order, never freshness: a sequence does not move, but the
   * deviations along it do, so a kept reading is still only served while `maxAgeMs` allows. The end
   * of a run is only ever learned, never unlearned: a later row may carry no calls at all.
   */
  runEndsAt?: number;
  /** The separately fetched sequence for this row, where one was asked for. */
  trip?: CachedTrip;
};

/**
 * The rows the session has observed, keyed by the row identity views know, under a fixed cap.
 *
 * One entry holds everything about a row that outlives the board it came on — the row itself, when
 * it was read, how to ask the provider for its sequence, and that sequence once asked for — so the
 * five facts are written, evicted and forgotten together instead of drifting apart across five maps.
 */
export class DepartureMemory {
  private readonly entries = new Map<string, RememberedDeparture>();

  private readonly capacity: number;

  // Written out rather than declared as a constructor parameter, so the module still parses under
  // the type-stripping test runner the boundary is exercised with.
  constructor(capacity: number = TRIP_LOCATOR_CAPACITY) {
    this.capacity = capacity;
  }

  findDeparture(departureId: string): Departure | undefined {
    return this.entries.get(departureId)?.departure;
  }

  findLocator(departureId: string): KvvTripLocator | undefined {
    return this.entries.get(departureId)?.locator;
  }

  findReadAt(departureId: string): number | undefined {
    return this.entries.get(departureId)?.readAt;
  }

  findTrip(departureId: string): CachedTrip | undefined {
    return this.entries.get(departureId)?.trip;
  }

  remember(departure: Departure, locator: KvvTripLocator | undefined, now = Date.now()): void {
    const known = this.entries.get(departure.id);
    // Refresh insertion order so active rows are evicted last.
    this.entries.delete(departure.id);
    this.entries.set(departure.id, {
      ...known,
      departure,
      readAt: now,
      locator,
      runEndsAt: findFinalCallInstant(departure.tripCalls) ?? known?.runEndsAt,
    });
    this.evictDown(now);
  }

  /** A separately fetched sequence, which is the fuller statement of where the run ends. */
  rememberTrip(departureId: string, trip: CachedTrip): void {
    const known = this.entries.get(departureId);
    if (!known) return;
    known.trip = trip;
    known.runEndsAt = findFinalCallInstant(trip.trip.tripCalls) ?? known.runEndsAt;
  }

  private evictDown(now: number): void {
    while (this.entries.size > this.capacity) {
      const evictedId = this.findEvictableDepartureId(now);
      if (evictedId === undefined) break;
      this.entries.delete(evictedId);
    }
  }

  /**
   * Which remembered row the cap should take next: the oldest one whose run is over, or that
   * nothing is known about.
   *
   * Insertion order alone used to decide this, which spent the cap on exactly the wrong rows. A
   * board the rider leaves keeps being re-read and stays young, while a trip fetched once and
   * still out on its route ages quietly at the front — so board churn evicted running vehicles,
   * and the diagram asked for their sequences again. A run whose last call has passed is finished
   * evidence and nobody will ask for it; a row nothing is known about is a board row that costs
   * one board to have back. Both go before a vehicle still on its way. Where every remembered run
   * is still going the oldest is taken regardless: the cap is a bound, not a preference.
   */
  private findEvictableDepartureId(now: number): string | undefined {
    let oldestId: string | undefined;
    for (const [departureId, entry] of this.entries) {
      oldestId ??= departureId;
      if (entry.runEndsAt === undefined || entry.runEndsAt <= now) return departureId;
    }
    return oldestId;
  }
}
