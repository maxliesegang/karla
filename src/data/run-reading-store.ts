import { findFinalCallInstant, mergeRunSequence, toRunSequence } from "../lib/trip-calls";
import { getDepartureReadInstant, isBetterSequence } from "../lib/trips";
import type { KvvTripLocator } from "./kvv-efa-parsers";
import type { Departure, RunSequence } from "./transit-types";

/** The number of runs whose evidence is retained for this browser session. */
export const RUN_READING_STORE_CAPACITY = 1_024;

/**
 * How long after a run's last call its evidence is kept, so a mark can outlive the boards.
 *
 * A vehicle stops being a row on any board the moment it leaves its last one, and the diagram goes
 * on drawing it until its own calls run out (`lib/line-run-departures.ts`). The grace is what
 * that retention reads from; past it the run is over and nothing asks about it again.
 *
 * Four lifetimes describe the same run and they are not independent:
 *
 *     board cache  <  mark retention  <  RUN_ENDED_GRACE_MS  <  RUN_READING_MAX_AGE_MS
 *
 * A board cache (`DEFAULT_BOARD_MAX_AGE_MS`) outliving the records of the rows it hands back would
 * send `findRunRecordKey` to the bare-row fallback and restore the per-stop fan-out this store
 * exists to remove, silently. A drawn mark (`RUN_MARK_RETENTION_GRACE_MS`) must resolve through
 * `findRun` for as long as it is drawn. `RUN_READING_MAX_AGE_MS` is the outermost backstop.
 * Asserted in `tests/trip-loading.test.ts`; exported for that and nothing else.
 */
export const RUN_ENDED_GRACE_MS = 10 * 60_000;

/**
 * How long a record may stand on its newest reading alone, for a run whose end is not known.
 *
 * A run with no sequence behind it times no end, so nothing but age can retire it. Four hours is
 * longer than any run KVV operates — Karlsruhe to Freudenstadt is under three — and far short of
 * the day at which `tripCode` comes round again, which is what the key relies on. See
 * `getRunRecordKey` and `npm run probe:run-identity`.
 */
export const RUN_READING_MAX_AGE_MS = 4 * 60 * 60_000;

/** How often the store looks for evidence to retire, rather than on every row of every board. */
const EVICTION_SWEEP_INTERVAL_MS = 60_000;

/**
 * The most rows one record keeps, least recently read first out.
 *
 * A bound against a provider that keeps naming new ones, not a working limit: no KVV run calls at
 * anything near this many places. Without it a single long-lived record is unbounded in a store
 * whose only cap counts records.
 */
const RUN_RECORD_ROW_CAPACITY = 64;

/**
 * How far into the least-recent end of the store the cap looks for a run that is already over.
 *
 * Bounded because this runs on every row of every board once the store is full, and unbounded it
 * was the whole store walked per row. The preference it serves is a nicety, so it is worth a short
 * look and not a long one.
 */
const ENDED_RUN_SCAN_DEPTH = 32;

/**
 * One stop's row of a run, with the private locator the run can be read by where one was returned.
 *
 * The row dates itself (`Departure.readAt`), so nothing here carries a clock beside it: a row and
 * its age cannot come apart, and every ranking in this file asks the row rather than a caller.
 *
 * It is kept *without* its calling sequence: a row that arrived carrying calls has had them
 * promoted to the record's sequence, where the whole run is ranked and kept once. Leaving a copy on
 * each of the run's forty rows is forty copies of one forty-call array that nothing reads, since
 * `findRun` merges the record's sequence over every row of it.
 */
export type RunRowReading = { departure: Departure; locator?: KvvTripLocator };

/** A run's calling sequence, and whether it came off a board or was requested on its own. */
export type RunSequenceReading = { sequence: RunSequence; source: "board" | "request" };

