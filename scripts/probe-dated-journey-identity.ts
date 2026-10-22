/**
 * Measures which board-row identifiers name a dated journey (one dated instance) rather than a
 * journey (reused daily):
 * 1. Is `servingLine.key` (the locator's `tripCode`) stable across stops? Ground truth is
 *    `datedJourneyId`, so boards are asked for their journeys.
 * 2. Does it repeat on the next operating day?
 * 3. Which rows carry a sequence? Unfiltered boards return all; line-filtered ones do not, and
 *    there
 *    `datedJourneyId` degrades to the bare `journeyRef`.
 *
 *     npm run probe:dated-journey-identity -- [options]
 *
 *       --stops 7000037,7000061   provider stop ids to read (default: the Zentrum's posts)
 *       --days 3                  how many operating days to compare (default 3)
 *       --time 1400               clock time to compare those days at (default 1400)
 *
 * Measured 6 September 2026 (XSLT_DM_REQUEST): `tripCode` held across all 57 dated journeys seen at
 * several stop points and was 1:1 with dated journeys within a reading (110/110), but half the
 * codes recurred the next day at the same line and minute. It is a journey identity, like
 * `journeyRef`.
 */

import { KvvEfaClient } from "../src/data/kvv-efa-client.ts";
import { parseStopEventBoardResponse } from "../src/data/kvv-efa-parsers.ts";

const STOP_EVENT_ENDPOINT = "https://projekte.kvv-efa.de/sl3-alone/XSLT_DM_REQUEST";
/** The Zentrum's observation posts. */
const DEFAULT_STOP_POINT_IDS = ["7000037", "7000061", "7000090", "7001201", "7001003", "7001012"];
const BOARD_ROWS = 40;

type Options = { stopPointIds: string[]; days: number; time: string };

function parseOptions(argv: readonly string[]): Options {
  const read = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const stops = read("stops");
  return {
    stopPointIds: stops ? stops.split(",").filter(Boolean) : DEFAULT_STOP_POINT_IDS,
    days: Number.parseInt(read("days") ?? "3", 10) || 3,
    time: read("time") ?? "1400",
  };
}

type Row = {
  stopPointId: string;
  datedJourneyId?: string;
  code?: string;
  lineId: string;
  destination: string;
  departsAt: string;
};

/** `line|tripCode`, the pair a locator names a dated journey by. */
const getLocatorKey = (row: Row): string | undefined => row.code;

/**
 * A board for a given date, which `KvvEfaClient` (always *now*) cannot request; parsed by the app's
 * parser.
 */
