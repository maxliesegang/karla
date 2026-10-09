import type { RunReadingRequest } from "../lib/run-reading-requests";
import { extendFailureStreak, getBackoffDelayMs, type FailureStreak } from "./refresh-backoff";

/** How long before a checkpoint departure its run is re-read. */
export const CHECKPOINT_LEAD_MS = 15_000;

type PendingRun = {
  request: RunReadingRequest;
  dueAt: number;
  entry: boolean;
  /** The first refresh after the entry read, set apart from the runs that entered with it. */
  staggered: boolean;
  inFlight: boolean;
  failure?: FailureStreak;
  /** When this run's last read started. */
  lastReadAt?: number;
  /** Device instants of departures worth a fresh reading just before, ascending. */
  checkpoints: readonly number[];
};

type DueRead = { at: number; maxAgeMs: number };

/** A fraction in [0, 1) fixed per run, so runs read together drift apart and stay apart. */
function getRunPhase(rowId: string): number {
  let hash = 0;
  for (let index = 0; index < rowId.length; index += 1)
    hash = (Math.imul(hash, 31) + rowId.charCodeAt(index)) >>> 0;
  return (hash % 1_000) / 1_000;
}

/** Each run owns its cadence; at most six reads run concurrently. */
export class RunReadingPoller {
  private readonly runs = new Map<string, PendingRun>();
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

  update(requests: readonly RunReadingRequest[]): void {
    const wanted = new Set(requests.map(({ rowId }) => rowId));
    for (const id of this.runs.keys()) if (!wanted.has(id)) this.runs.delete(id);
    for (const request of requests) {
      const current = this.runs.get(request.rowId);
      if (current) current.request = request;
      else
        this.runs.set(request.rowId, {
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

  /** Replaces every run's checkpoints; a run without an entry has none. */
  setCheckpoints(checkpoints: ReadonlyMap<string, readonly number[]>): void {
    this.checkpoints = checkpoints;
    for (const [rowId, run] of this.runs) run.checkpoints = checkpoints.get(rowId) ?? [];
    this.pump();
  }

  pause(): void {
    this.paused = true;
    window.clearTimeout(this.timer);
  }

  resume(forgiveFailures: boolean): void {
    this.paused = false;
    if (forgiveFailures) {
      for (const run of this.runs.values()) {
        if (run.failure) run.dueAt = Date.now();
        run.failure = undefined;
      }
    }
    this.pump();
  }

  stop(): void {
    this.stopped = true;
    window.clearTimeout(this.timer);
    this.runs.clear();
  }

  /**
   * The run's next read: its cadence, or earlier where a checkpoint departure's window opens and
   * nothing has been read in it yet.
   */
  private getDueRead(run: PendingRun, now: number): DueRead {
    const lastReadAt = run.lastReadAt ?? Number.NEGATIVE_INFINITY;
    const cadence: DueRead = {
      at: run.dueAt,
      maxAgeMs:
        run.entry && this.refreshOnEntry
          ? 0
          : run.staggered
            ? Math.min(run.request.maxAgeMs, Math.max(0, now - lastReadAt))
            : run.request.maxAgeMs,
    };
    if (run.failure) return cadence;
    const checkpoint = run.checkpoints.find(
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
    const pending = [...this.runs.values()]
      .filter((run) => !run.inFlight)
      .map((run) => ({ run, due: this.getDueRead(run, now) }))
      .sort((a, b) => a.due.at - b.due.at);
    for (const { run, due } of pending) {
      if (this.running >= 6 || due.at > now) break;
      this.running += 1;
      run.inFlight = true;
      run.lastReadAt = now;
      const wasEntry = run.entry;
      run.entry = false;
      Promise.resolve()
        .then(() => this.read(run.request.rowId, due.maxAgeMs))
        .then(
          (value) => this.settle(run, value === undefined, wasEntry),
          () => this.settle(run, true, wasEntry),
        );
    }
    if (this.running >= 6) return;
    const next = pending
      .filter(({ run }) => !run.inFlight)
      .reduce((time, { due }) => Math.min(time, due.at), Number.POSITIVE_INFINITY);
    if (Number.isFinite(next))
      this.timer = window.setTimeout(() => this.pump(), Math.max(0, next - Date.now()));
  }

  private settle(run: PendingRun, failed: boolean, wasEntry: boolean): void {
    this.running -= 1;
    run.inFlight = false;
    run.failure = failed ? extendFailureStreak(run.failure, "transient") : undefined;
    run.staggered = wasEntry && !failed;
    const interval = run.staggered
      ? this.refreshMs * (0.5 + getRunPhase(run.request.rowId) / 2)
      : this.refreshMs;
    run.dueAt =
      Date.now() + (run.failure ? getBackoffDelayMs(this.refreshMs, run.failure) : interval);
    this.pump();
  }
}
