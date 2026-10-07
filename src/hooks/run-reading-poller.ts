import type { RunReadingRequest } from "../lib/run-reading-requests";
import { extendFailureStreak, getBackoffDelayMs, type FailureStreak } from "./refresh-backoff";

type PendingRun = {
  request: RunReadingRequest;
  dueAt: number;
  entry: boolean;
  inFlight: boolean;
  failure?: FailureStreak;
};

/** Each run owns its cadence; at most six reads run concurrently. */
export class RunReadingPoller {
  private readonly runs = new Map<string, PendingRun>();
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
        this.runs.set(request.rowId, { request, dueAt: Date.now(), entry: true, inFlight: false });
    }
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

  private pump(): void {
    window.clearTimeout(this.timer);
    if (this.paused || this.stopped) return;
    const pending = [...this.runs.values()]
      .filter((run) => !run.inFlight)
      .sort((a, b) => a.dueAt - b.dueAt);
    for (const run of pending) {
      if (this.running >= 6 || run.dueAt > Date.now()) break;
      this.running += 1;
      run.inFlight = true;
      const maxAgeMs = run.entry && this.refreshOnEntry ? 0 : run.request.maxAgeMs;
      run.entry = false;
      Promise.resolve()
        .then(() => this.read(run.request.rowId, maxAgeMs))
        .then(
          (value) => this.settle(run, value === undefined),
          () => this.settle(run, true),
        );
    }
    if (this.running >= 6) return;
    const next = [...this.runs.values()]
      .filter((run) => !run.inFlight)
      .reduce((time, run) => Math.min(time, run.dueAt), Number.POSITIVE_INFINITY);
    if (Number.isFinite(next))
      this.timer = window.setTimeout(() => this.pump(), Math.max(0, next - Date.now()));
  }

  private settle(run: PendingRun, failed: boolean): void {
    this.running -= 1;
    run.inFlight = false;
    run.failure = failed ? extendFailureStreak(run.failure, "transient") : undefined;
    run.dueAt =
      Date.now() + (run.failure ? getBackoffDelayMs(this.refreshMs, run.failure) : this.refreshMs);
    this.pump();
  }
}