async function fetchBoardOn(stopPointId: string, date: string, time: string) {
  const url = new URL(STOP_EVENT_ENDPOINT);
  url.search = new URLSearchParams({
    outputFormat: "json",
    type_dm: "stopID",
    name_dm: stopPointId,
    mode: "direct",
    useRealtime: "1",
    useProxFootSearch: "0",
    itdDateTimeDepArr: "dep",
    itdDate: date,
    itdTime: time,
    limit: String(BOARD_ROWS),
    depSequence: String(BOARD_ROWS),
    depType: "stopEvents",
    includeCompleteStopSeq: "1",
  }).toString();
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Abfahrtstafel ${stopPointId} ${date}: HTTP ${response.status}`);
  return parseStopEventBoardResponse(await response.json(), stopPointId);
}

const addDays = (days: number): string => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
};

/** Adds `value` to the set `key` names, creating it on first sight. */
function collect<T>(index: Map<string, Set<T>>, key: string, value: T): void {
  const existing = index.get(key);
  if (existing) existing.add(value);
  else index.set(key, new Set([value]));
}

/** Whether one identity ever names two of something (questions 1 and 2). */
function reportCollisions<T>(index: Map<string, Set<T>>, label: string): number {
  const collided = [...index].filter(([, values]) => values.size > 1);
  console.log(`  ${label}: ${index.size} distinct, ${collided.length} naming more than one`);
  for (const [key, values] of collided.slice(0, 8)) {
    console.log(`     ${key} -> ${[...values].join(" , ")}`);
  }
  return collided.length;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const client = new KvvEfaClient();

  console.log("1. Is the locator's tripCode stable across stops, and 1:1 with the run?\n");
  const rows: Row[] = [];
  for (const stopPointId of options.stopPointIds) {
    const board = await client.fetchStopEventBoard(stopPointId, {
      limit: BOARD_ROWS,
      includeCalls: true,
    });
    for (const stopEvent of board.stopEvents) {
      rows.push({
        stopPointId: stopEvent.stopPointId,
        datedJourneyId: stopEvent.datedJourneyId,
        code:
          stopEvent.journeyLocator &&
          `${stopEvent.journeyLocator.lineRef}|${stopEvent.journeyLocator.journeyCode}`,
        lineId: stopEvent.lineId,
        destination: stopEvent.destinationText,
        departsAt: stopEvent.timetabledDepartureTime,
      });
    }
    console.log(`  ${stopPointId}: ${board.stopEvents.length} rows`);
  }

  const identified = rows.filter((row) => row.datedJourneyId && getLocatorKey(row));
  console.log(`\n  ${rows.length} rows, ${identified.length} carrying both a run id and a locator`);

  const codesByDatedJourney = new Map<string, Set<string>>();
  const stopsByDatedJourney = new Map<string, Set<string>>();
  const datedJourneysByCode = new Map<string, Set<string>>();
  for (const row of identified) {
    collect(codesByDatedJourney, row.datedJourneyId!, getLocatorKey(row)!);
    collect(stopsByDatedJourney, row.datedJourneyId!, row.stopPointId);
    collect(datedJourneysByCode, getLocatorKey(row)!, row.datedJourneyId!);
  }
  const seenAtSeveralStops = [...stopsByDatedJourney]
    .filter(([, stops]) => stops.size > 1)
    .map(([id]) => id);
  const unstable = seenAtSeveralStops.filter((id) => (codesByDatedJourney.get(id)?.size ?? 0) > 1);
  console.log(`  runs seen at more than one stop point: ${seenAtSeveralStops.length}`);
  console.log(`  of those, the tripCode differed between stops: ${unstable.length}`);
  for (const datedJourneyId of unstable.slice(0, 8)) {
    const seen = identified.filter((row) => row.datedJourneyId === datedJourneyId);
    console.log(
      `     ${datedJourneyId}: ${seen.map((row) => `${row.stopPointId}=${row.code}`).join(" ")}`,
    );
  }
  reportCollisions(datedJourneysByCode, "line|tripCode within one reading");

  console.log(`\n2. Does the same code come round on the next operating day?\n`);
  const stopPointId = options.stopPointIds[0];
  const dayByCode = new Map<string, Set<string>>();
  const sightings = new Map<string, Row[]>();
  for (let offset = 0; offset < options.days; offset += 1) {
    const date = addDays(offset);
    const board = await fetchBoardOn(stopPointId, date, options.time);
    console.log(`  ${stopPointId} ${date} ${options.time}: ${board.stopEvents.length} rows`);
    for (const stopEvent of board.stopEvents) {
      if (!stopEvent.journeyLocator) continue;
      const code = `${stopEvent.journeyLocator.lineRef}|${stopEvent.journeyLocator.journeyCode}`;
      collect(dayByCode, code, date);
      const row: Row = {
        stopPointId,
        datedJourneyId: stopEvent.datedJourneyId,
        code,
        lineId: stopEvent.lineId,
        destination: stopEvent.destinationText,
        departsAt: stopEvent.timetabledDepartureTime,
      };
      sightings.set(code, [...(sightings.get(code) ?? []), row]);
    }
  }
  const reused = [...dayByCode].filter(([, days]) => days.size > 1);
  console.log(
    `\n  ${dayByCode.size} distinct codes, ${reused.length} appearing on more than one day`,
  );
  for (const [code, days] of reused.slice(0, 10)) {
    console.log(`     ${code} on ${[...days].join(", ")}`);
    for (const row of (sightings.get(code) ?? []).slice(0, 3)) {
      console.log(`        ${row.departsAt} line ${row.lineId} -> ${row.destination}`);
    }
  }
  console.log(
    reused.length > 0
      ? "\n  => tripCode is a TRIP identity: it needs a lifetime bound to name a run."
      : "\n  => tripCode did not repeat across these days.",
  );

  console.log(`\n3. Which boards carry a calling sequence, and where the run id degrades?\n`);
  const plain = await client.fetchStopEventBoard(stopPointId, { limit: BOARD_ROWS });
  const lineRefs = [
    ...new Set(plain.stopEvents.map((stopEvent) => stopEvent.lineRef).filter(Boolean)),
  ].slice(0, 2) as string[];
  const variants = [
    ["unfiltered", await Promise.resolve(plain)],
    [
      "line-filtered",
      await client.fetchStopEventBoard(stopPointId, { limit: BOARD_ROWS, lineIds: lineRefs }),
    ],
  ] as const;
  for (const [name, board] of variants) {
    const withCalls = board.stopEvents.filter((stopEvent) => stopEvent.calls?.length).length;
    const dated = board.stopEvents.filter((stopEvent) =>
      stopEvent.datedJourneyId?.includes("@"),
    ).length;
    console.log(
      `  ${name}: ${board.stopEvents.length} rows, ${withCalls} with a sequence, ${dated} with a dated run id`,
    );
  }
  console.log(
    "\n  A row with no sequence has no dated run id: `getTripInstanceId` returns the bare tripId.",
  );
}

await main();
