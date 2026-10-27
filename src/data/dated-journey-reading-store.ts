import {
  findFinalCallInstant,
  mergeDatedJourneySequence,
  retainDatedJourneyCoverage,
} from "../lib/calls";
import {
  getStopEventReadInstant,
  isBetterSequence,
  withoutDatedJourneyCalls,
} from "../lib/journeys";
import {
  getDatedJourneyScheduleInstant,
  isSameDatedJourneyInstance,
} from "../lib/dated-journey-instance";
import type { JourneyLocator } from "./feed";
import type { StopEvent, DatedJourneyCalls } from "./transit-types";

/** Runs whose evidence is retained this session. */
export const DATED_JOURNEY_READING_STORE_CAPACITY = 1_024;

/**
 * How long after a dated journey's last call its evidence is kept, so a mark can outlive the
 * boards.
 */
export const DATED_JOURNEY_ENDED_GRACE_MS = 10 * 60_000;

/**
 * How long a record with no known end lasts: longer than any KVV dated journey, well under a day.
 */
export const DATED_JOURNEY_READING_MAX_AGE_MS = 4 * 60 * 60_000;

/** How often the store sweeps for evidence to retire. */
const EVICTION_SWEEP_INTERVAL_MS = 60_000;

/** A bound against a provider naming endless rows for one dated journey. */
const DATED_JOURNEY_RECORD_ROW_CAPACITY = 64;

/** How far into the least-recent end the cap looks for a finished dated journey first. */
const ENDED_DATED_JOURNEY_SCAN_DEPTH = 32;

/**
 * One stop's row of a dated journey and its locator, without calls: a board's embedded calls are
 * its own observation, never the dated journey's reading (`rememberSequence` is the only source).
 */
export type DatedJourneyRowReading = { stopEvent: StopEvent; locator?: JourneyLocator };

type DatedJourneyReadingRecord = {
  key: string;
  instance: StopEvent;
  rowsById: Map<string, DatedJourneyRowReading>;
  /**
   * Rows merged with the sequence, cached so `findDatedJourney` keeps returning the same object until a
   * write.
   */
  mergedByRowId: Map<string, StopEvent>;
  latestSequence?: DatedJourneyCalls;
  sequenceRefreshFailedAt?: number;
  /** When the fullest sequence has the dated journey reaching its last call. */
  datedJourneyEndsAt?: number;
  /** The last write; the only clock a dated journey with no known end has. */
  writtenAt: number;
};

/**
 * A dated journey's record key: the provider's `lineRef|journeyCode`, undated. A row without
 * locator uses its own id.
 */
const getJourneyRecordKey = (stopEvent: StopEvent, locator: JourneyLocator | undefined): string =>
  locator ? `run:${locator.lineRef}|${locator.journeyCode}` : getRowRecordKey(stopEvent.id);

const getRowRecordKey = (rowId: string): string => `row:${rowId}`;

/**
 * One bounded record per undated record key; foreign operating instances never share calls.
 */
export class DatedJourneyReadingStore {
  /** Insertion order is write recency, which the cap falls back on. */
  private readonly records = new Map<string, DatedJourneyReadingRecord>();
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

  constructor(capacity: number = DATED_JOURNEY_READING_STORE_CAPACITY) {
    this.capacity = capacity;
  }

  clear(): void {
    for (const record of this.records.values()) this.evictRecord(record);
  }

  /**
   * `now` only decides which dated journeys are over; the row dates itself (`StopEvent.readAt`).
   */
  rememberRow(stopEvent: StopEvent, locator: JourneyLocator | undefined, now = Date.now()): void {
    // Sweep first, or tomorrow's row with the same key would reopen yesterday's record.
    this.sweep(now);
    const recordKey = getJourneyRecordKey(stopEvent, locator);
    const record = this.openRecord(recordKey, stopEvent, now);

    // A row that learned its locator moves to that dated journey's record.
    const previousKey = this.rowRecordKeys.get(stopEvent.id);
    if (previousKey !== undefined && previousKey !== recordKey) this.detachRow(stopEvent.id);

    const incomingAt = getDatedJourneyScheduleInstant(stopEvent);
    const instanceAt = getDatedJourneyScheduleInstant(record.instance);
    if (
      !isSameDatedJourneyInstance(record.instance, stopEvent) &&
      incomingAt !== undefined &&
      instanceAt !== undefined &&
      Math.abs(incomingAt - now) < Math.abs(instanceAt - now)
    ) {
      record.instance = withoutDatedJourneyCalls(stopEvent);
      record.latestSequence = undefined;
      record.sequenceRefreshFailedAt = undefined;
      record.datedJourneyEndsAt = undefined;
    }
    if (isSameDatedJourneyInstance(record.instance, stopEvent)) {
      this.touchRecord(record, now);
      // A board's calls are only its observation, but they still say how long the dated journey
      // lasts.
      this.learnDatedJourneyEnd(record, stopEvent.calls);
    }

    // Re-inserted so the row cap drops the least recently read first.
    record.rowsById.delete(stopEvent.id);
    record.rowsById.set(stopEvent.id, {
      stopEvent: withoutDatedJourneyCalls(stopEvent),
      ...(locator ? { locator } : {}),
    });
    this.rowRecordKeys.set(stopEvent.id, recordKey);
    this.enforceRowCapacity(record);

    this.enforceCapacity(now);
    this.publish(record);
  }

