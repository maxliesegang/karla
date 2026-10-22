/**
 * Regenerates `src/data/generated/kvv-stop-catalog.ts` from two sources, one fact each:
 * - EFA `XML_STOPLIST_REQUEST`: the municipality's stops with provider id, global id, name,
 *   position and locality (which GTFS lacks).
 * - KVV's CC0 GTFS feed: lines and calls per stop, for the whole municipality in one download.
 * Joined on the global id, not on the provider id's shape. Also writes
 * `src/data/generated/kvv-line-days.ts`: the rail and tram lines that do not run every day, and
 * `src/data/generated/kvv-bay-runs.ts`: which way each rail bay runs, and
 * `src/data/generated/kvv-bay-positions.ts`: where each one stands.
 *
 *     npm run refresh:stops
 *
 * Run by hand when the timetable period changes. Requires `unzip`; the archive is 227 MB unpacked
 * (`stop_times.txt` 207 MB), so it is streamed.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { type BayRun, getTravelAxis, measureBayRun } from "../src/lib/bay-runs.ts";

const STOP_LIST_ENDPOINT = "https://projekte.kvv-efa.de/sl3-alone/XML_STOPLIST_REQUEST";
const GTFS_ARCHIVE_URL = "https://projekte.kvv-efa.de/GTFS/google_transit.zip";
const OUTPUT_PATH = new URL("../src/data/generated/kvv-stop-catalog.ts", import.meta.url);
const LINE_DAYS_OUTPUT_PATH = new URL("../src/data/generated/kvv-line-days.ts", import.meta.url);
const BAY_RUNS_OUTPUT_PATH = new URL("../src/data/generated/kvv-bay-runs.ts", import.meta.url);
const BAY_POSITIONS_OUTPUT_PATH = new URL(
  "../src/data/generated/kvv-bay-positions.ts",
  import.meta.url,
);
/** GTFS `route_type`s of trams, metros and rail: the lines the maps draw. */
const RAIL_ROUTE_TYPES = new Set(["0", "1", "2"]);
/**
 * A line runs on a weekday when it runs on at least this share of that weekday's dates.
 */
const WEEKDAY_SHARE = 0.5;

/** The official municipality key (Gemeindekennziffer). */
const MUNICIPALITY_OMC = "8212000";
/** The municipality's global id prefix; GTFS prefixes stations with `P`. */
const GLOBAL_ID_PREFIX = "de:08212:";

/** One stop's catalog entry; mirrors `KvvCatalogStop`. */
type CatalogStop = {
  providerStopId: string;
  globalId: string;
  name: string;
  latitude: number;
  longitude: number;
  placeId: string;
  placeName: string;
  lineCount: number;
  callCount: number;
};