type RunReadingRecord = {
  key: string;
  rowsById: Map<string, RunRowReading>;
  /**
   * Each row of this record completed by the sequence above it, kept until the record next changes.
   *
   * Every view reads its vehicles from here on every render, and a merge that allocated each time
   * would hand back a new object for an unchanged reading — a `useMemo` recomputed and a mark
   * redrawn for a run nothing has said anything new about. Cleared as a whole on any write to the
   * record, because a new sequence completes every row of it and not only the one that carried it.
   */
  mergedByRowId: Map<string, Departure>;
  latestSequence?: RunSequenceReading;
  /** When the fullest sequence read so far has this run reaching its last call. */
  runEndsAt?: number;
  /** When anything was last read into this record, which is the only clock an unended run has. */
  writtenAt: number;
};

/**
 * The key one run is followed, requested and drawn under.
 *
 * The provider's own address for a run: the line-direction and the trip code its locator names,
 * which is the tuple the trip endpoint is asked with. Measured against the live feed
 * (`npm run probe:run-identity`, 6 September 2026): of 57 runs seen at more than one of the
 * Zentrum's posts, none was named by two different codes, and within a single reading 112 codes
 * named 112 runs. Every row of every board carried one, filtered or not.
 *
 * What it is *not* is a dated identity: half the codes read at one stop came round again the next
 * day, on the same line at the same minute. Adding a date would part a run at midnight to defend
 * against a collision a whole day away, so the lifetime does that job instead — a record dies when
 * its run ends (`RUN_ENDED_GRACE_MS`) or ages out (`RUN_READING_MAX_AGE_MS`), both long before the
 * code is issued again. The dated identity belongs to the mark (`getRunMarkKey`), which is refined
 * by the sequence a record goes on to hold; a key that moved with it would be two keys for one
 * record.
 *
 * The fallback is for readings the provider gave no locator: a fixture, or a board row it declined
 * to make addressable. It keeps such a row reachable on its own id and joins two of them on nothing
 * weaker than the identity the feed itself stated.
 */
const getRunRecordKey = (departure: Departure, locator: KvvTripLocator | undefined): string =>
  locator ? `run:${locator.line}|${locator.tripCode}` : getRowRecordKey(departure.id);

/**
 * The key a row the feed named no run for stands under: its own id, joining it to nothing.
 *
 * `findRunRecordKey` hands out the same string, so a second spelling would be two records for one
 * row on the day they drifted.
 */
const getRowRecordKey = (rowId: string): string => `row:${rowId}`;

/**
 * Session-level evidence about the runs out on the network, with the provenance of every reading.
 *
 * Rows and complete trips answer different questions and are deliberately never flattened here.
 * A row owns stop-specific facts and the private locator needed to read the run; the freshest
 * complete reading owns its calling sequence. Consumers choose the evidence their question needs.
 *
 * One record is one run (`getRunRecordKey`). There is no second identity to reconcile and no record
 * ever merges into another, so the key a request is shared under is the key its answer lands on.
 */
export class RunReadingStore {
  /** Keyed by run. Insertion order is write recency, which is what the cap falls back on. */
  private readonly records = new Map<string, RunReadingRecord>();
  /** Row id to the run it belongs to; the only index from a row to its record. */
  private readonly rowRecordKeys = new Map<string, string>();
  private readonly capacity: number;
  /** Subscribers indexed by the row ids they actually render. */
  private readonly listenersByRowId = new Map<string, Set<() => void>>();
  /** The last store change that could alter the answer for each row still in hand. */
  private readonly versionsByRowId = new Map<string, number>();
  /** Listeners collected across one synchronous batch of writes. */
  private readonly pendingListeners = new Set<() => void>();
  private version = 0;
  private isNotificationScheduled = false;
  private lastSweptAt = 0;

  constructor(capacity: number = RUN_READING_STORE_CAPACITY) {
    this.capacity = capacity;
  }