  /**
   * Returns whether a record was there to receive it; an answer landing nowhere counts as a
   * failure, so the caller backs off.
   */
  rememberSequence(
    datedJourneyKey: string,
    sequence: DatedJourneyCalls,
    now = Date.now(),
  ): boolean {
    const record = this.records.get(datedJourneyKey);
    if (
      !record ||
      sequence.calls.length === 0 ||
      !isSameDatedJourneyInstance(record.instance, sequence)
    )
      return false;
    this.touchRecord(record, now);
    this.rememberSequenceReading(record, sequence);
    this.publish(record);
    return true;
  }

  findRow(rowId: string): DatedJourneyRowReading | undefined {
    return this.findRecord(rowId)?.rowsById.get(rowId);
  }

  markSequenceRefreshFailed(datedJourneyKey: string, now: number, requestedAt = now): void {
    const record = this.records.get(datedJourneyKey);
    // A first read that fails is marked too, so a view can tell a failed read from a pending one.
    if (!record || (record.latestSequence?.readAt ?? 0) > requestedAt) return;
    record.sequenceRefreshFailedAt = now;
    this.publish(record);
  }

  /**
   * The fullest, freshest calling sequence requested for the dated journey this row is a stop of.
   */
  findSequence(rowId: string): DatedJourneyCalls | undefined {
    const record = this.findRecord(rowId);
    return this.canReadDatedJourney(rowId) ? record?.latestSequence : undefined;
  }

