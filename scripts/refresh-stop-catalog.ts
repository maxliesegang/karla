/**
 * Regenerates the build network's catalog under `src/networks/<id>/generated/` from two sources, one
 * fact each:
 * - TRIAS `LocationInformationRequest` by rectangle: the home municipality's stops with DHID, name,
 *   position and locality.
 * - The network's GTFS feed (`catalogSource.gtfs`): lines and calls per stop, kept to the
 *   network's pools by route id (`kvv-21-002E-1`).
 * Joined on the stop's DHID. Also writes `line-days.ts`: the rail and tram lines that do not run
 * every day; `bay-runs.ts`: which way each rail bay runs; `bay-positions.ts`: where each one
 * stands; and `stop-places.ts` (`write-stop-places.ts`).
 *
 *     npm run refresh:stops
 *
 * Run by hand when the timetable period changes. Requires `unzip` and the requestor ref
 * (`trias-direct.ts`). The statewide archive is 777 MB unpacked (`stop_times.txt` 706 MB), so it
 * is streamed.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bounds } from "../src/data/network-scope.ts";
import { parseTriasLocations, readBay } from "../src/data/trias-parsers.ts";
import { type BayRun, getTravelAxis, measureBayRun } from "../src/lib/bay-runs.ts";
import type { CatalogStop } from "../src/networks/network-definition.ts";
import { network } from "../src/networks/network.ts";
import { downloadGtfsArchive, readTable } from "./gtfs-archive.ts";
import { envelope, readRequestorRef, TRIAS_ENDPOINT } from "./trias-direct.ts";
import { writeStopPlaces } from "./write-stop-places.ts";

const { stopIdPrefix, bounds, gtfs } = network.catalogSource;
const outputPath = (name: string) =>
  new URL(`../src/networks/${network.id}/generated/${name}`, import.meta.url);

/** GTFS `route_type`s of trams, metros and rail: the lines the maps draw. */
const RAIL_ROUTE_TYPES = new Set(["0", "1", "2"]);
/** A line runs on a weekday when it runs on at least this share of that weekday's dates. */
const WEEKDAY_SHARE = 0.5;
const DAY_MS = 86_400_000;
/** The sweep's tile edge in degrees, and the most stops one tile may answer before it is split. */
const SWEEP_TILE_DEGREES = 0.02;
const SWEEP_RESULT_LIMIT = 500;

type Position = { latitude: number; longitude: number };
type LocatedStop = Omit<CatalogStop, "lineCount" | "callCount">;

