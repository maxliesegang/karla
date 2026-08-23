/**
 * Measures how fast the KVV feed actually produces new information, so a refresh cadence can be
 * chosen from evidence instead of from a guess.
 *
 * Two questions, and neither is answerable by reading the app:
 *
 * 1. **Does the feed have a production cycle?** If `parameters.serverTime` is simply the instant
 *    the request arrived, there is no phase to align a poll to and any scheme that re-times the
 *    polls is dead on arrival. If instead it lands on a repeating boundary, sampling just after
 *    production buys freshness for the same number of requests.
 * 2. **When does a deviation actually change?** A mark's error is bounded below by how often the
 *    number behind it moves. If a trip's delay changes every four minutes, a thirty-second cadence
 *    is already sampling four times more often than the data changes and no re-timing can help; if
 *    it changes every forty seconds, the cadence is the binding constraint. And *where the vehicle
 *    was* when it changed decides whether the useful moments are stop events or anywhere at all —
 *    the difference between refreshing at a departure and refreshing mid-link.
 *
 *     npm run probe:cadence -- [options]
 *
 *       --stops 7000037,7000090   provider stop ids to watch (default: Europaplatz, Hauptbahnhof)
 *       --interval 10             seconds between polls (default 10)
 *       --minutes 30              how long to run (default 30)
 *       --out probe.jsonl         also write every reading, for analysis afterwards
 *
 * This polls faster than the app ever does, on purpose — the point is to see the changes a
 * thirty-second cadence would blur together. It is a diagnostic run by hand, not something the app
 * does: the operator's own map polls its vehicle endpoint every five seconds, but that is their
 * budget to spend, and this should be run for the length of one measurement and then stopped.
 */

import { appendFile } from "node:fs/promises";
import { KvvEfaClient } from "../src/data/kvv-efa-client.ts";
import type { KvvDeparture, KvvTripCall } from "../src/data/kvv-efa-parsers.ts";

const DEFAULT_STOP_POINT_IDS = ["7000037", "7000090"];
const DEFAULT_INTERVAL_SECONDS = 10;
const DEFAULT_MINUTES = 30;

type Options = {
  stopPointIds: string[];
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
    stopPointIds: (read("stops") ?? DEFAULT_STOP_POINT_IDS.join(",")).split(",").filter(Boolean),
    intervalMs: number("interval", DEFAULT_INTERVAL_SECONDS) * 1_000,
    durationMs: number("minutes", DEFAULT_MINUTES) * 60_000,
    outPath: read("out"),
  };
}

/** One reading of one trip: the deviations it stated, and where it said the vehicle was. */
type TripReading = {
  /** The deviation the row states at the stop it was read from — what the countdown is built on. */
  rowDelayMinutes?: number;
  /** Every call's deviation, keyed the way the app keys calls, so a re-cut sequence still matches. */
  delayByCall: Map<string, number>;
  /**
   * How far along its current link the vehicle was, 0 at the stop behind and 1 at the stop ahead.
   * Read from the call times alone, so a change can be attributed to a place on the route.
   */
  linkPhase?: number;
};

