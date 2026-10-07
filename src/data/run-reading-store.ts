import {
  findFinalCallInstant,
  mergeRunSequence,
  retainRunCoverage,
  toRunSequence,
} from "../lib/trip-calls";
import { getDepartureReadInstant, isBetterSequence } from "../lib/trips";
import { getRunScheduleInstant, isSameRunInstance } from "../lib/run-instance";
import type { KvvTripLocator } from "./kvv-efa-parsers";
import type { Departure, RunSequence } from "./transit-types";

/** Runs whose evidence is retained this session. */
export const RUN_READING_STORE_CAPACITY = 1_024;

/** How long after a run's last call its evidence is kept, so a mark can outlive the boards. */
export const RUN_ENDED_GRACE_MS = 10 * 60_000;

/** How long a record with no known end lasts: longer than any KVV run, well under a day. */
export const RUN_READING_MAX_AGE_MS = 4 * 60 * 60_000;

/** How often the store sweeps for evidence to retire. */
const EVICTION_SWEEP_INTERVAL_MS = 60_000;

/** A bound against a provider naming endless rows for one run. */
const RUN_RECORD_ROW_CAPACITY = 64;

/** How far into the least-recent end the cap looks for a finished run first. */
const ENDED_RUN_SCAN_DEPTH = 32;

/** One stop's row of a run and its locator, without calls (those move to the record's sequence). */
export type RunRowReading = { departure: Departure; locator?: KvvTripLocator };

/** A run's sequence, and whether it came off a board or a request. */
export type RunSequenceReading = { sequence: RunSequence; source: "board" | "request" };

type RunReadingRecord = {
  key: string;
  instance: Departure;
  rowsById: Map<string, RunRowReading>;
  /**
   * Rows merged with the sequence, cached so `findRun` keeps returning the same object until a
   * write.
   */
  mergedByRowId: Map<string, Departure>;
  latestSequence?: RunSequenceReading;
  sequenceRefreshFailedAt?: number;
  /** When the fullest sequence has the run reaching its last call. */
  runEndsAt?: number;
  /** The last write; the only clock a run with no known end has. */
  writtenAt: number;
};

/** A run's key: the provider's `line|tripCode`, undated. A row without locator uses its own id. */
const getRunRecordKey = (departure: Departure, locator: KvvTripLocator | undefined): string =>
  locator ? `run:${locator.line}|${locator.tripCode}` : getRowRecordKey(departure.id);

const getRowRecordKey = (rowId: string): string => `row:${rowId}`;

/** One bounded record per undated run key; foreign operating instances never share calls. */
export class RunReadingStore {
  /** Insertion order is write recency, which the cap falls back on. */
  private readonly records = new Map<string, RunReadingRecord>();
  private readonly rowRecordKeys = new Map<string, string>();
  private readonly capacity: number;
  /** Subscribers indexed by the row ids they actually render. */
  private readonly listenersByRowId = new Map<string, Set<() => void>>();
  /** The last change that could alter each row's answer. */
  private readonly versionsByRowId = new Map<string, number>();
  private readonly pendingListeners = new Set<() => void>();
  private version = 0;
  private isNotificationScheduled = false;
  private lastSweptAt = 0;

  constructor(capacity: number = RUN_READING_STORE_CAPACITY) {
    this.capacity = capacity;
  }