  /** `now` dates nothing here — the row dates itself — and only says which runs are over. */
  rememberRow(departure: Departure, locator: KvvTripLocator | undefined, now = Date.now()): void {
    // Before the record is opened, never after: a record left standing past its own run would be
    // reopened by tomorrow's row and answer it with yesterday's sequence (`sweep`).
    this.sweep(now);
    const recordKey = getRunRecordKey(departure, locator);
    const record = this.openRecord(recordKey, now);

    // A row that has learned its locator moves to the run it names, rather than staying on the
    // record its bare id opened. It is one row either way and must never be on two.
    const previousKey = this.rowRecordKeys.get(departure.id);
    if (previousKey !== undefined && previousKey !== recordKey) this.detachRow(departure.id);

    // Promoted before the row is stored, and stored without them (`RunRowReading`).
    const sequence = toRunSequence(departure);
    if (sequence) this.rememberSequenceReading(record, { sequence, source: "board" });

    // Re-inserted rather than overwritten, so a record's rows are in read-recency order too and the
    // row cap below can take the least recently read without a search.
    record.rowsById.delete(departure.id);
    record.rowsById.set(departure.id, {
      departure: sequence ? withoutCalls(departure) : departure,
      ...(locator ? { locator } : {}),
    });
    this.rowRecordKeys.set(departure.id, recordKey);
    this.enforceRowCapacity(record);

    this.enforceCapacity(now);
    this.publish(record);
  }

  /**
   * Keyed by the run rather than by the row that asked for it: see `findRunRecordKey`.
   *
   * @returns whether a record was still there to receive it. A request outlives the sweep and the
   * cap, so the record it was shared under can be gone by the time it answers — and an answer that
   * lands nowhere must be *said* to have landed nowhere. Reported as a failure the caller can back
   * off on rather than swallowed, which is how a run went on being asked for and never re-read.
   */
  rememberSequence(runKey: string, sequence: RunSequence, now = Date.now()): boolean {
    const record = this.records.get(runKey);
    if (!record || sequence.tripCalls.length === 0) return false;
    this.touchRecord(record, now);
    this.rememberSequenceReading(record, { sequence, source: "request" });
    this.publish(record);
    return true;
  }

  findRow(rowId: string): RunRowReading | undefined {
    return this.findRecord(rowId)?.rowsById.get(rowId);
  }

  /** The fullest, freshest calling sequence read for the run this row is a stop of. */
  findSequence(rowId: string): RunSequenceReading | undefined {
    return this.findRecord(rowId)?.latestSequence;
  }

  /**
   * This row as everything read so far describes it: the stop's own facts under the whole run.
   *
   * The one answer to "what is known about this vehicle right now", and the only one any view is
   * given. It asks for nothing — a row nothing has been read for is answered by the row — so a view
   * may call it every render, and the same object comes back until something is actually read.
   */
  findRun(rowId: string): Departure | undefined {
    const record = this.findRecord(rowId);
    const row = record?.rowsById.get(rowId);
    if (!record || !row) return undefined;
    const merged =
      record.mergedByRowId.get(rowId) ??
      mergeRunSequence(row.departure, record.latestSequence?.sequence);
    record.mergedByRowId.set(rowId, merged);
    return merged;
  }

  /**
   * Runs are read into this store by whatever asked first, and drawn by everything at once, so a
   * reading that lands for one view is news for every other view following the same row.
   */
  subscribe(rowIds: readonly string[], listener: () => void): () => void {
    for (const rowId of rowIds) {
      const listeners = this.listenersByRowId.get(rowId);
      if (listeners) listeners.add(listener);
      else this.listenersByRowId.set(rowId, new Set([listener]));
    }
    return () => {
      for (const rowId of rowIds) {
        const listeners = this.listenersByRowId.get(rowId);
        listeners?.delete(listener);
        if (listeners?.size === 0) this.listenersByRowId.delete(rowId);
      }
    };
  }

  getVersion(rowIds: readonly string[]): string {
    return rowIds.map((rowId) => this.versionsByRowId.get(rowId) ?? 0).join(",");
  }

  /**
   * The freshest row still known for a run, addressed by the key its request was shared under.
   *
   * A request outlives the row that asked for it: a board refresh may drop that row while the
   * provider is still answering, and what comes back is about the run rather than about the row
   * that happened to discover it. Resolved against the row that asked, one dropped row threw away
   * a sequence every other stop of the same tram was waiting on.
   */
  findRunRow(runKey: string): RunRowReading | undefined {
    let freshest: RunRowReading | undefined;
    for (const row of this.records.get(runKey)?.rowsById.values() ?? []) {
      const readAt = getDepartureReadInstant(row.departure) ?? 0;
      if (!freshest || readAt > (getDepartureReadInstant(freshest.departure) ?? 0)) freshest = row;
    }
    return freshest;
  }

