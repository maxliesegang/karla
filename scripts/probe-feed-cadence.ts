/**
 * Measures how often the KVV feed produces new information, to choose refresh cadences from
 * evidence:
 * 1. Is `parameters.serverTime` a production cycle or the request instant? Only a cycle has a
 *    phase worth aligning polls to.
 * 2. How often does a trip's deviation change, and where along its link was the vehicle when it
 *    did?
 *
 *     npm run probe:cadence -- [options]
 *
 *       --stops 7000037,7000090   provider stop ids to watch (default: Europaplatz, Hauptbahnhof)
 *       --interval 10             seconds between polls (default 10)
 *       --minutes 30              how long to run (default 30)
 *       --out probe.jsonl         also write every reading, for analysis afterwards
 *
 * Polls faster than the app on purpose. Run by hand for one measurement, then stop.
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
  /** The row's deviation at its own stop, which countdowns use. */
  rowDelayMinutes?: number;
  /** Every call's deviation, keyed as the app keys calls. */
  delayByCall: Map<string, number>;
  /** Position along the current link (0 behind, 1 ahead), from call times alone. */
  linkPhase?: number;
};

const toInstant = (value: string | undefined): number | undefined => {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** A call's schedule shifted by its deviation. */
function getCallInstant(call: KvvTripCall): number | undefined {
  const scheduled = toInstant(call.scheduledDepartureTime ?? call.scheduledArrivalTime);
  return scheduled === undefined ? undefined : scheduled + (call.delayMinutes ?? 0) * 60_000;
}

/** Where along its link the vehicle was, from the published times (not the app's smoothing). */
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
 * One run as seen from one board: boards return different windows of the sequence, so comparing
 * across boards would invent changes.
 */
const getTripKey = (departure: KvvDeparture, stopPointId: string): string =>
  `${stopPointId}:${
    departure.tripInstanceId ??
    departure.tripId ??
    `${departure.lineId}@${departure.scheduledDepartureTime}`
  }`;

type ChangeEvent = {
  /** Whether the row's own number moved, or only a deviation further along. */
  kind: "row" | "call";
  /** Where the vehicle was when the change was first seen. */
  linkPhase?: number;
  /** How long since this trip's previous change, where there was one. */
  sinceLastChangeMs?: number;
  /** Milliseconds past the minute, to show clustering on a boundary. */
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
 * What moved between two readings of a trip: the row's own deviation, or only a call further along
 * (which only a trip read reveals). A call gaining a deviation counts.
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
 * Whether `serverTime` is a production timestamp: a cycle shows as a spread of `serverTime -
 * receivedAt` across its period; a constant offset means an echo. Repeated values and
 * seconds-past-the-minute are not evidence (several boards share a poll; intervals dividing 60
 * reflect the probe's cadence), so they are reported raw. Use `--interval 7` to read them.
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
  // A cycle worth aligning to would last seconds and show an offset spread of about its period.
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