async function main(): Promise<void> {
  const stops = await sweepStops();
  console.log(`TRIAS: ${stops.length} stops under ${stopIdPrefix}`);

  const workingDirectory = await mkdtemp(join(tmpdir(), "karla-gtfs-"));
  try {
    const archivePath = join(workingDirectory, "gtfs.zip");
    const feedVersion = await downloadGtfsArchive(gtfs.url, archivePath);
    const source = `${gtfs.publisher}, ${gtfs.licence}, feed version ${feedVersion}, ${gtfs.url}`;
    console.log(`GTFS: feed version ${feedVersion}`);

    const { lineByJourneyRef, serviceIdsByRailLine, railJourneyRefs } =
      await readLinesByJourney(archivePath);
    console.log(`GTFS: ${lineByJourneyRef.size} journeys of ${[...network.scope.pools]}`);

    const globalIds = new Set(stops.map(({ globalId }) => globalId));
    const { runs, positions } = await readBayRuns(archivePath, railJourneyRefs, globalIds);
    await writeFile(outputPath("bay-runs.ts"), renderBayRunsModule(runs, source));
    console.log(`GTFS: runs read for ${runs.size} rail bays`);
    await writeFile(outputPath("bay-positions.ts"), renderBayPositionsModule(positions, source));
    console.log(`GTFS: positions read for ${positions.size} rail bays`);

    const nonDailyLineIds = await readNonDailyLines(archivePath, serviceIdsByRailLine);
    await writeFile(outputPath("line-days.ts"), renderLineDaysModule(nonDailyLineIds, source));
    console.log(`GTFS: lines not running every day: ${nonDailyLineIds.join(", ")}`);

    const serviceByGlobalId = await readServiceByStop(archivePath, lineByJourneyRef, globalIds);
    const catalog = stops
      .map((stop) => {
        const service = serviceByGlobalId.get(stop.globalId);
        return { ...stop, lineCount: service?.lines.size ?? 0, callCount: service?.calls ?? 0 };
      })
      // By stop number, so refreshes diff by changed stops.
      .sort((first, second) => compareIds(first.globalId, second.globalId));

    await writeFile(outputPath("stop-catalog.ts"), renderCatalogModule(catalog, source), "utf8");
    const served = catalog.filter(({ lineCount }) => lineCount > 0).length;
    console.log(`Wrote ${catalog.length} stops (${served} with scheduled service)`);
    await writeStopPlaces(catalog);
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
}

const compareIds = (left: string, right: string): number =>
  left.localeCompare(right, "en", { numeric: true });

/** A stop's DHID from any of its stop points' (`de:08212:1003:1:1`). */
const toStopId = (stopPointId: string): string => stopPointId.split(":").slice(0, 3).join(":");

// --- Stops: TRIAS by rectangle ---

/**
 * The municipality's stops, swept tile by tile. A tile answering the most a request may is split,
 * as it may have cut stops off; an area with no stop answers error `-20100`.
 */
async function sweepStops(): Promise<LocatedStop[]> {
  const requestorRef = readRequestorRef();
  const byId = new Map<string, LocatedStop>();
  const tiles: Bounds[] = [];
  for (let south = bounds.south; south < bounds.north; south += SWEEP_TILE_DEGREES) {
    for (let west = bounds.west; west < bounds.east; west += SWEEP_TILE_DEGREES) {
      tiles.push({
        south,
        north: Math.min(south + SWEEP_TILE_DEGREES, bounds.north),
        west,
        east: Math.min(west + SWEEP_TILE_DEGREES, bounds.east),
      });
    }
  }
  for (let tile = tiles.pop(); tile; tile = tiles.pop()) {
    const found = await locateStops(requestorRef, tile);
    if (found.length >= SWEEP_RESULT_LIMIT) {
      const latitude = (tile.south + tile.north) / 2;
      const longitude = (tile.west + tile.east) / 2;
      tiles.push(
        { ...tile, north: latitude, east: longitude },
        { ...tile, north: latitude, west: longitude },
        { ...tile, south: latitude, east: longitude },
        { ...tile, south: latitude, west: longitude },
      );
      continue;
    }
    for (const { providerId, name, placeName, latitude, longitude } of found) {
      if (!providerId.startsWith(stopIdPrefix) || !placeName) continue;
      if (latitude === undefined || longitude === undefined) continue;
      byId.set(providerId, { globalId: providerId, name, latitude, longitude, placeName });
    }
  }
  if (byId.size === 0) throw new Error("TRIAS: no stops found");
  return [...byId.values()];
}

async function locateStops(requestorRef: string, tile: Bounds) {
  const payload = `<LocationInformationRequest>
    <InitialInput><GeoRestriction><Rectangle>
      <UpperLeft><Longitude>${tile.west}</Longitude><Latitude>${tile.north}</Latitude></UpperLeft>
      <LowerRight><Longitude>${tile.east}</Longitude><Latitude>${tile.south}</Latitude></LowerRight>
    </Rectangle></GeoRestriction></InitialInput>
    <Restrictions><Type>stop</Type><NumberOfResults>${SWEEP_RESULT_LIMIT}</NumberOfResults></Restrictions>
  </LocationInformationRequest>`;
  const response = await fetch(TRIAS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "text/xml" },
    body: envelope(requestorRef, payload),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`TRIAS: HTTP ${response.status}`);
  try {
    return parseTriasLocations(await response.text());
  } catch (error) {
    if (error instanceof Error && error.message.includes("-20100")) return [];
    throw error;
  }
}