  /** The stable request-sharing key for every row currently known to describe this run. */
  findRunRecordKey(rowId: string): string {
    return this.rowRecordKeys.get(rowId) ?? getRowRecordKey(rowId);
  }

  private findRecord(rowId: string): RunReadingRecord | undefined {
    const key = this.rowRecordKeys.get(rowId);
    return key ? this.records.get(key) : undefined;
  }

  /** This run's record, created where it is new, and moved to the end of the map either way. */
  private openRecord(recordKey: string, now: number): RunReadingRecord {
    const existing = this.records.get(recordKey);
    if (existing) {
      this.touchRecord(existing, now);
      return existing;
    }
    const record: RunReadingRecord = {
      key: recordKey,
      rowsById: new Map(),
      mergedByRowId: new Map(),
      writtenAt: now,
    };
    this.records.set(recordKey, record);
    return record;
  }

  private rememberSequenceReading(record: RunReadingRecord, reading: RunSequenceReading): void {
    const latest = record.latestSequence;
    if (!latest || isBetterSequence(reading.sequence, latest.sequence))
      record.latestSequence = reading;
    // Only ever learned, never unlearned: a later reading may carry a sequence read part-way
    // through the run, and the end a longer one stated is still the truer statement of when this
    // run is over — which is what retires the record.
    const endsAt = findFinalCallInstant(reading.sequence.tripCalls);
    if (endsAt !== undefined) record.runEndsAt = Math.max(record.runEndsAt ?? endsAt, endsAt);
  }

  /** Re-inserted, not left where it was: the map's order is the write recency the cap reads. */
  private touchRecord(record: RunReadingRecord, now: number): void {
    record.writtenAt = now;
    this.records.delete(record.key);
    this.records.set(record.key, record);
  }

  /**
   * Records the write, and tells the views about it once for the batch it arrived in.
   *
   * A board is remembered a row at a time, so a notification per write is forty sweeps of every
   * subscriber for one refresh that says one thing: the boards came back. The notification waits
   * for the end of the turn, which is still before anything is painted.
   */
  private publish(record: RunReadingRecord): void {
    record.mergedByRowId.clear();
    this.version += 1;
    for (const rowId of record.rowsById.keys()) {
      this.versionsByRowId.set(rowId, this.version);
      for (const listener of this.listenersByRowId.get(rowId) ?? []) {
        this.pendingListeners.add(listener);
      }
    }
    this.scheduleNotification();
  }

  /**
   * Retires the runs that are over, which is what keeps the key honest.
   *
   * A trip code comes round again (`getRunRecordKey`), so what separates two runs of it is that the
   * first one's record is gone before the second's row arrives. That makes this the rule rather
   * than a tidy-up, and the cap below only a backstop. It walks every record, so it runs on a
   * cadence of its own rather than once per row of a board.
   */
  private sweep(now: number): void {
    if (now - this.lastSweptAt < EVICTION_SWEEP_INTERVAL_MS) return;
    this.lastSweptAt = now;
    // Walked over the map itself: deleting the entry the iterator is standing on is defined, and a
    // copy taken to avoid it would be a thousand records copied every minute for nothing.
    for (const record of this.records.values()) {
      if (isRetired(record, now)) this.evictRecord(record);
    }
  }

  /**
   * Holds the store to its cap, for a session nothing is retiring runs out of.
   *
   * Checked on every write, unlike the sweep: a bound that is only enforced on a cadence is not one.
   */
  private enforceCapacity(now: number): void {
    while (this.records.size > this.capacity) {
      const evicted = this.findEvictionCandidate(now);
      if (!evicted) return;
      this.evictRecord(evicted);
    }
  }

  /**
   * The record to spend, found without walking the store.
   *
   * Insertion order is write recency, so the least recently written record is the *first* entry and
   * costs nothing to reach. A run whose calls have run out is taken ahead of it — the only
   * preference the cap has — but the search for one is bounded to the least-recent end, which is
   * the only end it was ever going to be found at (`ENDED_RUN_SCAN_DEPTH`).
   */
  private findEvictionCandidate(now: number): RunReadingRecord | undefined {
    let leastRecent: RunReadingRecord | undefined;
    let scanned = 0;
    for (const record of this.records.values()) {
      leastRecent ??= record;
      if (hasRunEnded(record, now)) return record;
      if (++scanned >= ENDED_RUN_SCAN_DEPTH) break;
    }
    return leastRecent;
  }