  /**
   * The row under everything read about its dated journey. Requests nothing; stable until the dated
   * journey changes.
   */
  findDatedJourney(rowId: string): StopEvent | undefined {
    const record = this.findRecord(rowId);
    const row = record?.rowsById.get(rowId);
    if (!record || !row) return undefined;
    const cached = record.mergedByRowId.get(rowId);
    if (cached) return cached;
    const reading = mergeDatedJourneySequence(row.stopEvent, this.findSequence(rowId));
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

  canReadDatedJourney(rowId: string): boolean {
    const record = this.findRecord(rowId);
    const row = record?.rowsById.get(rowId);
    return !!record && !!row && isSameDatedJourneyInstance(record.instance, row.stopEvent);
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
   * The freshest row known for a dated journey, by request key; the request may outlive the row
   * that asked.
   */
  findDatedJourneyRow(datedJourneyKey: string): DatedJourneyRowReading | undefined {
    let freshest: DatedJourneyRowReading | undefined;
    for (const row of this.records.get(datedJourneyKey)?.rowsById.values() ?? []) {
      if (!this.canReadDatedJourney(row.stopEvent.id)) continue;
      const readAt = getStopEventReadInstant(row.stopEvent) ?? 0;
      if (!freshest || readAt > (getStopEventReadInstant(freshest.stopEvent) ?? 0)) freshest = row;
    }
    return freshest;
  }

  /** The request-sharing key for this row's dated journey. */
  findJourneyRecordKey(rowId: string): string {
    return this.rowRecordKeys.get(rowId) ?? getRowRecordKey(rowId);
  }

  private findRecord(rowId: string): DatedJourneyReadingRecord | undefined {
    const key = this.rowRecordKeys.get(rowId);
    return key ? this.records.get(key) : undefined;
  }

  /** Opens or creates the record and moves it to the most recent end. */
  private openRecord(
    recordKey: string,
    stopEvent: StopEvent,
    now: number,
  ): DatedJourneyReadingRecord {
    const existing = this.records.get(recordKey);
    if (existing) return existing;
    const record: DatedJourneyReadingRecord = {
      key: recordKey,
      instance: withoutDatedJourneyCalls(stopEvent),
      rowsById: new Map(),
      mergedByRowId: new Map(),
      writtenAt: now,
    };
    this.records.set(recordKey, record);
    return record;
  }

  private rememberSequenceReading(
    record: DatedJourneyReadingRecord,
    sequence: DatedJourneyCalls,
  ): void {
    const latest = record.latestSequence;
    if (!latest || isBetterSequence(sequence, latest))
      record.latestSequence = retainDatedJourneyCoverage(latest, sequence);
    if (
      record.sequenceRefreshFailedAt !== undefined &&
      (record.latestSequence?.readAt ?? 0) >= record.sequenceRefreshFailedAt
    )
      record.sequenceRefreshFailedAt = undefined;
    this.learnDatedJourneyEnd(record, sequence.calls);
  }

  /** The end is only ever learned, never moved back by a partial sequence. */
  private learnDatedJourneyEnd(record: DatedJourneyReadingRecord, calls: StopEvent["calls"]): void {
    const endsAt = findFinalCallInstant(calls);
    if (endsAt !== undefined)
      record.datedJourneyEndsAt = Math.max(record.datedJourneyEndsAt ?? endsAt, endsAt);
  }

  /** Re-inserted so the map's order stays write recency. */
  private touchRecord(record: DatedJourneyReadingRecord, now: number): void {
    record.writtenAt = now;
    this.records.delete(record.key);
    this.records.set(record.key, record);
  }

  /** Records the write and notifies once per batch, before the next paint. */
  private publish(record: DatedJourneyReadingRecord): void {
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
   * Retires dated journeys that are over, so a code is gone before its next use. On its own
   * cadence.
   */
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

  /** A finished dated journey near the least-recent end, else the least recent record. */
  private findEvictionCandidate(now: number): DatedJourneyReadingRecord | undefined {
    let leastRecent: DatedJourneyReadingRecord | undefined;
    let scanned = 0;
    for (const record of this.records.values()) {
      leastRecent ??= record;
      if (hasDatedJourneyEnded(record, now)) return record;
      if (++scanned >= ENDED_DATED_JOURNEY_SCAN_DEPTH) break;
    }
    return leastRecent;
  }

  /** Enforces the row cap, least recently read first. */
  private enforceRowCapacity(record: DatedJourneyReadingRecord): void {
    while (record.rowsById.size > DATED_JOURNEY_RECORD_ROW_CAPACITY) {
      const oldest = record.rowsById.keys().next().value;
      if (oldest === undefined) return;
      this.dropRow(record, oldest);
    }
  }

  private evictRecord(record: DatedJourneyReadingRecord): void {
    for (const rowId of record.rowsById.keys()) {
      this.forgetRow(record, rowId);
    }
    this.records.delete(record.key);
    this.scheduleNotification();
  }

  /** Drops a row from a record that stays, notifying its views. */
  private dropRow(record: DatedJourneyReadingRecord, rowId: string): void {
    record.rowsById.delete(rowId);
    record.mergedByRowId.delete(rowId);
    this.forgetRow(record, rowId);
    this.scheduleNotification();
  }

  /** Forgets a row; the index is cleared only if it still points here. */
  private forgetRow(record: DatedJourneyReadingRecord, rowId: string): void {
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

/**
 * Whether nobody can still see the dated journey: past last call plus grace, or past max age with
 * no known end. A record written within the grace stays, as a vehicle at its final stop is still on
 * boards.
 */
const isRetired = (record: DatedJourneyReadingRecord, now: number): boolean => {
  if (record.writtenAt + DATED_JOURNEY_ENDED_GRACE_MS > now) return false;
  return record.datedJourneyEndsAt !== undefined
    ? record.datedJourneyEndsAt + DATED_JOURNEY_ENDED_GRACE_MS <= now
    : record.writtenAt + DATED_JOURNEY_READING_MAX_AGE_MS <= now;
};

/** Whether the calls have run out, without the grace; the cap only ranks. */
const hasDatedJourneyEnded = (record: DatedJourneyReadingRecord, now: number): boolean =>
  record.datedJourneyEndsAt !== undefined && record.datedJourneyEndsAt <= now;