  /** `now` only decides which runs are over; the row dates itself (`Departure.readAt`). */
  rememberRow(departure: Departure, locator: KvvTripLocator | undefined, now = Date.now()): void {
    // Sweep first, or tomorrow's row with the same key would reopen yesterday's record.
    this.sweep(now);
    const recordKey = getRunRecordKey(departure, locator);
    const record = this.openRecord(recordKey, departure, now);

    // A row that learned its locator moves to that run's record.
    const previousKey = this.rowRecordKeys.get(departure.id);
    if (previousKey !== undefined && previousKey !== recordKey) this.detachRow(departure.id);

    const incomingAt = getRunScheduleInstant(departure);
    const instanceAt = getRunScheduleInstant(record.instance);
    if (
      !isSameRunInstance(record.instance, departure) &&
      incomingAt !== undefined &&
      instanceAt !== undefined &&
      Math.abs(incomingAt - now) < Math.abs(instanceAt - now)
    ) {
      record.instance = withoutCalls(departure);
      record.latestSequence = undefined;
      record.sequenceRefreshFailedAt = undefined;
      record.runEndsAt = undefined;
    }
    const compatible = isSameRunInstance(record.instance, departure);
    if (compatible) this.touchRecord(record, now);
    const sequence = toRunSequence(departure);
    if (sequence && compatible) this.rememberSequenceReading(record, { sequence, source: "board" });

    // Re-inserted so the row cap drops the least recently read first.
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
   * Returns whether a record was there to receive it; an answer landing nowhere counts as a
   * failure, so the caller backs off.
   */
  rememberSequence(runKey: string, sequence: RunSequence, now = Date.now()): boolean {
    const record = this.records.get(runKey);
    if (!record || sequence.tripCalls.length === 0 || !isSameRunInstance(record.instance, sequence))
      return false;
    this.touchRecord(record, now);
    this.rememberSequenceReading(record, { sequence, source: "request" });
    this.publish(record);
    return true;
  }

  findRow(rowId: string): RunRowReading | undefined {
    return this.findRecord(rowId)?.rowsById.get(rowId);
  }

  markSequenceRefreshFailed(runKey: string, now: number, requestedAt = now): void {
    const record = this.records.get(runKey);
    if (!record?.latestSequence || (record.latestSequence.sequence.readAt ?? 0) > requestedAt)
      return;
    record.sequenceRefreshFailedAt = now;
    this.publish(record);
  }

  /** The fullest, freshest calling sequence read for the run this row is a stop of. */
  findSequence(rowId: string): RunSequenceReading | undefined {
    const record = this.findRecord(rowId);
    return this.canReadRun(rowId) ? record?.latestSequence : undefined;
  }

  /**
   * The row under everything read about its run. Requests nothing; stable until the run changes.
   */
  findRun(rowId: string): Departure | undefined {
    const record = this.findRecord(rowId);
    const row = record?.rowsById.get(rowId);
    if (!record || !row) return undefined;
    const cached = record.mergedByRowId.get(rowId);
    if (cached) return cached;
    const reading = mergeRunSequence(row.departure, this.findSequence(rowId)?.sequence);
    const merged =
      reading.readAt && record.sequenceRefreshFailedAt !== undefined
        ? {
            ...reading,
            readAt: { ...reading.readAt, sequenceRefreshFailedAt: record.sequenceRefreshFailedAt },
          }
        : reading;
    record.mergedByRowId.set(rowId, merged);
    return merged;
  }

  canReadRun(rowId: string): boolean {
    const record = this.findRecord(rowId);
    const row = record?.rowsById.get(rowId);
    return !!record && !!row && isSameRunInstance(record.instance, row.departure);
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
   * The freshest row known for a run, by request key; the request may outlive the row that asked.
   */
  findRunRow(runKey: string): RunRowReading | undefined {
    let freshest: RunRowReading | undefined;
    for (const row of this.records.get(runKey)?.rowsById.values() ?? []) {
      if (!this.canReadRun(row.departure.id)) continue;
      const readAt = getDepartureReadInstant(row.departure) ?? 0;
      if (!freshest || readAt > (getDepartureReadInstant(freshest.departure) ?? 0)) freshest = row;
    }
    return freshest;
  }

  /** The request-sharing key for this row's run. */
  findRunRecordKey(rowId: string): string {
    return this.rowRecordKeys.get(rowId) ?? getRowRecordKey(rowId);
  }

  private findRecord(rowId: string): RunReadingRecord | undefined {
    const key = this.rowRecordKeys.get(rowId);
    return key ? this.records.get(key) : undefined;
  }

  /** Opens or creates the record and moves it to the most recent end. */
  private openRecord(recordKey: string, departure: Departure, now: number): RunReadingRecord {
    const existing = this.records.get(recordKey);
    if (existing) return existing;
    const record: RunReadingRecord = {
      key: recordKey,
      instance: withoutCalls(departure),
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
      record.latestSequence = {
        ...reading,
        sequence: retainRunCoverage(latest?.sequence, reading.sequence),
      };
    if (
      record.sequenceRefreshFailedAt !== undefined &&
      (record.latestSequence?.sequence.readAt ?? 0) >= record.sequenceRefreshFailedAt
    )
      record.sequenceRefreshFailedAt = undefined;
    // The end is only ever learned, never moved back by a partial sequence.
    const endsAt = findFinalCallInstant(reading.sequence.tripCalls);
    if (endsAt !== undefined) record.runEndsAt = Math.max(record.runEndsAt ?? endsAt, endsAt);
  }

  /** Re-inserted so the map's order stays write recency. */
  private touchRecord(record: RunReadingRecord, now: number): void {
    record.writtenAt = now;
    this.records.delete(record.key);
    this.records.set(record.key, record);
  }

  /** Records the write and notifies once per batch, before the next paint. */
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

  /** Retires runs that are over, so a code is gone before its next use. On its own cadence. */
  private sweep(now: number): void {
    if (now - this.lastSweptAt < EVICTION_SWEEP_INTERVAL_MS) return;
    this.lastSweptAt = now;
    // Deleting the current entry during Map iteration is defined.
    for (const record of this.records.values()) {
      if (isRetired(record, now)) this.evictRecord(record);
    }
  }

  /** Enforces the cap on every write. */
  private enforceCapacity(now: number): void {
    while (this.records.size > this.capacity) {
      const evicted = this.findEvictionCandidate(now);
      if (!evicted) return;
      this.evictRecord(evicted);
    }
  }

  /** A finished run near the least-recent end, else the least recent record. */
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

  /** Enforces the row cap, least recently read first. */
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

  /** Drops a row from a record that stays, notifying its views. */
  private dropRow(record: RunReadingRecord, rowId: string): void {
    record.rowsById.delete(rowId);
    record.mergedByRowId.delete(rowId);
    this.forgetRow(record, rowId);
    this.scheduleNotification();
  }

  /** Forgets a row; the index is cleared only if it still points here. */
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

  /** Takes the row off its record, dropping the record if it empties. */
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
 * Whether nobody can still see the run: past last call plus grace, or past max age with no known
 * end. A record written within the grace stays, as a vehicle at its final stop is still on boards.
 */
const isRetired = (record: RunReadingRecord, now: number): boolean => {
  if (record.writtenAt + RUN_ENDED_GRACE_MS > now) return false;
  return record.runEndsAt !== undefined
    ? record.runEndsAt + RUN_ENDED_GRACE_MS <= now
    : record.writtenAt + RUN_READING_MAX_AGE_MS <= now;
};

/** Whether the calls have run out, without the grace; the cap only ranks. */
const hasRunEnded = (record: RunReadingRecord, now: number): boolean =>
  record.runEndsAt !== undefined && record.runEndsAt <= now;
