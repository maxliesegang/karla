/**
 * Measures what the feed actually states at a terminus, so a turnaround pairing can be built on
 * evidence rather than on a time window alone (`src/lib/line-turnarounds.ts`).
 *
 * Nothing publishes which arrival becomes which departure. Three things might still carry it, and
 * none of them is answerable by reading the app:
 *
 * 1. **What scheduled turn does the line run at this terminus?** A gap that holds across every run
 *    of a period can be paired against where a fixed window is a guess. But it is only ever known
 *    modulo the headway: an arrival turning out `g` minutes later and one turning out `g + headway`
 *    later fit the same timetable, differing by one more vehicle standing one more turn. The
 *    headway is printed beside the gap because it is the whole of what the gap can be trusted to.
 *    Where the two are equal, or the gap is zero, the minimal reading is not physically possible
 *    and the probe says so rather than reporting a turn.
 * 2. **Does the departure share the arrival's platform?** A stub track turns on one platform; a
 *    loop or a multi-track terminus does not. Where it holds it breaks ties the window cannot.
 * 3. **Does a run carry the vehicle's deviation before it starts?** In an ITCS a not-yet-started
 *    trip inherits the lateness of the vehicle assigned to it. If KVV publishes that, a departure
 *    delay before departure that matches the arriving run's lateness is the nearest thing the
 *    feed has to saying "same vehicle" — and a predicted departure earlier than the predicted
 *    arrival is a pairing the feed itself rules out.
 *
 *     npm run probe:turnarounds -- [options]
 *
 *       --stops 7000314,7004500   provider stop ids of termini to watch
 *       --interval 60             seconds between polls (default 60)
 *       --minutes 20              how long to run (default 20)
 *       --out probe.jsonl         also write every reading, for analysis afterwards
 *
 * For each terminus the probe reads its own board, where the runs *starting* there are rows, and
 * the boards of the stops those runs call at next, where the runs *ending* at the terminus are
 * rows with their final call still ahead. It polls to see the departure delay of an unstarted run
 * as it develops, which one reading cannot show. A diagnostic run by hand, then stopped.
 */

import { appendFile } from "node:fs/promises";
import { KvvEfaClient } from "../src/data/kvv-efa-client.ts";
import type { KvvDeparture, KvvTripCall } from "../src/data/kvv-efa-parsers.ts";

/** The two calls the feed marks as ends of a run — the same reading `lib/trip-calls.ts` makes. */
const statesRunStart = (call: KvvTripCall): boolean =>
  call.scheduledDepartureTime !== undefined && call.scheduledArrivalTime === undefined;
const statesRunEnd = (call: KvvTripCall): boolean =>
  call.scheduledArrivalTime !== undefined && call.scheduledDepartureTime === undefined;

const DEFAULT_TERMINUS_IDS = ["7000314", "7004500", "7000013", "7000089", "7000090", "7000084"];
const DEFAULT_INTERVAL_SECONDS = 60;
const DEFAULT_MINUTES = 20;
/** Rows per board — a terminus lists one direction only, so twenty rows reach far enough. */
const BOARD_ROW_LIMIT = 30;
/** How many neighbouring stops are read for arrivals — one per approach track is enough. */
const NEIGHBOUR_LIMIT = 3;
/** Below this much slack the arrival's lateness has to show on the departure, if it ever does. */
const MIN_TURN_MS = 60_000;
/** The furthest a scheduled departure is looked at past a scheduled arrival. */
const SCHEDULED_PAIRING_HORIZON_MS = 30 * 60_000;

type Options = {
  terminusIds: string[];
  intervalMs: number;
  durationMs: number;
  outPath?: string;
};

function parseOptions(argv: readonly string[]): Options {
  const read = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const number = (name: string, fallback: number): number => {
    const value = Number(read(name));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    terminusIds: (read("stops") ?? DEFAULT_TERMINUS_IDS.join(",")).split(",").filter(Boolean),
    intervalMs: number("interval", DEFAULT_INTERVAL_SECONDS) * 1_000,
    durationMs: number("minutes", DEFAULT_MINUTES) * 60_000,
    outPath: read("out"),
  };
}

const toInstant = (value: string | undefined): number | undefined => {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};

const clock = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const hhmm = (instant: number | undefined): string =>
  instant === undefined ? "—" : clock.format(new Date(instant));