async function main(): Promise<void> {
  const stops = await fetchMunicipalityStops();
  console.log(`EFA: ${stops.length} stops in municipality ${MUNICIPALITY_OMC}`);

  const workingDirectory = await mkdtemp(join(tmpdir(), "karla-gtfs-"));
  try {
    const archivePath = join(workingDirectory, "google_transit.zip");
    const feedVersion = await downloadGtfsArchive(archivePath);
    console.log(`GTFS: feed version ${feedVersion}`);

    const { lineByJourneyRef, serviceIdsByRailLine, railJourneyRefs } =
      await readLinesByJourney(archivePath);
    console.log(`GTFS: ${lineByJourneyRef.size} trips`);

    const { runs: bayRuns, positions: bayPositions } = await readBayRuns(
      archivePath,
      railJourneyRefs,
      new Map(stops.map(({ globalId, providerStopId }) => [globalId, providerStopId])),
    );
    await writeFile(BAY_RUNS_OUTPUT_PATH, renderBayRunsModule(bayRuns, feedVersion));
    console.log(`GTFS: runs read for ${bayRuns.size} rail platforms`);
    await writeFile(BAY_POSITIONS_OUTPUT_PATH, renderBayPositionsModule(bayPositions, feedVersion));
    console.log(`GTFS: positions read for ${bayPositions.size} rail platforms`);

    const nonDailyLineIds = await readNonDailyLines(archivePath, serviceIdsByRailLine);
    await writeFile(LINE_DAYS_OUTPUT_PATH, renderLineDaysModule(nonDailyLineIds, feedVersion));
    console.log(`GTFS: lines not running every day: ${nonDailyLineIds.join(", ")}`);

    const serviceByGlobalId = await readServiceByStation(archivePath, lineByJourneyRef);
    console.log(`GTFS: service read for ${serviceByGlobalId.size} stations`);

    const catalog = stops
      .map((stop) => {
        const service = serviceByGlobalId.get(stop.globalId);
        return {
          ...stop,
          lineCount: service?.lines.size ?? 0,
          callCount: service?.calls ?? 0,
        };
      })
      // By stop number, so refreshes diff by changed stops.
      .sort((first, second) => catalogSortKey(first) - catalogSortKey(second));

    await writeFile(OUTPUT_PATH, renderModule(catalog, feedVersion), "utf8");
    const served = catalog.filter(({ lineCount }) => lineCount > 0).length;
    console.log(
      `Wrote ${catalog.length} stops (${served} with scheduled service) to ${OUTPUT_PATH.pathname}`,
    );
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
}

/** The operator's stop number from a global id. */
const catalogSortKey = ({ globalId }: { globalId: string }): number =>
  Number.parseInt(globalId.slice(GLOBAL_ID_PREFIX.length), 10) || 0;

/**
 * The municipality's stops with their locality. `XML_STOPLIST_REQUEST` only answers in `rapidJSON`;
 * `json` gives HTTP 200 with an empty body.
 */
async function fetchMunicipalityStops(): Promise<Omit<CatalogStop, "lineCount" | "callCount">[]> {
  const url = new URL(STOP_LIST_ENDPOINT);
  url.search = new URLSearchParams({
    outputFormat: "rapidJSON",
    coordOutputFormat: "WGS84[DD.ddddd]",
    stopListOMC: MUNICIPALITY_OMC,
  }).toString();

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Stop list: HTTP ${response.status}`);
  const payload = (await response.json()) as {
    locations?: {
      id?: string;
      name?: string;
      coord?: [number, number];
      properties?: { stopId?: string };
      parent?: { id?: string; name?: string };
    }[];
  };

  const stops = (payload.locations ?? []).flatMap((location) => {
    const providerStopId = location.properties?.stopId;
    const globalId = location.id;
    const [latitude, longitude] = location.coord ?? [];
    const placeId = location.parent?.id;
    const placeName = location.parent?.name;
    if (!providerStopId || !globalId?.startsWith(GLOBAL_ID_PREFIX)) return [];
    if (latitude === undefined || longitude === undefined || !placeId || !placeName) return [];
    return [
      {
        providerStopId,
        globalId,
        name: location.name ?? "",
        latitude,
        longitude,
        placeId,
        placeName,
      },
    ];
  });
  if (stops.length === 0) throw new Error("Stop list: no stops returned");
  return stops;
}

/** Downloads the archive; returns its `feed_version`. */
async function downloadGtfsArchive(archivePath: string): Promise<string> {
  const response = await fetch(GTFS_ARCHIVE_URL);
  if (!response.ok) throw new Error(`GTFS archive: HTTP ${response.status}`);
  await writeFile(archivePath, Buffer.from(await response.arrayBuffer()));

  const rows = await readArchiveMember(archivePath, "feed_info.txt", 8);
  const header = await rows.next();
  const values = await rows.next();
  await rows.return?.(undefined);
  const versionIndex = header.value?.indexOf("feed_version") ?? -1;
  const version = versionIndex >= 0 ? values.value?.[versionIndex] : undefined;
  if (!version) throw new Error("GTFS archive: no feed_version");
  return version;
}

/**
 * The passenger-facing line name for each journey, and the services each rail line's journeys run
 * on.
 */
async function readLinesByJourney(archivePath: string): Promise<{
  lineByJourneyRef: Map<string, string>;
  serviceIdsByRailLine: Map<string, Set<string>>;
  railJourneyRefs: Set<string>;
}> {
  const nameByRouteId = new Map<string, string>();
  const railRouteIds = new Set<string>();
  for await (const [routeId, , shortName, , routeType] of columnsOf(archivePath, "routes.txt", 5)) {
    if (!routeId || !shortName) continue;
    nameByRouteId.set(routeId, shortName);
    if (RAIL_ROUTE_TYPES.has(routeType ?? "")) railRouteIds.add(routeId);
  }

  const lineByJourneyRef = new Map<string, string>();
  const serviceIdsByRailLine = new Map<string, Set<string>>();
  const railJourneyRefs = new Set<string>();
  for await (const [routeId = "", serviceId, journeyRef] of columnsOf(
    archivePath,
    "trips.txt",
    3,
  )) {
    const name = nameByRouteId.get(routeId);
    if (!journeyRef || !name) continue;
    lineByJourneyRef.set(journeyRef, name);
    if (!railRouteIds.has(routeId) || !serviceId) continue;
    railJourneyRefs.add(journeyRef);
    const services = serviceIdsByRailLine.get(name) ?? new Set<string>();
    services.add(serviceId);
    serviceIdsByRailLine.set(name, services);
  }
  return { lineByJourneyRef, serviceIdsByRailLine, railJourneyRefs };
}

/** A rail bay of the municipality, and what its journeys state about it. */
type GtfsBay = {
  station: string;
  code: string;
  latitude: number;
  longitude: number;
  /** Each journey's neighbouring stations, as an unordered pair. */
  routePairs: Set<string>;
  travel: { x: number; y: number };
};

type BayPosition = { latitude: number; longitude: number };

/**
 * Which way each rail bay runs, by `providerStopId|bay`: along it and the bays of its station that
 * serve the same through route, else along its journeys. Every direction runs in the timetable, so
 * a pair is measured that a live reading may see only half of. Its position is the mean of the GTFS
 * stops sharing its code.
 */
async function readBayRuns(
  archivePath: string,
  railJourneyRefs: ReadonlySet<string>,
  providerStopIdByGlobalId: ReadonlyMap<string, string>,
): Promise<{ runs: Map<string, BayRun>; positions: Map<string, BayPosition> }> {
  const positionByStopId = new Map<string, { latitude: number; longitude: number }>();
  const stationByStopId = new Map<string, string>();
  const bayByStopId = new Map<string, GtfsBay>();
  for await (const [stopId, , latitude, longitude, , , , parent, , code] of columnsOf(
    archivePath,
    "stops.txt",
    10,
  )) {
    if (!stopId || !latitude || !longitude) continue;
    const position = { latitude: Number(latitude), longitude: Number(longitude) };
    positionByStopId.set(stopId, position);
    stationByStopId.set(stopId, parent || stopId);
    if (!code || !parent?.startsWith(`P${GLOBAL_ID_PREFIX}`)) continue;
    bayByStopId.set(stopId, {
      station: parent.slice(1),
      code,
      ...position,
      routePairs: new Set(),
      travel: { x: 0, y: 0 },
    });
  }

  const readJourney = (calls: { sequence: number; stopId: string }[]) => {
    calls.sort((left, right) => left.sequence - right.sequence);
    for (let index = 1; index < calls.length - 1; index += 1) {
      const bay = bayByStopId.get(calls[index].stopId);
      const previous = calls[index - 1].stopId;
      const next = calls[index + 1].stopId;
      if (!bay) continue;
      const stations = [previous, next].map((stopId) => stationByStopId.get(stopId) ?? stopId);
      bay.routePairs.add(stations.sort().join("|"));
      const [from, to] = [positionByStopId.get(previous), positionByStopId.get(next)];
      if (!from || !to) continue;
      const axis = getTravelAxis(from, to);
      bay.travel.x += axis.x;
      bay.travel.y += axis.y;
    }
  };
  // Rows come grouped by journey.
  let journeyRef: string | undefined;
  let calls: { sequence: number; stopId: string }[] = [];
  for await (const [rowJourneyRef, , , stopId, sequence] of columnsOf(
    archivePath,
    "stop_times.txt",
    5,
  )) {
    if (rowJourneyRef !== journeyRef) {
      readJourney(calls);
      journeyRef = rowJourneyRef;
      calls = [];
    }
    if (rowJourneyRef && stopId && railJourneyRefs.has(rowJourneyRef)) {
      calls.push({ sequence: Number(sequence), stopId });
    }
  }
  readJourney(calls);

  const bays = [...bayByStopId.values()].filter(({ routePairs }) => routePairs.size > 0);
  const runs = new Map<string, BayRun>();
  const sharingByKey = new Map<string, GtfsBay[]>();
  for (const bay of bays) {
    const providerStopId = providerStopIdByGlobalId.get(bay.station);
    if (!providerStopId) continue;
    const key = `${providerStopId}|${bay.code}`;
    sharingByKey.set(key, [...(sharingByKey.get(key) ?? []), bay]);
    const partners = bays.filter(
      (other) =>
        other.station === bay.station &&
        [...other.routePairs].some((pair) => bay.routePairs.has(pair)),
    );
    const travel = partners.reduce(
      (sum, { travel: axis }) => ({ x: sum.x + axis.x, y: sum.y + axis.y }),
      { x: 0, y: 0 },
    );
    const run = measureBayRun(partners, travel);
    if (run) runs.set(key, run);
  }
  const mean = (values: readonly number[]) =>
    values.reduce((sum, value) => sum + value, 0) / values.length;
  const positions = new Map(
    [...sharingByKey].map(([key, sharing]) => [
      key,
      {
        latitude: mean(sharing.map(({ latitude }) => latitude)),
        longitude: mean(sharing.map(({ longitude }) => longitude)),
      },
    ]),
  );
  return { runs, positions };
}

function renderBayPositionsModule(
  positions: ReadonlyMap<string, BayPosition>,
  feedVersion: string,
): string {
  const rows = [...positions]
    .sort(([left], [right]) => left.localeCompare(right, "en", { numeric: true }))
    .map(
      ([key, { latitude, longitude }]) =>
        `  [${JSON.stringify(key)}, ${latitude.toFixed(6)}, ${longitude.toFixed(6)}],`,
    )
    .join("\n");
  return `// Generated by scripts/refresh-stop-catalog.ts — do not edit by hand.
//
// KVV GTFS feed version ${feedVersion} (CC0), https://projekte.kvv-efa.de/GTFS/google_transit.zip
//
// Refresh with: npm run refresh:stops

type BayPositionRow = [key: string, latitude: number, longitude: number];

const rows: readonly BayPositionRow[] = [
${rows}
];

/** Where each rail bay stands, by \`providerStopPointId|bay\`. */
export const kvvBayPositionByKey: ReadonlyMap<
  string,
  { latitude: number; longitude: number }
> = new Map(rows.map(([key, latitude, longitude]) => [key, { latitude, longitude }]));
`;
}

function renderBayRunsModule(runs: ReadonlyMap<string, BayRun>, feedVersion: string): string {
  const rows = [...runs]
    .sort(([left], [right]) => left.localeCompare(right, "en", { numeric: true }))
    .map(([key, run]) => `  [${JSON.stringify(key)}, ${JSON.stringify(run)}],`)
    .join("\n");
  return `// Generated by scripts/refresh-stop-catalog.ts — do not edit by hand.
//
// KVV GTFS feed version ${feedVersion} (CC0), https://projekte.kvv-efa.de/GTFS/google_transit.zip
//
// Refresh with: npm run refresh:stops

import type { BayRun } from "../../lib/bay-runs";

/** Which way each rail bay runs, by \`providerStopPointId|bay\`. */
export const kvvBayRunByKey: ReadonlyMap<string, BayRun> = new Map<string, BayRun>([
${rows}
]);
`;
}

const DAY_MS = 86_400_000;
const parseGtfsDate = (value: string): number =>
  Date.UTC(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8)));

/**
 * The rail lines that miss a weekday: on fewer than `WEEKDAY_SHARE` of that weekday's dates in the
 * feed period, none of their journeys run.
 */
async function readNonDailyLines(
  archivePath: string,
  serviceIdsByLine: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<string[]> {
  const datesByServiceId = new Map<string, Set<number>>();
  let [periodStart, periodEnd] = [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for await (const [serviceId, ...fields] of columnsOf(archivePath, "calendar.txt", 10)) {
    const [start, end] = [fields[7], fields[8]];
    if (!serviceId || !start || !end) continue;
    const dates = new Set<number>();
    for (let day = parseGtfsDate(start); day <= parseGtfsDate(end); day += DAY_MS) {
      // `monday` comes first; `getUTCDay` counts from Sunday.
      if (fields[(new Date(day).getUTCDay() + 6) % 7] === "1") dates.add(day);
    }
    datesByServiceId.set(serviceId, dates);
    periodStart = Math.min(periodStart, parseGtfsDate(start));
    periodEnd = Math.max(periodEnd, parseGtfsDate(end));
  }
  for await (const [serviceId, date, type] of columnsOf(archivePath, "calendar_dates.txt", 3)) {
    if (!serviceId || !date) continue;
    const dates = datesByServiceId.get(serviceId) ?? new Set<number>();
    datesByServiceId.set(serviceId, dates);
    if (type === "1") dates.add(parseGtfsDate(date));
    else dates.delete(parseGtfsDate(date));
  }

  const weekdayDates = Array.from({ length: 7 }, () => [] as number[]);
  for (let day = periodStart; day <= periodEnd; day += DAY_MS) {
    weekdayDates[new Date(day).getUTCDay()].push(day);
  }
  const nonDaily: string[] = [];
  for (const [line, serviceIds] of serviceIdsByLine) {
    const runs = new Set<number>();
    for (const serviceId of serviceIds) {
      for (const day of datesByServiceId.get(serviceId) ?? []) runs.add(day);
    }
    const missesAWeekday = weekdayDates.some(
      (dates) => dates.filter((day) => runs.has(day)).length < dates.length * WEEKDAY_SHARE,
    );
    if (missesAWeekday) nonDaily.push(line);
  }
  return nonDaily.sort((left, right) => left.localeCompare(right, "de", { numeric: true }));
}

/**
 * Distinct lines and calls per parent station. Calls count over the feed period (a ranking, not a
 * frequency).
 */
async function readServiceByStation(
  archivePath: string,
  lineByJourneyRef: ReadonlyMap<string, string>,
): Promise<Map<string, { lines: Set<string>; calls: number }>> {
  const stationByBayId = new Map<string, string>();
  for await (const [stopId, , , , , , , parentStation] of columnsOf(archivePath, "stops.txt", 8)) {
    // GTFS's station `Pde:08212:1011` is EFA's `de:08212:1011`.
    if (stopId?.startsWith(GLOBAL_ID_PREFIX) && parentStation?.startsWith(`P${GLOBAL_ID_PREFIX}`)) {
      stationByBayId.set(stopId, parentStation.slice(1));
    }
  }

  const serviceByGlobalId = new Map<string, { lines: Set<string>; calls: number }>();
  for await (const [journeyRef, , , stopId] of columnsOf(archivePath, "stop_times.txt", 4)) {
    const globalId = stationByBayId.get(stopId ?? "");
    const line = lineByJourneyRef.get(journeyRef ?? "");
    if (!globalId || !line) continue;
    const service = serviceByGlobalId.get(globalId) ?? { lines: new Set<string>(), calls: 0 };
    service.lines.add(line);
    service.calls += 1;
    serviceByGlobalId.set(globalId, service);
  }
  return serviceByGlobalId;
}

/** One archive member's rows, header skipped, cut to the needed columns. */
async function* columnsOf(
  archivePath: string,
  member: string,
  fieldCount: number,
): AsyncGenerator<(string | undefined)[]> {
  const rows = readArchiveMember(archivePath, member, fieldCount);
  await rows.next();
  yield* rows;
}

/**
 * One archive member streamed via `unzip -p` as quoted CSV; only the leading `fieldCount` fields
 * parsed.
 */
async function* readArchiveMember(
  archivePath: string,
  member: string,
  fieldCount: number,
): AsyncGenerator<(string | undefined)[]> {
  const unzip = spawn("unzip", ["-p", archivePath, member], { stdio: ["ignore", "pipe", "pipe"] });
  const failure = new Promise<never>((_, reject) => {
    unzip.on("error", (error: Error) => reject(new Error(`unzip ${member}: ${error.message}`)));
    unzip.on(
      "close",
      (code: number | null) => code && reject(new Error(`unzip ${member}: exited ${code}`)),
    );
  });
  failure.catch(() => {});

  try {
    for await (const line of createInterface({ input: unzip.stdout, crlfDelay: Infinity })) {
      // Every member starts with a BOM.
      if (line) yield readFields(line.charCodeAt(0) === 0xfeff ? line.slice(1) : line, fieldCount);
    }
    await Promise.race([failure, Promise.resolve()]);
  } finally {
    unzip.kill();
  }
}

/** The leading fields of a CSV row; quotes escape by doubling. */
function readFields(line: string, fieldCount: number): (string | undefined)[] {
  const fields: (string | undefined)[] = [];
  let index = 0;
  while (fields.length < fieldCount && index <= line.length) {
    if (line[index] === '"') {
      let value = "";
      index += 1;
      while (index < line.length) {
        if (line[index] !== '"') {
          value += line[index];
          index += 1;
        } else if (line[index + 1] === '"') {
          value += '"';
          index += 2;
        } else {
          break;
        }
      }
      fields.push(value);
      index += 2;
    } else {
      const end = line.indexOf(",", index);
      const value = line.slice(index, end === -1 ? undefined : end);
      fields.push(value || undefined);
      if (end === -1) break;
      index = end + 1;
    }
  }
  return fields;
}

function renderLineDaysModule(nonDailyLineIds: readonly string[], feedVersion: string): string {
  return `// Generated by scripts/refresh-stop-catalog.ts — do not edit by hand.
//
// KVV GTFS feed version ${feedVersion} (CC0), https://projekte.kvv-efa.de/GTFS/google_transit.zip
//
// Refresh with: npm run refresh:stops

/**
 * Rail and tram lines that miss a weekday in the timetable period: weekday-only, weekend-only,
 * night and leisure lines. A line not named here runs every day.
 */
export const kvvNonDailyLineIds: ReadonlySet<string> = new Set(${JSON.stringify(nonDailyLineIds).replaceAll(",", ", ")});
`;
}

/** The generated module, one row per stop for clean diffs. */
function renderModule(catalog: readonly CatalogStop[], feedVersion: string): string {
  const rows = catalog
    .map(
      ({
        providerStopId,
        globalId,
        name,
        latitude,
        longitude,
        placeId,
        placeName,
        lineCount,
        callCount,
      }) =>
        `  [${JSON.stringify(providerStopId)}, ${JSON.stringify(globalId)}, ${JSON.stringify(name)}, ` +
        `${latitude}, ${longitude}, ${JSON.stringify(placeId)}, ${JSON.stringify(placeName)}, ` +
        `${lineCount}, ${callCount}],`,
    )
    .join("\n");

  return `// Generated by scripts/refresh-stop-catalog.ts — do not edit by hand.
//
// Stops: EFA XML_STOPLIST_REQUEST, municipality ${MUNICIPALITY_OMC}.
// Service: KVV GTFS feed version ${feedVersion} (CC0), https://projekte.kvv-efa.de/GTFS/google_transit.zip
//
// Refresh with: npm run refresh:stops

/** What the timetable states about one stop of the municipality. */
export type KvvCatalogStop = {
  /** The EFA stop id boards are requested with, as \`kvv-stop-mappings.ts\` states it. */
  providerStopId: string;
  /** The stop's national id, which is how the two sources above are joined. */
  globalId: string;
  /** The operator's name for the stop, without its municipality. */
  name: string;
  latitude: number;
  longitude: number;
  /** The locality within the municipality: Karlsruhe itself, or a district such as Durlach. */
  placeId: string;
  placeName: string;
  /** Distinct lines calling here in the timetable period. Zero where the period schedules none. */
  lineCount: number;
  /** Calls here in the timetable period. Ranks stops against each other; it is not a frequency. */
  callCount: number;
};

type CatalogRow = [
  providerStopId: string,
  globalId: string,
  name: string,
  latitude: number,
  longitude: number,
  placeId: string,
  placeName: string,
  lineCount: number,
  callCount: number,
];

const rows: readonly CatalogRow[] = [
${rows}
];

export const kvvStopCatalog: readonly KvvCatalogStop[] = rows.map(
  ([providerStopId, globalId, name, latitude, longitude, placeId, placeName, lineCount, callCount]) => ({
    providerStopId,
    globalId,
    name,
    latitude,
    longitude,
    placeId,
    placeName,
    lineCount,
    callCount,
  }),
);

const catalogByProviderStopId = new Map(kvvStopCatalog.map((stop) => [stop.providerStopId, stop]));

/** The catalog entry for an EFA stop id, or undefined for a stop outside the municipality. */
export const findCatalogStop = (providerStopId: string): KvvCatalogStop | undefined =>
  catalogByProviderStopId.get(providerStopId);
`;
}

await main();