  /** Holds one record to its row cap, taking the least recently read rows off it first. */
  private enforceRowCapacity(record: RunReadingRecord): void {
    while (record.rowsById.size > RUN_RECORD_ROW_CAPACITY) {
      const oldest = record.rowsById.keys().next().value;
      if (oldest === undefined) return;
      this.dropRow(record, oldest);
    }
  }

  private evictRecord(record: RunReadingRecord): void {
    for (const rowId of record.rowsById.keys()) {
      this.forgetRow(record, rowId);
    }
    this.records.delete(record.key);
    this.scheduleNotification();
  }

  /** Takes one row off a record that stays, which every view following it has to be told about. */
  private dropRow(record: RunReadingRecord, rowId: string): void {
    record.rowsById.delete(rowId);
    record.mergedByRowId.delete(rowId);
    this.forgetRow(record, rowId);
    this.scheduleNotification();
  }

  /**
   * Forgets what this store knows *about* a row, without touching the record that held it.
   *
   * The index is cleared only where it still points at this record: a row that moved on has already
   * been re-pointed, and clearing it here would unaddress a row that is perfectly well known.
   */
  private forgetRow(record: RunReadingRecord, rowId: string): void {
    if (this.rowRecordKeys.get(rowId) === record.key) this.rowRecordKeys.delete(rowId);
    this.versionsByRowId.delete(rowId);
    for (const listener of this.listenersByRowId.get(rowId) ?? []) {
      this.pendingListeners.add(listener);
    }
  }

  private scheduleNotification(): void {
    if (this.isNotificationScheduled || this.pendingListeners.size === 0) return;
    this.isNotificationScheduled = true;
    queueMicrotask(() => {
      this.isNotificationScheduled = false;
      const listeners = [...this.pendingListeners];
      this.pendingListeners.clear();
      for (const listener of listeners) listener();
    });
  }

  /** Take this row off whatever record it was on, dropping that record where it empties. */
  private detachRow(rowId: string): void {
    const record = this.findRecord(rowId);
    this.rowRecordKeys.delete(rowId);
    if (!record) return;
    record.rowsById.delete(rowId);
    record.mergedByRowId.delete(rowId);
    if (record.rowsById.size === 0) this.records.delete(record.key);
  }
}

/** This row as the store keeps it: its stop's facts, and none of the run's calls (`RunRowReading`). */
const withoutCalls = (departure: Departure): Departure => ({ ...departure, tripCalls: undefined });

/**
 * Whether this run's evidence has stopped being about a vehicle anybody can still see.
 *
 * Two ways, because only one of them is ever known: a run whose calls have run out is over at its
 * last call plus the grace, and a run no sequence has described times no end at all.
 *
 * Either way the boards have the last word: a monitored vehicle sitting at its final stop states a
 * last call in the past and is a row on a board all the same, so a record written to within the
 * grace is never retired — and a reading can never be evicted by the sweep its own arrival
 * triggered.
 */
const isRetired = (record: RunReadingRecord, now: number): boolean => {
  if (record.writtenAt + RUN_ENDED_GRACE_MS > now) return false;
  return record.runEndsAt !== undefined
    ? record.runEndsAt + RUN_ENDED_GRACE_MS <= now
    : record.writtenAt + RUN_READING_MAX_AGE_MS <= now;
};

/**
 * Whether this run's own calls have run out, which is the only preference the cap has.
 *
 * Asked without the grace above, because a cap being exceeded is not a question about whether
 * anything is still reading a run: it is one about which of the runs in hand is likeliest to be
 * finished with, and a vehicle whose last call is behind it is that run whenever it was last read.
 */
const hasRunEnded = (record: RunReadingRecord, now: number): boolean =>
  record.runEndsAt !== undefined && record.runEndsAt <= now;