const minutes = (ms: number): string => `${(ms / 60_000).toFixed(1)}`;

const getTripKey = (departure: KvvDeparture): string =>
  departure.tripInstanceId ??
  departure.tripId ??
  `${departure.lineId}@${departure.scheduledDepartureTime}`;

/** One reading of a run's first call, taken while (or after) it stood at the terminus. */
type StartReading = {
  feedNow: number;
  /** The row's own headline deviation; `undefined` is the feed monitoring nothing yet. */
  rowDelayMinutes?: number;
  /** The first call's departure deviation as the sequence states it. */
  callDelayMinutes?: number;
  status: KvvDeparture["status"];
};

type Start = {
  key: string;
  lineId: string;
  directionId?: string;
  destination: string;
  scheduledDeparture: number;
  platform?: string;
  /** The stop the run calls at next — where its arrival counterpart is read. */
  nextStopPointId?: string;
  readings: StartReading[];
};

type Arrival = {
  key: string;
  lineId: string;
  directionId?: string;
  origin: string;
  scheduledArrival: number;
  platform?: string;
  /** Latest stated arrival deviation at the terminus; `undefined` where none was stated. */
  arrivalDelayMinutes?: number;
  lastSeenAt: number;
};

type TerminusRecord = {
  stopPointId: string;
  stopName?: string;
  /** Every stop point the terminus answers with — a complex reports several. */
  stopPointIds: Set<string>;
  neighbourIds: Set<string>;
  starts: Map<string, Start>;
  arrivals: Map<string, Arrival>;
  polls: number;
};

const terminusById = new Map<string, TerminusRecord>();
let pollCount = 0;

function isAtTerminus(call: KvvTripCall, terminus: TerminusRecord): boolean {
  return (
    (call.providerId !== undefined && terminus.stopPointIds.has(call.providerId)) ||
    (terminus.stopName !== undefined && call.stopName === terminus.stopName)
  );
}

async function readStarts(
  client: KvvEfaClient,
  terminus: TerminusRecord,
  options: Options,
): Promise<void> {
  const board = await client.fetchDepartureBoard(terminus.stopPointId, {
    includeTripCalls: true,
    limit: BOARD_ROW_LIMIT,
  });
  const feedNow = toInstant(board.serverTime) ?? Date.now();
  terminus.stopName ??= board.stopName;
  terminus.polls += 1;
  for (const departure of board.departures) {
    terminus.stopPointIds.add(departure.stopPointId);
    const calls = departure.tripCalls ?? [];
    const first = calls[0];
    if (!first || !statesRunStart(first) || !isAtTerminus(first, terminus)) continue;
    const scheduledDeparture = toInstant(first.scheduledDepartureTime);
    if (scheduledDeparture === undefined) continue;
    const key = getTripKey(departure);
    const nextStopPointId = calls.find((call) => !isAtTerminus(call, terminus))?.providerId;
    if (nextStopPointId && terminus.neighbourIds.size < NEIGHBOUR_LIMIT) {
      terminus.neighbourIds.add(nextStopPointId);
    }
    const start = terminus.starts.get(key) ?? {
      key,
      lineId: departure.lineId,
      directionId: departure.routeDirectionId,
      destination: departure.destination,
      scheduledDeparture,
      platform: departure.platformCode || first.platformCode,
      nextStopPointId,
      readings: [],
    };
    start.readings.push({
      feedNow,
      rowDelayMinutes: departure.delayMinutes,
      callDelayMinutes: first.delayMinutes,
      status: departure.status,
    });
    terminus.starts.set(key, start);
    if (options.outPath) {
      await appendFile(
        options.outPath,
        `${JSON.stringify({
          kind: "start",
          terminus: terminus.stopPointId,
          serverTime: board.serverTime,
          key,
          lineId: departure.lineId,
          scheduledDeparture: first.scheduledDepartureTime,
          platform: start.platform,
          rowDelayMinutes: departure.delayMinutes,
          callDelayMinutes: first.delayMinutes,
          status: departure.status,
        })}\n`,
      );
    }
  }
}

