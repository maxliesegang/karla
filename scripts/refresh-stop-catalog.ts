/**
 * Regenerates `src/data/generated/kvv-stop-catalog.ts`.
 *
 * Two sources, one fact each, so a wrong value has one place to have come from:
 *
 * - **EFA `XML_STOPLIST_REQUEST`** states which stops the municipality has, and for each its
 *   provider id, its global id, its name, its position, and the locality it belongs to. The
 *   locality is the part no other source carries: GTFS knows a stop's parent station but nothing
 *   about the place around it, and the place is what tells two stops sharing a name apart.
 * - **KVV's CC0 GTFS feed** states how much service each stop sees — the lines that call there and
 *   how many calls the period holds. EFA will only answer that one stop at a time, at ~30 KB a
 *   request; the feed answers it for the whole municipality in one download.
 *
 * The two are joined on the global id, which both state, rather than on the shape of the provider
 * id. `7000089` and `de:08212:89` do relate by dropping a leading digit, but that is a coincidence
 * of the numbering rather than a rule either publisher states, and a join has no business resting
 * on it.
 *
 * This is deliberately not something the app runs. What it writes is the timetable's own account
 * of where stops are and how much calls at them, which changes when the timetable period does —
 * not which lines are running today, which stays observed from live trips.
 *
 *     npm run refresh:stops
 *
 * Requires `unzip` on the PATH. The archive holds 227 MB unpacked, of which `stop_times.txt` is
 * 207 MB, so it is read through a pipe rather than unpacked to disk.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const STOP_LIST_ENDPOINT = "https://projekte.kvv-efa.de/sl3-alone/XML_STOPLIST_REQUEST";
const GTFS_ARCHIVE_URL = "https://projekte.kvv-efa.de/GTFS/google_transit.zip";
const OUTPUT_PATH = new URL("../src/data/generated/kvv-stop-catalog.ts", import.meta.url);

/** The municipality this app serves, as the official municipality key (Gemeindekennziffer). */
const MUNICIPALITY_OMC = "8212000";
/** Global ids of stops in that municipality all carry this prefix; GTFS prefixes stations with `P`. */
const GLOBAL_ID_PREFIX = "de:08212:";

/** What the catalog states about one stop. Mirrors `KvvCatalogStop` in the generated module. */
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

    const lineByTripId = await readLineNamesByTrip(archivePath);
    console.log(`GTFS: ${lineByTripId.size} trips`);

    const serviceByGlobalId = await readServiceByStation(archivePath, lineByTripId);
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
      // Ordered by the number the operator gave the stop, so a refresh diffs as the stops whose
      // service changed rather than as a file that reflowed around a renamed one.
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

/** The numeric part of a global id, which is the operator's own stop number. */
const catalogSortKey = ({ globalId }: { globalId: string }): number =>
  Number.parseInt(globalId.slice(GLOBAL_ID_PREFIX.length), 10) || 0;

/**
 * Every stop of the municipality, with the locality it sits in.
 *
 * `XML_STOPLIST_REQUEST` is the one EFA request that answers in `rapidJSON` only: asked for the
 * `json` the rest of this app speaks it returns HTTP 200 and an empty body, which is why the app's
 * own client never learned to call it.
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

/** Downloads the archive and returns the `feed_version` it states, which dates everything below. */
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

/** The passenger-facing name of the line each trip runs, which is what a rider counts as a line. */
async function readLineNamesByTrip(archivePath: string): Promise<Map<string, string>> {
  const nameByRouteId = new Map<string, string>();
  for await (const [routeId, , shortName] of columnsOf(archivePath, "routes.txt", 3)) {
    if (routeId && shortName) nameByRouteId.set(routeId, shortName);
  }

  const lineByTripId = new Map<string, string>();
  for await (const [routeId, , tripId] of columnsOf(archivePath, "trips.txt", 3)) {
    const name = nameByRouteId.get(routeId ?? "");
    if (tripId && name) lineByTripId.set(tripId, name);
  }
  return lineByTripId;
}

/**
 * How much service each station sees: the distinct lines calling there, and how many calls.
 *
 * Counted against the parent station rather than the platform, because a rider changing lines at
 * Marktplatz does not care which of its platforms each line uses. The count is calls in the feed
 * period, not calls per day — a trip that runs on two days of the week is one trip here, so the
 * number ranks stops against each other and is not a frequency.
 */
async function readServiceByStation(
  archivePath: string,
  lineByTripId: ReadonlyMap<string, string>,
): Promise<Map<string, { lines: Set<string>; calls: number }>> {
  const stationByPlatformId = new Map<string, string>();
  for await (const [stopId, , , , , , , parentStation] of columnsOf(archivePath, "stops.txt", 8)) {
    // GTFS names the station `Pde:08212:1011` where EFA names the same stop `de:08212:1011`.
    if (stopId?.startsWith(GLOBAL_ID_PREFIX) && parentStation?.startsWith(`P${GLOBAL_ID_PREFIX}`)) {
      stationByPlatformId.set(stopId, parentStation.slice(1));
    }
  }

  const serviceByGlobalId = new Map<string, { lines: Set<string>; calls: number }>();
  for await (const [tripId, , , stopId] of columnsOf(archivePath, "stop_times.txt", 4)) {
    const globalId = stationByPlatformId.get(stopId ?? "");
    const line = lineByTripId.get(tripId ?? "");
    if (!globalId || !line) continue;
    const service = serviceByGlobalId.get(globalId) ?? { lines: new Set<string>(), calls: 0 };
    service.lines.add(line);
    service.calls += 1;
    serviceByGlobalId.set(globalId, service);
  }
  return serviceByGlobalId;
}

/** The rows of one archive member, header skipped, cut to the columns a caller reads. */
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
 * One member of the archive, streamed through `unzip -p` and parsed as GTFS's quoted CSV.
 *
 * Only the first `fieldCount` fields of each row are parsed: `stop_times.txt` holds 2.2 million
 * rows of which every one is read, and the fields worth reading are the leading ones.
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
      // The publisher writes a BOM at the head of every member.
      if (line) yield readFields(line.charCodeAt(0) === 0xfeff ? line.slice(1) : line, fieldCount);
    }
    await Promise.race([failure, Promise.resolve()]);
  } finally {
    unzip.kill();
  }
}

/** The leading fields of one CSV row. GTFS quotes with `"` and escapes a quote by doubling it. */
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

/**
 * The generated module.
 *
 * One row per stop, so a refresh diffs as the stops that changed rather than as a reflowed file,
 * and the columns are named once here rather than repeated 389 times.
 */
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