const toInstant = (value: string | undefined): number | undefined => {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** The expected time at a call: its schedule shifted by whatever deviation is stated for it. */
function getCallInstant(call: KvvTripCall): number | undefined {
  const scheduled = toInstant(call.scheduledDepartureTime ?? call.scheduledArrivalTime);
  return scheduled === undefined ? undefined : scheduled + (call.delayMinutes ?? 0) * 60_000;
}

/**
 * Where along its route the vehicle was when this reading was taken, as a fraction of the link it
 * is on. Deliberately the plain reading of the published times rather than the app's smoothed one:
 * the question is what the *feed* said, not what a diagram drew.
 */
function getLinkPhase(calls: readonly KvvTripCall[], feedNow: number): number | undefined {
  for (let index = 0; index < calls.length - 1; index += 1) {
    const here = getCallInstant(calls[index]);
    const next = getCallInstant(calls[index + 1]);
    if (here === undefined || next === undefined || feedNow > next) continue;
    if (feedNow < here) return undefined;
    return next > here ? (feedNow - here) / (next - here) : 0;
  }
  return undefined;
}

function readTrip(departure: KvvDeparture, feedNow: number): TripReading {
  const calls = departure.tripCalls ?? [];
  const delayByCall = new Map<string, number>();
  for (const call of calls) {
    if (call.delayMinutes !== undefined) {
      delayByCall.set(call.providerId ?? call.stopName, call.delayMinutes);
    }
  }
  return {
    rowDelayMinutes: departure.delayMinutes,
    delayByCall,
    linkPhase: getLinkPhase(calls, feedNow),
  };
}

/**
 * What names one run across readings — and, deliberately, one run *as seen from one board*.
 *
 * Two boards return the same trip with different windows of its calling sequence, so a reading
 * taken at Europaplatz and one taken at Hauptbahnhof disagree about which calls carry a deviation
 * without anything having changed. Compared as consecutive readings they manufacture a change on
 * every poll; keyed per board they are two independent series of one vehicle, which is what they
 * are.
 */
const getTripKey = (departure: KvvDeparture, stopPointId: string): string =>
  `${stopPointId}:${
    departure.tripInstanceId ??
    departure.tripId ??
    `${departure.lineId}@${departure.scheduledDepartureTime}`
  }`;

type ChangeEvent = {
  /** Whether the board row's own number moved, or only a deviation further along the route. */
  kind: "row" | "call";
  /** Where the vehicle was when the change was first seen, if the times placed it at all. */
  linkPhase?: number;
  /** How long since this trip's previous change, where there was one. */
  sinceLastChangeMs?: number;
  /** Milliseconds past the wall-clock minute, to show whether changes cluster on a boundary. */
  minutePhaseMs: number;
};

const changes: ChangeEvent[] = [];
const serverTimeReadings: { serverTime: number; requestedAt: number; receivedAt: number }[] = [];
const lastReadingByTrip = new Map<string, TripReading>();
const lastChangeAtByTrip = new Map<string, number>();
let pollCount = 0;
let pollsWithAnyChange = 0;
let tripReadingCount = 0;

/**
 * What moved between two readings of one trip, or nothing.
 *
 * The two kinds are worth telling apart. The row's own number is what a countdown is built on, and
 * what positioning now carries into the mark at its boarding call; a deviation moving only further
 * along the route is information no row states, and the only thing a faster *trip* read would buy.
 * A call that gains a deviation where it had none counts — the feed beginning to monitor a call is
 * as much news as it revising one.
 */
function findChange(previous: TripReading, current: TripReading): "row" | "call" | undefined {
  if (previous.rowDelayMinutes !== current.rowDelayMinutes) return "row";
  for (const [callKey, delayMinutes] of current.delayByCall) {
    if (previous.delayByCall.get(callKey) !== delayMinutes) return "call";
  }
  return undefined;
}

async function poll(client: KvvEfaClient, options: Options): Promise<void> {
  const requestedAt = Date.now();
  const boards = await Promise.all(
    options.stopPointIds.map((stopPointId) =>
      client.fetchDepartureBoard(stopPointId, { includeTripCalls: true }).catch(() => null),
    ),
  );
  const receivedAt = Date.now();
  pollCount += 1;
  let hasChange = false;

  for (const board of boards) {
    if (!board) continue;
    const serverTime = toInstant(board.serverTime);
    if (serverTime !== undefined) serverTimeReadings.push({ serverTime, requestedAt, receivedAt });
    const feedNow = serverTime ?? receivedAt;

    for (const departure of board.departures) {
      const key = getTripKey(departure, board.stopPointId);
      const current = readTrip(departure, feedNow);
      tripReadingCount += 1;
      const previous = lastReadingByTrip.get(key);
      lastReadingByTrip.set(key, current);
      const changeKind = previous && findChange(previous, current);
      if (!changeKind) continue;

      hasChange = true;
      const lastChangeAt = lastChangeAtByTrip.get(key);
      changes.push({
        kind: changeKind,
        linkPhase: current.linkPhase,
        sinceLastChangeMs: lastChangeAt === undefined ? undefined : receivedAt - lastChangeAt,
        minutePhaseMs: feedNow % 60_000,
      });
      lastChangeAtByTrip.set(key, receivedAt);

      if (options.outPath) {
        await appendFile(
          options.outPath,
          `${JSON.stringify({
            at: new Date(receivedAt).toISOString(),
            serverTime: board.serverTime,
            stopPointId: board.stopPointId,
            trip: key,
            change: changeKind,
            lineId: departure.lineId,
            destination: departure.destination,
            rowDelayMinutes: current.rowDelayMinutes,
            linkPhase: current.linkPhase,
            delayByCall: Object.fromEntries(current.delayByCall),
          })}\n`,
        );
      }
    }
  }
  if (hasChange) pollsWithAnyChange += 1;
}

const median = (values: readonly number[]): number | undefined => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
};

const seconds = (ms: number | undefined): string =>
  ms === undefined ? "—" : `${(ms / 1_000).toFixed(1)} s`;

/**
 * Whether `serverTime` is a production timestamp or an echo of the request.
 *
 * The discriminator is the *spread* of `serverTime - receivedAt`, and only that. If the feed
 * produced its answer on a cycle, polls landing at arbitrary points of that cycle would read
 * timestamps anywhere from fresh to a full period old, so the offset would range over the period.
 * An offset that is the same fraction of a second on every poll is a timestamp taken while the
 * request was being served, and there is no phase to align anything to.
 *
 * Two tempting readings are not evidence and are reported as raw counts rather than conclusions.
 * Repeated values mean nothing when several boards are fetched in one poll — they share the poll's
 * instant. And the seconds-past-the-minute the values land on mean nothing when the poll interval
 * divides sixty: that pattern is the probe's own cadence reflected back. Run with `--interval 7`
 * to read that line at all.
 */