async function readArrivals(
  client: KvvEfaClient,
  terminus: TerminusRecord,
  neighbourId: string,
  options: Options,
): Promise<void> {
  const board = await client.fetchDepartureBoard(neighbourId, {
    includeTripCalls: true,
    limit: BOARD_ROW_LIMIT,
  });
  const feedNow = toInstant(board.serverTime) ?? Date.now();
  for (const departure of board.departures) {
    const calls = departure.tripCalls ?? [];
    const last = calls[calls.length - 1];
    if (!last || !statesRunEnd(last) || !isAtTerminus(last, terminus)) continue;
    const scheduledArrival = toInstant(last.scheduledArrivalTime);
    if (scheduledArrival === undefined) continue;
    const key = getTripKey(departure);
    const arrivalDelayMinutes = last.arrivalDelayMinutes ?? last.delayMinutes;
    terminus.arrivals.set(key, {
      key,
      lineId: departure.lineId,
      directionId: departure.routeDirectionId,
      origin: calls[0]?.stopName ?? "?",
      scheduledArrival,
      platform: last.platformCode,
      arrivalDelayMinutes: arrivalDelayMinutes ?? terminus.arrivals.get(key)?.arrivalDelayMinutes,
      lastSeenAt: feedNow,
    });
    if (options.outPath) {
      await appendFile(
        options.outPath,
        `${JSON.stringify({
          kind: "arrival",
          terminus: terminus.stopPointId,
          neighbour: neighbourId,
          serverTime: board.serverTime,
          key,
          lineId: departure.lineId,
          scheduledArrival: last.scheduledArrivalTime,
          platform: last.platformCode,
          arrivalDelayMinutes,
          status: departure.status,
        })}\n`,
      );
    }
  }
}

