import type { DatedJourneyReadingRequest } from "../lib/dated-journey-reading-requests";
import { extendFailureStreak, getBackoffDelayMs, type FailureStreak } from "./refresh-backoff";

/** How long before a checkpoint departure its dated journey is re-read. */
export const CHECKPOINT_LEAD_MS = 15_000;

type PendingDatedJourney = {
  request: DatedJourneyReadingRequest;
  dueAt: number;
  entry: boolean;
  /**
   * The first refresh after the entry read, set apart from the dated journeys that entered with it.
   */
  staggered: boolean;
  inFlight: boolean;
  failure?: FailureStreak;
  /** When this dated journey's last read started. */
  lastReadAt?: number;
  /** Device instants of departures worth a fresh reading just before, ascending. */
  checkpoints: readonly number[];
};

type DueRead = { at: number; maxAgeMs: number };

/**
 * A fraction in [0, 1) fixed per dated journey, so dated journeys read together drift apart and
 * stay apart.
 */
function getDatedJourneyPhase(rowId: string): number {
  let hash = 0;
  for (let index = 0; index < rowId.length; index += 1)
    hash = (Math.imul(hash, 31) + rowId.charCodeAt(index)) >>> 0;
  return (hash % 1_000) / 1_000;
}

/** Each dated journey owns its cadence; at most six reads run concurrently. */
export class DatedJourneyReadingPoller {
  private readonly datedJourneys = new Map<string, PendingDatedJourney>();
  private checkpoints: ReadonlyMap<string, readonly number[]> = new Map();
  private timer = 0;
  private running = 0;
  private paused = document.visibilityState === "hidden";
  private stopped = false;

  private readonly read: (rowId: string, maxAgeMs: number) => Promise<unknown>;
  private readonly refreshMs: number;
  private readonly refreshOnEntry: boolean;

  constructor(
    read: (rowId: string, maxAgeMs: number) => Promise<unknown>,
    refreshMs: number,
    refreshOnEntry: boolean,
  ) {
    this.read = read;
    this.refreshMs = refreshMs;
    this.refreshOnEntry = refreshOnEntry;
  }

  update(requests: readonly DatedJourneyReadingRequest[]): void {
    const wanted = new Set(requests.map(({ rowId }) => rowId));
    for (const id of this.datedJourneys.keys()) if (!wanted.has(id)) this.datedJourneys.delete(id);
    for (const request of requests) {
      const current = this.datedJourneys.get(request.rowId);
      if (current) current.request = request;
      else
        this.datedJourneys.set(request.rowId, {
          request,
          dueAt: Date.now(),
          entry: true,
          staggered: false,
          inFlight: false,
          checkpoints: this.checkpoints.get(request.rowId) ?? [],
        });
    }
    this.pump();
  }

  /** Replaces every dated journey's checkpoints; a dated journey without an entry has none. */
  setCheckpoints(checkpoints: ReadonlyMap<string, readonly number[]>): void {
    this.checkpoints = checkpoints;
    for (const [rowId, datedJourney] of this.datedJourneys)
      datedJourney.checkpoints = checkpoints.get(rowId) ?? [];
    this.pump();
  }

  pause(): void {
    this.paused = true;
    window.clearTimeout(this.timer);
  }

  resume(forgiveFailures: boolean): void {
    this.paused = false;
    if (forgiveFailures) {
      for (const datedJourney of this.datedJourneys.values()) {
        if (datedJourney.failure) datedJourney.dueAt = Date.now();
        datedJourney.failure = undefined;
      }
    }
    this.pump();
  }

  stop(): void {
    this.stopped = true;
    window.clearTimeout(this.timer);
    this.datedJourneys.clear();
  }

  /**
   * The dated journey's next read: its cadence, or earlier where a checkpoint departure's window
   * opens and nothing has been read in it yet.
   */
  private getDueRead(datedJourney: PendingDatedJourney, now: number): DueRead {
    const lastReadAt = datedJourney.lastReadAt ?? Number.NEGATIVE_INFINITY;
    const cadence: DueRead = {
      at: datedJourney.dueAt,
      maxAgeMs:
        datedJourney.entry && this.refreshOnEntry
          ? 0
          : datedJourney.staggered
            ? Math.min(datedJourney.request.maxAgeMs, Math.max(0, now - lastReadAt))
            : datedJourney.request.maxAgeMs,
    };
    if (datedJourney.failure) return cadence;
    const checkpoint = datedJourney.checkpoints.find(
      (at) => at > now && lastReadAt < at - CHECKPOINT_LEAD_MS,
    );
    if (checkpoint === undefined) return cadence;
    const opensAt = checkpoint - CHECKPOINT_LEAD_MS;
    return opensAt < cadence.at ? { at: opensAt, maxAgeMs: Math.max(0, now - opensAt) } : cadence;
  }

  private pump(): void {
    window.clearTimeout(this.timer);
    if (this.paused || this.stopped) return;
    const now = Date.now();
    const pending = [...this.datedJourneys.values()]
      .filter((datedJourney) => !datedJourney.inFlight)
      .map((datedJourney) => ({ datedJourney, due: this.getDueRead(datedJourney, now) }))
      .sort((a, b) => a.due.at - b.due.at);
    for (const { datedJourney, due } of pending) {
      if (this.running >= 6 || due.at > now) break;
      this.running += 1;
      datedJourney.inFlight = true;
      datedJourney.lastReadAt = now;
      const wasEntry = datedJourney.entry;
      datedJourney.entry = false;
      Promise.resolve()
        .then(() => this.read(datedJourney.request.rowId, due.maxAgeMs))
        .then(
          (value) => this.settle(datedJourney, value === undefined, wasEntry),
          () => this.settle(datedJourney, true, wasEntry),
        );
    }
    if (this.running >= 6) return;
    const next = pending
      .filter(({ datedJourney }) => !datedJourney.inFlight)
      .reduce((time, { due }) => Math.min(time, due.at), Number.POSITIVE_INFINITY);
    if (Number.isFinite(next))
      this.timer = window.setTimeout(() => this.pump(), Math.max(0, next - Date.now()));
  }

  private settle(datedJourney: PendingDatedJourney, failed: boolean, wasEntry: boolean): void {
    this.running -= 1;
    datedJourney.inFlight = false;
    datedJourney.failure = failed
      ? extendFailureStreak(datedJourney.failure, "transient")
      : undefined;
    datedJourney.staggered = wasEntry && !failed;
    const interval = datedJourney.staggered
      ? this.refreshMs * (0.5 + getDatedJourneyPhase(datedJourney.request.rowId) / 2)
      : this.refreshMs;
    datedJourney.dueAt =
      Date.now() +
      (datedJourney.failure ? getBackoffDelayMs(this.refreshMs, datedJourney.failure) : interval);
    this.pump();
  }
}