// --- Timetable: GTFS ---

/** A route of the network's own pools: GTFS route ids lead with the pool (`kvv-21-002E-1`). */
const isNetworkRoute = (routeId: string): boolean =>
  [...network.scope.pools].some((pool) => routeId.startsWith(`${pool}-`));

/**
 * The passenger-facing line name for each of the network's journeys, and the services each rail
 * line's journeys run on.
 */
async function readLinesByJourney(archivePath: string): Promise<{
  lineByJourneyRef: Map<string, string>;
  serviceIdsByRailLine: Map<string, Set<string>>;
  railJourneyRefs: Set<string>;
}> {
  const nameByRouteId = new Map<string, string>();
  const railRouteIds = new Set<string>();
  for await (const [routeId, shortName, routeType] of readTable(archivePath, "routes.txt", [
    "route_id",
    "route_short_name",
    "route_type",
  ])) {
    if (!routeId || !shortName || !isNetworkRoute(routeId)) continue;
    nameByRouteId.set(routeId, shortName);
    if (RAIL_ROUTE_TYPES.has(routeType ?? "")) railRouteIds.add(routeId);
  }

  const lineByJourneyRef = new Map<string, string>();
  const serviceIdsByRailLine = new Map<string, Set<string>>();
  const railJourneyRefs = new Set<string>();
  for await (const [routeId = "", serviceId, journeyRef] of readTable(archivePath, "trips.txt", [
    "route_id",
    "service_id",
    "trip_id",
  ])) {
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
type GtfsBay = Position & {
  station: string;
  code: string;
  /** Each journey's neighbouring stations, as an unordered pair. */
  routePairs: Set<string>;
  travel: { x: number; y: number };
};

/**
 * Which way each rail bay runs, by `DHID|bay`: along it and the bays of its station that serve the
 * same through route, else along its journeys. Every direction runs in the timetable, so a pair is
 * measured that a live reading may see only half of. Its position is the mean of the GTFS stop
 * points sharing its code.
 */
async function readBayRuns(
  archivePath: string,
  railJourneyRefs: ReadonlySet<string>,
  globalIds: ReadonlySet<string>,
): Promise<{ runs: Map<string, BayRun>; positions: Map<string, Position> }> {
  const positionByStopPointId = new Map<string, Position>();
  const bayByStopPointId = new Map<string, GtfsBay>();
  for await (const [stopPointId, latitude, longitude, platform] of readTable(
    archivePath,
    "stops.txt",
    ["stop_id", "stop_lat", "stop_lon", "platform_code"],
  )) {
    // Signed as the feed's bays are (`Gleis 1(U)`); keyed by the bare code, as rows state it.
    const code = readBay(platform).code;
    if (!stopPointId || !latitude || !longitude) continue;
    const position = { latitude: Number(latitude), longitude: Number(longitude) };
    positionByStopPointId.set(stopPointId, position);
    const station = toStopId(stopPointId);
    if (!code || station === stopPointId || !globalIds.has(station)) continue;
    bayByStopPointId.set(stopPointId, {
      station,
      code,
      ...position,
      routePairs: new Set(),
      travel: { x: 0, y: 0 },
    });
  }

  const readJourney = (calls: { sequence: number; stopPointId: string }[]) => {
    calls.sort((left, right) => left.sequence - right.sequence);
    for (let index = 1; index < calls.length - 1; index += 1) {
      const bay = bayByStopPointId.get(calls[index].stopPointId);
      if (!bay) continue;
      const previous = calls[index - 1].stopPointId;
      const next = calls[index + 1].stopPointId;
      const stations = [toStopId(previous), toStopId(next)];
      // An operational point no rider can find (`Tullastraße (44)`, a depot track) sets no way.
      if (stations.some((id) => id.startsWith(stopIdPrefix) && !globalIds.has(id))) continue;
      bay.routePairs.add(stations.sort().join("|"));
      const [from, to] = [positionByStopPointId.get(previous), positionByStopPointId.get(next)];
      if (!from || !to) continue;
      const axis = getTravelAxis(from, to);
      bay.travel.x += axis.x;
      bay.travel.y += axis.y;
    }
  };
  // Rows come grouped by journey.
  let journeyRef: string | undefined;
  let calls: { sequence: number; stopPointId: string }[] = [];
  for await (const [rowJourneyRef, stopPointId, sequence] of readTable(
    archivePath,
    "stop_times.txt",
    ["trip_id", "stop_id", "stop_sequence"],
  )) {
    if (rowJourneyRef !== journeyRef) {
      readJourney(calls);
      journeyRef = rowJourneyRef;
      calls = [];
    }
    if (rowJourneyRef && stopPointId && railJourneyRefs.has(rowJourneyRef)) {
      calls.push({ sequence: Number(sequence), stopPointId });
    }
  }
  readJourney(calls);

  const bays = [...bayByStopPointId.values()].filter(({ routePairs }) => routePairs.size > 0);
  const runs = new Map<string, BayRun>();
  const sharingByKey = new Map<string, GtfsBay[]>();
  for (const bay of bays) {
    const key = `${bay.station}|${bay.code}`;
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

const parseGtfsDate = (value: string): number =>
  Date.UTC(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8)));

const WEEKDAY_COLUMNS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

/**
 * The rail lines that miss a weekday: on fewer than `WEEKDAY_SHARE` of that weekday's dates in the
 * feed period, none of their journeys run.
 */
async function readNonDailyLines(
  archivePath: string,
  serviceIdsByLine: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<string[]> {
  const wanted = new Set([...serviceIdsByLine.values()].flatMap((ids) => [...ids]));
  const datesByServiceId = new Map<string, Set<number>>();
  let [periodStart, periodEnd] = [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for await (const [serviceId, start, end, ...weekdays] of readTable(archivePath, "calendar.txt", [
    "service_id",
    "start_date",
    "end_date",
    ...WEEKDAY_COLUMNS,
  ])) {
    if (!serviceId || !start || !end) continue;
    periodStart = Math.min(periodStart, parseGtfsDate(start));
    periodEnd = Math.max(periodEnd, parseGtfsDate(end));
    if (!wanted.has(serviceId)) continue;
    const dates = new Set<number>();
    for (let day = parseGtfsDate(start); day <= parseGtfsDate(end); day += DAY_MS) {
      // `monday` comes first; `getUTCDay` counts from Sunday.
      if (weekdays[(new Date(day).getUTCDay() + 6) % 7] === "1") dates.add(day);
    }
    datesByServiceId.set(serviceId, dates);
  }
  for await (const [serviceId, date, type] of readTable(archivePath, "calendar_dates.txt", [
    "service_id",
    "date",
    "exception_type",
  ])) {
    if (!serviceId || !date || !wanted.has(serviceId)) continue;
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
 * Distinct lines and calls per stop. Calls count over the feed period (a ranking, not a
 * frequency).
 */
async function readServiceByStop(
  archivePath: string,
  lineByJourneyRef: ReadonlyMap<string, string>,
  globalIds: ReadonlySet<string>,
): Promise<Map<string, { lines: Set<string>; calls: number }>> {
  const serviceByGlobalId = new Map<string, { lines: Set<string>; calls: number }>();
  for await (const [journeyRef, stopPointId] of readTable(archivePath, "stop_times.txt", [
    "trip_id",
    "stop_id",
  ])) {
    const globalId = stopPointId && toStopId(stopPointId);
    const line = lineByJourneyRef.get(journeyRef ?? "");
    if (!globalId || !line || !globalIds.has(globalId)) continue;
    const service = serviceByGlobalId.get(globalId) ?? { lines: new Set<string>(), calls: 0 };
    service.lines.add(line);
    service.calls += 1;
    serviceByGlobalId.set(globalId, service);
  }
  return serviceByGlobalId;
}

// --- Modules ---

const header = (
  sources: string,
) => `// Generated by scripts/refresh-stop-catalog.ts — do not edit by hand.
//
${sources}
//
// Refresh with: npm run refresh:stops
`;

function renderBayPositionsModule(
  positions: ReadonlyMap<string, Position>,
  source: string,
): string {
  const rows = [...positions]
    .sort(([left], [right]) => compareIds(left, right))
    .map(
      ([key, { latitude, longitude }]) =>
        `  [${JSON.stringify(key)}, ${latitude.toFixed(6)}, ${longitude.toFixed(6)}],`,
    )
    .join("\n");
  return `${header(`// Timetable: ${source}`)}
type BayPositionRow = [key: string, latitude: number, longitude: number];

const rows: readonly BayPositionRow[] = [
${rows}
];

/** Where each rail bay stands, by \`DHID|bay\`. */
export const bayPositionByKey: ReadonlyMap<
  string,
  { latitude: number; longitude: number }
> = new Map(rows.map(([key, latitude, longitude]) => [key, { latitude, longitude }]));
`;
}

function renderBayRunsModule(runs: ReadonlyMap<string, BayRun>, source: string): string {
  const rows = [...runs]
    .sort(([left], [right]) => compareIds(left, right))
    .map(([key, run]) => `  [${JSON.stringify(key)}, ${JSON.stringify(run)}],`)
    .join("\n");
  return `${header(`// Timetable: ${source}`)}
import type { BayRun } from "../../../lib/bay-runs";

/** Which way each rail bay runs, by \`DHID|bay\`. */
export const bayRunByKey: ReadonlyMap<string, BayRun> = new Map<string, BayRun>([
${rows}
]);
`;
}

function renderLineDaysModule(nonDailyLineIds: readonly string[], source: string): string {
  return `${header(`// Timetable: ${source}`)}
/**
 * Rail and tram lines that miss a weekday in the timetable period: weekday-only, weekend-only,
 * night and leisure lines. A line not named here runs every day.
 */
export const nonDailyLineIds: ReadonlySet<string> = new Set(${JSON.stringify(nonDailyLineIds).replaceAll(",", ", ")});
`;
}

/** The catalog, one row per stop for clean diffs. */
function renderCatalogModule(catalog: readonly CatalogStop[], source: string): string {
  const rows = catalog
    .map(
      ({ globalId, name, latitude, longitude, placeName, lineCount, callCount }) =>
        `  [${JSON.stringify(globalId)}, ${JSON.stringify(name)}, ${latitude}, ${longitude}, ` +
        `${JSON.stringify(placeName)}, ${lineCount}, ${callCount}],`,
    )
    .join("\n");
  return `${header(`// Stops: TRIAS LocationInformationRequest, ${stopIdPrefix}*.\n// Service: ${source}`)}
import type { CatalogStop } from "../../network-definition";

type CatalogRow = [
  globalId: string,
  name: string,
  latitude: number,
  longitude: number,
  placeName: string,
  lineCount: number,
  callCount: number,
];

const rows: readonly CatalogRow[] = [
${rows}
];

export const stopCatalog: readonly CatalogStop[] = rows.map(
  ([globalId, name, latitude, longitude, placeName, lineCount, callCount]) => ({
    globalId,
    name,
    latitude,
    longitude,
    placeName,
    lineCount,
    callCount,
  }),
);

const catalogByGlobalId = new Map(stopCatalog.map((stop) => [stop.globalId, stop]));

/** The catalog entry for a stop's DHID, or undefined for a stop outside the municipality. */
export const findCatalogStop = (globalId: string): CatalogStop | undefined =>
  catalogByGlobalId.get(globalId);
`;
}

await main();