async function poll(client: KvvEfaClient, options: Options): Promise<void> {
  pollCount += 1;
  for (const terminus of terminusById.values()) {
    await readStarts(client, terminus, options).catch((error) =>
      console.error(`\nterminus ${terminus.stopPointId}:`, error),
    );
    for (const neighbourId of terminus.neighbourIds) {
      await readArrivals(client, terminus, neighbourId, options).catch((error) =>
        console.error(`\nneighbour ${neighbourId}:`, error),
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Report

type Pair = { arrival: Arrival; start: Start; scheduledGapMs: number };

/**
 * Arrivals to starts on scheduled times, in arrival order, each arrival taking the nearest later
 * start of its line not yet taken — the FIFO the platform imposes, on the timetable's own times.
 *
 * The *minimal* pairing, and only that: it assumes no vehicle stands through a departure, which is
 * exactly what a published gap of zero disproves. Read the gaps beside the headway below, never on
 * their own. Over a long enough window this also drifts, because a terminus beside a depot starts
 * runs no arrival accounts for and every later arrival is then pushed one departure along.
 */
function pairOnSchedule(arrivals: readonly Arrival[], starts: readonly Start[]): Pair[] {
  const pairs: Pair[] = [];
  const taken = new Set<string>();
  const sortedStarts = [...starts].sort((a, b) => a.scheduledDeparture - b.scheduledDeparture);
  for (const arrival of [...arrivals].sort((a, b) => a.scheduledArrival - b.scheduledArrival)) {
    const start = sortedStarts.find(
      (candidate) =>
        !taken.has(candidate.key) &&
        candidate.lineId === arrival.lineId &&
        candidate.scheduledDeparture >= arrival.scheduledArrival &&
        candidate.scheduledDeparture - arrival.scheduledArrival <= SCHEDULED_PAIRING_HORIZON_MS,
    );
    if (!start) continue;
    taken.add(start.key);
    pairs.push({
      arrival,
      start,
      scheduledGapMs: start.scheduledDeparture - arrival.scheduledArrival,
    });
  }
  return pairs;
}

/** The interval the line repeats on here, as the commonest gap between consecutive events. */
function findHeadwayMinutes(instants: readonly number[]): number | undefined {
  const sorted = [...new Set(instants)].sort((left, right) => left - right);
  const counts = new Map<number, number>();
  for (let index = 1; index < sorted.length; index += 1) {
    const gap = Math.round((sorted[index] - sorted[index - 1]) / 60_000);
    if (gap > 0) counts.set(gap, (counts.get(gap) ?? 0) + 1);
  }
  let best: number | undefined;
  for (const [gap, count] of counts) {
    if (best === undefined || count > (counts.get(best) ?? 0)) best = gap;
  }
  return best;
}

function histogram(values: readonly number[]): string {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => a[0] - b[0])
    .map(([value, count]) => `${value} min ×${count}`)
    .join(", ");
}

/** The deviation a start stated before its scheduled departure, at the last reading before it. */
function findPreDepartureReading(start: Start): StartReading | undefined {
  const before = start.readings.filter(
    ({ feedNow }) => feedNow < start.scheduledDeparture - 30_000,
  );
  return before[before.length - 1];
}

function reportTerminus(terminus: TerminusRecord): void {
  const arrivals = [...terminus.arrivals.values()];
  const starts = [...terminus.starts.values()];
  console.log(`\n=== ${terminus.stopName ?? terminus.stopPointId} (${terminus.stopPointId}) ===`);
  console.log(
    `polls ${terminus.polls}; neighbours read ${[...terminus.neighbourIds].join(", ") || "none"}`,
  );
  console.log(`runs starting here ${starts.length}; runs ending here ${arrivals.length}`);
  if (starts.length === 0) return;

  // 1. Scheduled turn time per line.
  console.log("\n— 1. scheduled turn, by line — the minimal pairing, read against the headway —");
  const pairs = pairOnSchedule(arrivals, starts);
  const byLine = new Map<string, Pair[]>();
  for (const pair of pairs)
    byLine.set(pair.start.lineId, [...(byLine.get(pair.start.lineId) ?? []), pair]);
  for (const [lineId, linePairs] of byLine) {
    const headway = findHeadwayMinutes(
      starts
        .filter((start) => start.lineId === lineId)
        .map(({ scheduledDeparture }) => scheduledDeparture),
    );
    const gaps = linePairs.map(({ scheduledGapMs }) => Math.round(scheduledGapMs / 60_000));
    // A turn of a whole number of headways is the one reading the platform rules out: no vehicle
    // arrives and leaves at the same instant, so the real turn is at least one headway longer.
    const isDegenerate = gaps.some(
      (gap) => gap === 0 || (headway !== undefined && headway > 0 && gap % headway === 0),
    );
    console.log(
      `  ${lineId.padEnd(4)} headway ${String(headway ?? "?").padStart(2)} min   turn ${histogram(gaps)}` +
        (isDegenerate ? "   ← a whole number of headways: not a turn any vehicle can run" : ""),
    );
  }
  const unpairedArrivals = arrivals.filter((a) => !pairs.some((p) => p.arrival.key === a.key));
  if (unpairedArrivals.length > 0) {
    console.log(
      `  arrivals with no start of their line within ${minutes(SCHEDULED_PAIRING_HORIZON_MS)} min: ${unpairedArrivals
        .map((a) => `${a.lineId}@${hhmm(a.scheduledArrival)}`)
        .join(", ")}`,
    );
  }
  console.log(
    "  → one value per line fixes the turn for this period only, and only modulo the headway:\n" +
      "    the same timetable is satisfied by that turn plus any number of headways, each with one\n" +
      "    more vehicle standing. Compare periods before treating a value as the terminus's.",
  );

  // 2. Platforms.
  console.log("\n— 2. platform: does the start leave from the platform the arrival came in on? —");
  const platformTally = { same: 0, different: 0, unknown: 0 };
  for (const { arrival, start } of pairs) {
    if (!arrival.platform || !start.platform) platformTally.unknown += 1;
    else if (arrival.platform === start.platform) platformTally.same += 1;
    else platformTally.different += 1;
  }
  console.log(
    `  same ${platformTally.same}, different ${platformTally.different}, unknown ${platformTally.unknown}`,
  );
  const platformsSeen = new Set([
    ...pairs.map((p) => p.arrival.platform),
    ...pairs.map((p) => p.start.platform),
  ]);
  console.log(`  platforms seen: ${[...platformsSeen].filter(Boolean).join(", ") || "none"}`);

  // 3. Realtime before departure.
  console.log("\n— 3. does an unstarted run carry a deviation, and whose? —");
  const monitoredBefore = starts.filter((start) => {
    const reading = findPreDepartureReading(start);
    return (
      reading !== undefined && (reading.rowDelayMinutes ?? reading.callDelayMinutes) !== undefined
    );
  });
  const observedBefore = starts.filter((start) => findPreDepartureReading(start) !== undefined);
  console.log(
    `  starts read ≥30 s before their scheduled departure: ${observedBefore.length}; of those with a stated deviation: ${monitoredBefore.length}`,
  );
  const leads = starts.flatMap((start) => {
    const first = start.readings.find(
      (r) => (r.rowDelayMinutes ?? r.callDelayMinutes) !== undefined,
    );
    return first ? [Math.round((start.scheduledDeparture - first.feedNow) / 60_000)] : [];
  });
  if (leads.length > 0) {
    console.log(
      `  minutes before scheduled departure a deviation was first seen: ${histogram(leads)}`,
    );
    console.log("    (bounded by when the row first entered the board and by the poll interval)");
  }
  console.log(
    "\n  pair                              arr sched  arr Δ  dep sched  slack  dep Δ before dep  (readings)",
  );
  for (const { arrival, start, scheduledGapMs } of pairs) {
    const reading = findPreDepartureReading(start);
    const depDelay = reading ? (reading.rowDelayMinutes ?? reading.callDelayMinutes) : undefined;
    const arrivalDelay = arrival.arrivalDelayMinutes;
    const slackMs = arrivalDelay === undefined ? undefined : scheduledGapMs - arrivalDelay * 60_000;
    // The feed's own two predictions, compared as instants: a departure it times before the
    // arrival it would turn out of is a pairing the feed itself rules out.
    const predictedGapMs =
      arrivalDelay === undefined || depDelay === undefined
        ? undefined
        : scheduledGapMs + (depDelay - arrivalDelay) * 60_000;
    const series = start.readings
      .filter(({ feedNow }) => feedNow < start.scheduledDeparture + 60_000)
      .map((r) => `${r.rowDelayMinutes ?? r.callDelayMinutes ?? "·"}`)
      .join("");
    const verdict =
      depDelay === undefined
        ? arrivalDelay === undefined
          ? ""
          : "  no dep Δ stated"
        : predictedGapMs === undefined
          ? ""
          : predictedGapMs >= 0
            ? slackMs !== undefined && slackMs < MIN_TURN_MS
              ? "  ✓ consistent, and the arrival was late enough to test it"
              : "  ✓ consistent"
            : "  ✗ dep before arrival";
    console.log(
      `  ${`${start.lineId} ${arrival.origin.slice(0, 12)}→${start.destination.slice(0, 12)}`.padEnd(34)}` +
        `${hhmm(arrival.scheduledArrival)}   ${String(arrivalDelay ?? "—").padStart(4)}   ` +
        `${hhmm(start.scheduledDeparture)}   ${slackMs === undefined ? "  —" : minutes(slackMs).padStart(5)}  ` +
        `${String(depDelay ?? "—").padStart(5)}             (${series || "none"})${verdict}`,
    );
  }
  console.log(
    "  → a stated 0 before departure is not evidence either way: it is what a correctly predicted\n" +
      "    departure says and what an unmonitored one says. Only a departure whose vehicle is known\n" +
      "    to be late tests this, and knowing that needs the pairing itself.",
  );
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const client = new KvvEfaClient();
  for (const stopPointId of options.terminusIds) {
    terminusById.set(stopPointId, {
      stopPointId,
      stopPointIds: new Set([stopPointId]),
      neighbourIds: new Set(),
      starts: new Map(),
      arrivals: new Map(),
      polls: 0,
    });
  }
  const endsAt = Date.now() + options.durationMs;
  console.log(
    `Watching termini ${options.terminusIds.join(", ")} every ${options.intervalMs / 1_000} s for ${Math.round(options.durationMs / 60_000)} min.`,
  );
  console.log("Ctrl-C stops early and still reports.\n");

  let stopped = false;
  process.on("SIGINT", () => {
    stopped = true;
  });

  while (!stopped && Date.now() < endsAt) {
    const startedAt = Date.now();
    await poll(client, options).catch((error) => console.error("poll failed:", error));
    const totals = [...terminusById.values()].reduce(
      (sum, t) => ({
        starts: sum.starts + t.starts.size,
        arrivals: sum.arrivals + t.arrivals.size,
      }),
      { starts: 0, arrivals: 0 },
    );
    process.stdout.write(
      `\rpoll ${pollCount}: ${totals.starts} starts, ${totals.arrivals} arrivals  `,
    );
    const waitMs = Math.max(0, options.intervalMs - (Date.now() - startedAt));
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  console.log("\n");
  for (const terminus of terminusById.values()) reportTerminus(terminus);
  if (options.outPath) console.log(`\nReadings written to ${options.outPath}`);
}

await main();