function reportServerTime(intervalMs: number): void {
  if (serverTimeReadings.length < 2) {
    console.log("serverTime: too few readings to judge.");
    return;
  }
  const offsets = serverTimeReadings.map(({ serverTime, receivedAt }) => serverTime - receivedAt);
  const distinct = new Set(serverTimeReadings.map(({ serverTime }) => serverTime));
  const spread = Math.max(...offsets) - Math.min(...offsets);
  const secondsPast = [
    ...new Set(
      serverTimeReadings.map(({ serverTime }) => Math.floor((serverTime % 60_000) / 1_000)),
    ),
  ].sort((left, right) => left - right);

  console.log("\n— serverTime: is there a production cycle to align to? —");
  console.log(`readings                 ${serverTimeReadings.length}`);
  console.log(`distinct values          ${distinct.size} (shared within a poll; not evidence)`);
  console.log(`median offset to receipt ${seconds(median(offsets))}`);
  console.log(`offset spread            ${seconds(spread)}   ← the discriminator`);
  console.log(
    `seconds-past-minute      ${secondsPast.join(",")}` +
      (60_000 % intervalMs === 0 ? "  (probe interval divides 60 s; ignore this line)" : ""),
  );
  // A cycle worth aligning to would have to be at least a couple of seconds long to be worth the
  // complexity, and would show an offset spread of about its own period.
  console.log(
    spread < 2_000
      ? "→ ECHO. serverTime is stamped while the request is served, so it says nothing about when\n" +
          "  the data behind it was produced. There is no phase to align a poll to: item 1 is dead."
      : `→ CYCLE, period at least ${seconds(spread)}. Sampling just after production is worth\n` +
          "  taking further — measure the boundary the values land on and schedule against it.",
  );
}

function reportChanges(): void {
  console.log("\n— how often a deviation moves —");
  console.log(`polls                    ${pollCount}`);
  console.log(`trip readings            ${tripReadingCount}`);
  console.log(`trips seen               ${lastReadingByTrip.size}`);
  console.log(`changes observed         ${changes.length}`);
  console.log(
    `polls with any change    ${pollsWithAnyChange}/${pollCount}` +
      (pollCount > 0 ? ` (${Math.round((pollsWithAnyChange / pollCount) * 100)}%)` : ""),
  );
  const gaps = changes.flatMap(({ sinceLastChangeMs }) =>
    sinceLastChangeMs === undefined ? [] : [sinceLastChangeMs],
  );
  console.log(`median gap between       ${seconds(median(gaps))}`);
  const rowChanges = changes.filter(({ kind }) => kind === "row").length;
  console.log(
    `of which the row's own    ${rowChanges}/${changes.length}` +
      (changes.length > 0 ? ` (${Math.round((rowChanges / changes.length) * 100)}%)` : ""),
  );
  console.log("  — the rest moved only at a call further along, where no board row states it.");
  console.log(
    "→ compare that gap with the 30 s board cadence: a gap far longer than it means the cadence",
  );
  console.log("  is not the binding constraint and re-timing the polls cannot pay.");

  const placed = changes.flatMap(({ linkPhase }) => (linkPhase === undefined ? [] : [linkPhase]));
  if (placed.length > 0) {
    const buckets = [0, 0, 0, 0, 0];
    for (const phase of placed) buckets[Math.min(4, Math.floor(phase * 5))] += 1;
    console.log("\n— where the vehicle was when it changed —");
    console.log("  (0 = just left the stop behind, 1 = about to reach the next)");
    buckets.forEach((count, index) => {
      const share = Math.round((count / placed.length) * 100);
      console.log(
        `  ${(index / 5).toFixed(1)}–${((index + 1) / 5).toFixed(1)}  ${"█".repeat(Math.round(share / 2)).padEnd(50)} ${String(count).padStart(4)} (${share}%)`,
      );
    });
    console.log(
      "→ weight at the ends means changes arrive at stop events, and a refresh timed to a departure",
    );
    console.log("  is worth something. A flat spread means they arrive anywhere and it is not.");
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const client = new KvvEfaClient();
  const endsAt = Date.now() + options.durationMs;
  console.log(
    `Watching ${options.stopPointIds.join(", ")} every ${options.intervalMs / 1_000} s for ${Math.round(options.durationMs / 60_000)} min.`,
  );
  console.log("Ctrl-C stops early and still reports.\n");

  let stopped = false;
  process.on("SIGINT", () => {
    stopped = true;
  });

  while (!stopped && Date.now() < endsAt) {
    const startedAt = Date.now();
    await poll(client, options).catch((error) => console.error("poll failed:", error));
    process.stdout.write(
      `\rpoll ${pollCount}, ${changes.length} changes, ${lastReadingByTrip.size} trips  `,
    );
    const waitMs = Math.max(0, options.intervalMs - (Date.now() - startedAt));
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  console.log("\n");
  reportServerTime(options.intervalMs);
  reportChanges();
  if (options.outPath) console.log(`\nReadings written to ${options.outPath}`);
}

await main();
