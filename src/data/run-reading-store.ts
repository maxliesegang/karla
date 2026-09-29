import { findFinalCallInstant, mergeRunSequence, toRunSequence } from "../lib/trip-calls";
import { getDepartureReadInstant, isBetterSequence } from "../lib/trips";
import type { KvvTripLocator } from "./kvv-efa-parsers";
import type { Departure, RunSequence } from "./transit-types";

/** The number of runs whose evidence is retained for this browser session. */
export const RUN_READING_STORE_CAPACITY = 1_024;

/**
 * How long after a run's last call its evidence is kept, so a mark can outlive the boards.
 * One of four nested lifetimes (docs/adr/0002-run-key-without-date.md); exported for the test
 * that asserts their order.
 */
export const RUN_ENDED_GRACE_MS = 10 * 60_000;

/**
 * How long a record may stand on its newest reading alone, for a run whose end is not known.
 * Longer than any KVV run, far shorter than the day after which its `tripCode` is reused.
 */
export const RUN_READING_MAX_AGE_MS = 4 * 60 * 60_000;

/** How often the store looks for evidence to retire, rather than on every row of every board. */
const EVICTION_SWEEP_INTERVAL_MS = 60_000;

/** A bound against a provider that keeps naming new rows for one run; no KVV run comes close. */
const RUN_RECORD_ROW_CAPACITY = 64;

/** How far into the least-recent end the cap looks for a finished run before taking the oldest. */
const ENDED_RUN_SCAN_DEPTH = 32;

/**
 * One stop's row of a run, with the locator the run can be read by where one was returned.
 *
 * Kept without its calls: a row that arrived with calls had them promoted to the record's sequence,
 * which `findRun` merges back over every row of the run.
 */
export type RunRowReading = { departure: Departure; locator?: KvvTripLocator };

/** A run's calling sequence, and whether it came off a board or was requested on its own. */
export type RunSequenceReading = { sequence: RunSequence; source: "board" | "request" };

type RunReadingRecord = {
  key: string;
  rowsById: Map<string, RunRowReading>;
  /**
   * Each row merged with the record's sequence, cached so `findRun` returns the same object until
   * the record changes; views memoize on that identity. Cleared on any write to the record.
   */
  mergedByRowId: Map<string, Departure>;
  latestSequence?: RunSequenceReading;
  /** When the fullest sequence read so far has this run reaching its last call. */
  runEndsAt?: number;
  /** When anything was last read into this record, which is the only clock an unended run has. */
  writtenAt: number;
};

/**
 * The key a run's evidence and requests are shared under: the provider's `line|tripCode`, with no
 * date (docs/adr/0002-run-key-without-date.md). A row the feed gave no locator stands on its own id.
 */
const getRunRecordKey = (departure: Departure, locator: KvvTripLocator | undefined): string =>
  locator ? `run:${locator.line}|${locator.tripCode}` : getRowRecordKey(departure.id);

/** The key a row the feed named no run for stands under, shared with `findRunRecordKey`. */
const getRowRecordKey = (rowId: string): string => `row:${rowId}`;

/**
 * Everything read about the runs out on the network, one record per run
 * (docs/adr/0001-one-run-reading-store.md).
 *
 * Rows own stop-specific facts and the locator; the best sequence owns the calls. The two are kept
 * apart and merged only on the way out (`findRun`). No record ever merges into another, so the key
 * a request is shared under is the key its answer lands on.
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

  /** `now` only says which runs are over; the row dates itself (`Departure.readAt`). */
  rememberRow(departure: Departure, locator: KvvTripLocator | undefined, now = Date.now()): void {
    // Sweep before opening the record: a record left standing past its run would be reopened by
    // tomorrow's row with the same key and answer it with yesterday's sequence.
    this.sweep(now);
    const recordKey = getRunRecordKey(departure, locator);
    const record = this.openRecord(recordKey, now);

    // A row that has learned its locator moves to the run it names; it is never on two records.
    const previousKey = this.rowRecordKeys.get(departure.id);
    if (previousKey !== undefined && previousKey !== recordKey) this.detachRow(departure.id);

    const sequence = toRunSequence(departure);
    if (sequence) this.rememberSequenceReading(record, { sequence, source: "board" });

    // Re-inserted rather than overwritten, so the row cap can take the least recently read first.
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
   * @returns whether a record was still there to receive it. A request can outlive its record (the
   * sweep and the cap do not wait for the provider), and an answer that lands nowhere is reported
   * as a failure so the caller backs off instead of counting it as a success.
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
   * Requests nothing, and returns the same object until something about the run is read.
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
   * The freshest row still known for a run, by the key its request was shared under. A request can
   * outlive the row that asked for it, and its answer is about the run, not about that row.
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
    // Only ever learned, never unlearned: a later sequence read part-way through the run does not
    // move the end a fuller one stated, and that end is what retires the record.
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
   * Records the write, and notifies once per batch: a board is remembered a row at a time, and the
   * notification waits for the end of the turn, which is still before anything is painted.
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
   * Retires the runs that are over. This is what keeps a date-free key honest: the first run of a
   * `tripCode` must be gone before the next one's row arrives. Walks every record, so it runs on
   * its own cadence rather than once per row.
   */
  private sweep(now: number): void {
    if (now - this.lastSweptAt < EVICTION_SWEEP_INTERVAL_MS) return;
    this.lastSweptAt = now;
    // Deleting the entry the iterator stands on is defined for a Map, so no copy is taken.
    for (const record of this.records.values()) {
      if (isRetired(record, now)) this.evictRecord(record);
    }
  }

  /** Holds the store to its cap on every write; a bound enforced only on a cadence is not one. */
  private enforceCapacity(now: number): void {
    while (this.records.size > this.capacity) {
      const evicted = this.findEvictionCandidate(now);
      if (!evicted) return;
      this.evictRecord(evicted);
    }
  }

  /**
   * A finished run near the least-recent end if there is one, else the least recent record, found
   * without walking the whole store (`ENDED_RUN_SCAN_DEPTH`).
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
   * Forgets what this store knows about a row. The index is cleared only where it still points at
   * this record: a row that moved on has already been re-pointed.
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

/** This row as the store keeps it: its stop's facts, and none of the run's calls. */
const withoutCalls = (departure: Departure): Departure => ({ ...departure, tripCalls: undefined });

/**
 * Whether a record is about a run nobody can still see: past its last call plus the grace, or, with
 * no known end, past the max age. A record written within the grace is never retired, since a
 * vehicle standing at its final stop is still a row on a board.
 */
const isRetired = (record: RunReadingRecord, now: number): boolean => {
  if (record.writtenAt + RUN_ENDED_GRACE_MS > now) return false;
  return record.runEndsAt !== undefined
    ? record.runEndsAt + RUN_ENDED_GRACE_MS <= now
    : record.writtenAt + RUN_READING_MAX_AGE_MS <= now;
};

/** Whether a run's calls have run out; asked without the grace, since the cap only ranks. */
const hasRunEnded = (record: RunReadingRecord, now: number): boolean =>
  record.runEndsAt !== undefined && record.runEndsAt <= now;
