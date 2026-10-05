/**
 * Solves the Zentrum's octilinear layout closest to the real city, for
 * `src/lib/zentrum-schematic-plan.ts`.
 *
 *     npm run solve:zentrum -- [--from <file>] [--save <file>] [--grid 22] [--scale 3.4]
 *
 * Reads the feed once (median platform positions per node, observed corridors) and saves it beside
 * the script, so solves can be re-run offline. Then:
 * 1. A direction per corridor: the nearest of the eight to its bearing, claimed once per place,
 *    best fit first.
 * 2. Positions: least distortion from real positions and lengths, directions held by a heavy
 *    weight.
 * 3. The grid: rounded to the step, then annealed over whole cells until no corridor bends, no two
 *    places crowd, and no corridor passes a place it does not call at.
 *
 * Prints the node table and a comparison with the current layout. It prints rather than writes, so
 * a human reviews the layout before it lands.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { findCatalogStop } from "../src/data/generated/kvv-stop-catalog.ts";
import { KvvEfaClient } from "../src/data/kvv-efa-client.ts";
import { kvvStopMappingByLocalStopId } from "../src/data/kvv-stop-mappings.ts";
import { StopRegistry } from "../src/data/stop-registry.ts";
import type { DepartureBoard, TripCall } from "../src/data/transit-types.ts";
import { zentrumStopIds } from "../src/data/zentrum-stops.ts";
import { buildZentrumSchematicReading } from "../src/lib/zentrum-schematic.ts";
import { getBoardTimetableTrips } from "../src/lib/trips.ts";
import {
  ZENTRUM_SCHEMATIC_GRID,
  ZENTRUM_SCHEMATIC_NODES,
  findZentrumSchematicNodeId,
} from "../src/lib/zentrum-schematic-plan.ts";
import {
  angleBetween,
  assignDirections,
  bearingOf,
  chooseLabelSide,
  distanceToSegment,
  type Edge,
  edgeKey,
  makeRandom,
  type Point,
  solvePositions,
} from "./octilinear-layout.ts";

const OBSERVATIONS_PATH = "scripts/zentrum-layout-observations.json";

/** Metres per drawing unit; sets the plan's size, not its shape. */
const DEFAULT_METRES_PER_UNIT = 3.4;

/** The grid step; coarser reads better but distorts more, and the report shows the cost. */
const DEFAULT_GRID = ZENTRUM_SCHEMATIC_GRID;

/** The separation between places, in drawing units, so names fit beside dots. */
const MINIMUM_SEPARATION = ZENTRUM_SCHEMATIC_GRID * 1.5;

/** How close a corridor may pass to a place it does not call at. */
const MINIMUM_CLEARANCE = ZENTRUM_SCHEMATIC_GRID * 0.75;

type Observations = {
  capturedAt: string;
  nodes: { id: string; latitude: number; longitude: number; samples: number }[];
  edges: { from: string; to: string; lineIds: string[] }[];
};

const readOption = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  return index < 0 ? undefined : process.argv[index + 1];
};

/* ------------------------------------------------------------------ reading */

/**
 * Reads the feed as the app does; a node's position is the median of its calls, ignoring outliers.
 */
async function observe(rowLimit: number): Promise<Observations> {
  const stops = new StopRegistry([]);
  const client = new KvvEfaClient();
  const boards: DepartureBoard[] = [];
  const coordinates = new Map<string, { latitudes: number[]; longitudes: number[] }>();

  for (const stopId of zentrumStopIds) {
    const mapping = kvvStopMappingByLocalStopId[stopId];
    if (!mapping) {
      console.error(`! ${stopId} has no provider mapping and cannot be read`);
      continue;
    }
    try {
      const board = await client.fetchDepartureBoard(mapping.providerStopId, {
        limit: mapping.departureLimit ?? rowLimit,
        includeTripCalls: true,
      });
      boards.push({
        stopId,
        receivedAt: Date.now(),
        dataStatus: "live",
        feedUpdatedAt: board.serverTime,
        departures: board.departures.map((departure, index) => ({
          ...departure,
          id: departure.tripInstanceId ?? departure.tripId ?? `${departure.lineId}-${index}`,
          boardingLocalStopId: stopId,
          boardingProviderStopPointId: departure.stopPointId,
          boardingProviderStopPointName: departure.stopPointName,
          platformCode: departure.platformCode ?? "",
          tripCalls: (departure.tripCalls ?? []).map((call): TripCall => {
            const tripCall: TripCall = {
              stopName: call.stopName,
              platformCode: call.platformCode,
              providerStopPointId: call.providerId,
              localStopId: call.providerId ? stops.findLocalStopId(call.providerId) : undefined,
            };
            const nodeId = findZentrumSchematicNodeId(tripCall);
            if (nodeId && call.latitude !== undefined && call.longitude !== undefined) {
              const bucket = coordinates.get(nodeId) ?? { latitudes: [], longitudes: [] };
              bucket.latitudes.push(call.latitude);
              bucket.longitudes.push(call.longitude);
              coordinates.set(nodeId, bucket);
            }
            return tripCall;
          }),
        })),
      });
    } catch (error) {
      console.error(`! ${stopId} did not answer: ${(error as Error).message}`);
    }
  }

  const median = (values: readonly number[]): number =>
    [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
  const reading = buildZentrumSchematicReading(getBoardTimetableTrips(boards));
  return {
    capturedAt: new Date().toISOString(),
    nodes: [...coordinates]
      .map(([id, bucket]) => ({
        id,
        latitude: median(bucket.latitudes),
        longitude: median(bucket.longitudes),
        samples: bucket.latitudes.length,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    edges: reading.corridors
      .map((edge) => ({ from: edge.from.id, to: edge.to.id, lineIds: [...edge.lineIds] }))
      .sort((left, right) => edgeKey(left).localeCompare(edgeKey(right))),
  };
}

/* --------------------------------------------------------------- projecting */

/** Equirectangular projection around the Zentrum, north up. */
function project(observations: Observations, metresPerUnit: number): Map<string, Point> {
  const centreLatitude =
    observations.nodes.reduce((sum, node) => sum + node.latitude, 0) / observations.nodes.length;
  const centreLongitude =
    observations.nodes.reduce((sum, node) => sum + node.longitude, 0) / observations.nodes.length;
  const metresPerDegreeLongitude = 111320 * Math.cos((centreLatitude * Math.PI) / 180);
  const metresPerDegreeLatitude = 110574;
  return new Map(
    observations.nodes.map((node) => [
      node.id,
      {
        x: ((node.longitude - centreLongitude) * metresPerDegreeLongitude) / metresPerUnit,
        // Latitude grows north and the page grows down.
        y: (-(node.latitude - centreLatitude) * metresPerDegreeLatitude) / metresPerUnit,
      },
    ]),
  );
}

/* ------------------------------------------------------------- the grid step */

/** Every way the drawing can be wrong, counted. */
function countViolations(
  layout: ReadonlyMap<string, Point>,
  edges: readonly Edge[],
  nodeIds: readonly string[],
): number {
  let violations = 0;

  for (const edge of edges) {
    const from = layout.get(edge.from);
    const to = layout.get(edge.to);
    if (!from || !to) continue;
    const runX = Math.abs(to.x - from.x);
    const runY = Math.abs(to.y - from.y);
    // Level, upright, or exactly diagonal, and never nothing at all.
    if (runX !== 0 && runY !== 0 && runX !== runY) violations += 1;
    if (runX === 0 && runY === 0) violations += 1;
  }

  for (let index = 0; index < nodeIds.length; index += 1) {
    const left = layout.get(nodeIds[index]);
    if (!left) continue;
    for (let other = index + 1; other < nodeIds.length; other += 1) {
      const right = layout.get(nodeIds[other]);
      if (!right) continue;
      if (Math.hypot(left.x - right.x, left.y - right.y) < MINIMUM_SEPARATION) violations += 1;
    }
  }

  // A corridor may not run through, or close past, a place it does not call at.
  for (const edge of edges) {
    const from = layout.get(edge.from);
    const to = layout.get(edge.to);
    if (!from || !to) continue;
    for (const id of nodeIds) {
      if (id === edge.from || id === edge.to) continue;
      const node = layout.get(id);
      if (!node) continue;
      if (distanceToSegment(node, from, to) < MINIMUM_CLEARANCE) violations += 1;
    }
  }

  return violations;
}

/** How far this drawing is from the city, in the two ways a reader would notice. */
function geographicCost(
  layout: ReadonlyMap<string, Point>,
  edges: readonly Edge[],
  geography: ReadonlyMap<string, Point>,
  nodeIds: readonly string[],
): number {
  let cost = 0;
  for (const edge of edges) {
    const from = layout.get(edge.from);
    const to = layout.get(edge.to);
    const geoFrom = geography.get(edge.from);
    const geoTo = geography.get(edge.to);
    if (!from || !to || !geoFrom || !geoTo) continue;
    // A corridor pointing the wrong way is seen first, so it weighs most.
    cost += 12 * angleBetween(bearingOf(from, to), bearingOf(geoFrom, geoTo)) ** 2;
    const drawn = Math.hypot(to.x - from.x, to.y - from.y);
    const true_ = Math.hypot(geoTo.x - geoFrom.x, geoTo.y - geoFrom.y);
    cost += 2 * (drawn - true_) ** 2;
  }
  // The whole shape must stay recognisable, too.
  for (const id of nodeIds) {
    const drawn = layout.get(id);
    const target = geography.get(id);
    if (!drawn || !target) continue;
    cost += (drawn.x - target.x) ** 2 + (drawn.y - target.y) ** 2;
  }
  return cost;
}

/**
 * Rounds to the grid and anneals over whole cells. Faults carry a weight nothing outbids, and no
 * arrangement with a fault is returned.
 */
function snapToGrid(
  positions: ReadonlyMap<string, Point>,
  edges: readonly Edge[],
  geography: ReadonlyMap<string, Point>,
  nodeIds: readonly string[],
  seed: number,
  grid: number,
): Map<string, Point> | null {
  const random = makeRandom(seed);
  const layout = new Map<string, Point>(
    nodeIds.map((id) => {
      const point = positions.get(id) ?? { x: 0, y: 0 };
      return [id, { x: Math.round(point.x / grid) * grid, y: Math.round(point.y / grid) * grid }];
    }),
  );

  const VIOLATION_WEIGHT = 1e7;
  const scoreOf = (candidate: ReadonlyMap<string, Point>) =>
    geographicCost(candidate, edges, geography, nodeIds) +
    VIOLATION_WEIGHT * countViolations(candidate, edges, nodeIds);

  let current = scoreOf(layout);
  let best = new Map(layout);
  let bestScore = current;

  const steps = 600_000;
  for (let step = 0; step < steps; step += 1) {
    // Warm enough to escape rounding damage, not to forget the solve.
    const temperature = 0.5 * (1 - step / steps) ** 3 + 0.002;
    const id = nodeIds[Math.floor(random() * nodeIds.length)];
    const point = layout.get(id);
    if (!point) continue;
    const reach = random() < 0.75 ? 1 : 2;
    const moved = {
      x: point.x + (Math.floor(random() * 3) - 1) * reach * grid,
      y: point.y + (Math.floor(random() * 3) - 1) * reach * grid,
    };
    if (moved.x === point.x && moved.y === point.y) continue;

    layout.set(id, moved);
    const candidate = scoreOf(layout);
    const accepted =
      candidate <= current || random() < Math.exp((current - candidate) / (temperature * 1e4));
    if (!accepted) {
      layout.set(id, point);
      continue;
    }
    current = candidate;
    if (candidate < bestScore) {
      bestScore = candidate;
      best = new Map(layout);
    }
  }

  return countViolations(best, edges, nodeIds) === 0 ? best : null;
}

/* ------------------------------------------------------------------ printing */

function report(
  title: string,
  layout: ReadonlyMap<string, Point>,
  edges: readonly Edge[],
  geography: ReadonlyMap<string, Point>,
  nodeIds: readonly string[],
): void {
  const errors = edges.flatMap((edge) => {
    const from = layout.get(edge.from);
    const to = layout.get(edge.to);
    const geoFrom = geography.get(edge.from);
    const geoTo = geography.get(edge.to);
    if (!from || !to || !geoFrom || !geoTo) return [];
    return [
      {
        id: `${edge.from} <-> ${edge.to}`,
        off: angleBetween(bearingOf(from, to), bearingOf(geoFrom, geoTo)),
      },
    ];
  });
  errors.sort((left, right) => right.off - left.off);
  const mean = errors.reduce((sum, entry) => sum + entry.off, 0) / (errors.length || 1);
  const misdirected = errors.filter((entry) => entry.off > 22.5);

  // Measured after the best-fit shift, so position on the canvas does not count as distortion.
  const pairs = nodeIds.flatMap((id) => {
    const drawn = layout.get(id);
    const target = geography.get(id);
    return drawn && target ? [{ drawn, target }] : [];
  });
  const shift = {
    x: pairs.reduce((sum, pair) => sum + pair.target.x - pair.drawn.x, 0) / (pairs.length || 1),
    y: pairs.reduce((sum, pair) => sum + pair.target.y - pair.drawn.y, 0) / (pairs.length || 1),
  };
  const displacements = pairs.map((pair) =>
    Math.hypot(pair.drawn.x + shift.x - pair.target.x, pair.drawn.y + shift.y - pair.target.y),
  );
  const meanDisplacement =
    displacements.reduce((sum, value) => sum + value, 0) / (displacements.length || 1);

  console.log(`\n${title}`);
  console.log(
    `  bearing error   mean ${mean.toFixed(1)} deg, worst ${(errors[0]?.off ?? 0).toFixed(1)} deg`,
  );
  console.log(
    `  wrong direction ${misdirected.length} of ${errors.length} corridors more than 22.5 deg off`,
  );
  console.log(
    `  displacement    mean ${meanDisplacement.toFixed(1)} units, worst ${Math.max(...displacements, 0).toFixed(1)} units`,
  );
  console.log(`  faults          ${countViolations(layout, edges, nodeIds)}`);
  for (const entry of misdirected.slice(0, 8)) {
    console.log(`    ${entry.off.toFixed(0).padStart(3)} deg  ${entry.id}`);
  }
}

/* ---------------------------------------------------------------------- main */

async function main(): Promise<void> {
  const from = readOption("--from");
  const metresPerUnit = Number(readOption("--scale") ?? DEFAULT_METRES_PER_UNIT);
  const grid = Number(readOption("--grid") ?? DEFAULT_GRID);
  const seed = Number(readOption("--seed") ?? 7);

  const observed: Observations = from ? JSON.parse(readFileSync(from, "utf8")) : await observe(40);
  if (!from) {
    const savePath = readOption("--save") ?? OBSERVATIONS_PATH;
    writeFileSync(savePath, `${JSON.stringify(observed, null, 2)}\n`);
    console.log(
      `Observed ${observed.nodes.length} places, ${observed.edges.length} corridors -> ${savePath}`,
    );
  } else {
    console.log(
      `Read ${observed.nodes.length} places, ${observed.edges.length} corridors from ${from} (${observed.capturedAt})`,
    );
  }
  console.log(`Solving on a ${grid}-unit grid at ${metresPerUnit} m per unit.`);

  const authored = new Map(ZENTRUM_SCHEMATIC_NODES.map((node) => [node.id, node]));
  const observations = observed;

  // Stops with nothing observed (closed) are placed from the catalogue, so they have room on
  // return.
  for (const stopId of zentrumStopIds) {
    if (observations.nodes.some((node) => node.id === stopId)) continue;
    const mapping = kvvStopMappingByLocalStopId[stopId];
    const catalogued = mapping && findCatalogStop(mapping.providerStopId);
    if (!catalogued) {
      console.error(`! ${stopId} was neither observed nor catalogued, and cannot be placed`);
      continue;
    }
    observations.nodes.push({
      id: stopId,
      latitude: catalogued.latitude,
      longitude: catalogued.longitude,
      samples: 0,
    });
  }
  observations.nodes.sort((left, right) => left.id.localeCompare(right.id));

  const geography = project(observations, metresPerUnit);
  const solvedIds = observations.nodes.map((node) => node.id);
  const edges = observations.edges.filter(
    (edge) => geography.has(edge.from) && geography.has(edge.to),
  );

  // The current drawing, for comparison.
  const currentLayout = new Map<string, Point>(
    solvedIds.flatMap((id) => {
      const node = authored.get(id);
      return node ? [[id, { x: node.x, y: node.y }] as const] : [];
    }),
  );
  report("The table as it stands", currentLayout, edges, geography, [...currentLayout.keys()]);

  const directions = assignDirections(edges, geography);
  const lengths = new Map(
    edges.map((edge) => {
      const from = geography.get(edge.from);
      const to = geography.get(edge.to);
      const distance = from && to ? Math.hypot(to.x - from.x, to.y - from.y) : 0;
      // No corridor may pull two places closer than the minimum separation.
      return [edgeKey(edge), Math.max(distance, MINIMUM_SEPARATION)] as const;
    }),
  );
  const settled = solvePositions(
    solvedIds,
    edges,
    geography,
    directions,
    lengths,
    ZENTRUM_SCHEMATIC_GRID,
  );
  report("Settled, before the grid", settled, edges, geography, solvedIds);
  const solved = snapToGrid(settled, edges, geography, solvedIds, seed, grid);
  if (!solved) {
    console.error(
      "\nNo arrangement without faults was found. Try another --seed, --grid or --scale.",
    );
    process.exitCode = 1;
    return;
  }
  report(`Solved on a ${grid}-unit grid`, solved, edges, geography, solvedIds);

  // Shifted so its top left matches the old one: a crop, not new coordinates.
  const minX = Math.min(...[...solved.values()].map((point) => point.x));
  const minY = Math.min(...[...solved.values()].map((point) => point.y));
  const shiftX = Math.round((110 - minX) / grid) * grid;
  const shiftY = Math.round((66 - minY) / grid) * grid;

  const placed = [...solved]
    .map(([id, point]) => ({
      id,
      x: point.x + shiftX,
      y: point.y + shiftY,
      labelSide: chooseLabelSide(id, solved, edges),
    }))
    .sort((left, right) => left.y - right.y || left.x - right.x);

  console.log("\nThe table, in reading order:\n");
  for (const node of placed) {
    const label = authored.get(node.id)?.label ?? node.id;
    // Authored, not solved: kept as written.
    const platformRun = authored.get(node.id)?.platformRun;
    console.log(
      `  { id: "${node.id}", label: "${label}", x: ${node.x}, y: ${node.y}, ` +
        `labelSide: "${node.labelSide}"${platformRun ? `, platformRun: "${platformRun}"` : ""} },`,
    );
  }

  const catalogued = observations.nodes.filter((node) => node.samples === 0).map((node) => node.id);
  if (catalogued.length) {
    console.log(
      `\nPlaced from the timetable catalogue, nothing having been observed: ${catalogued.join(", ")}`,
    );
  }

  // Optionally written as JSON, for rendering beside the current drawing.
  const jsonPath = readOption("--json");
  if (jsonPath) {
    writeFileSync(
      jsonPath,
      `${JSON.stringify(
        {
          grid,
          metresPerUnit,
          nodes: placed.map((node) => ({
            ...node,
            label: authored.get(node.id)?.label ?? node.id,
          })),
          edges: edges.map((edge) => ({ from: edge.from, to: edge.to })),
        },
        null,
        2,
      )}\n`,
    );
    console.log(`\nThe solved drawing -> ${jsonPath}`);
  }

  const xs = placed.map((node) => node.x);
  const ys = placed.map((node) => node.y);
  console.log(
    `\nThe drawing occupies x ${Math.min(...xs)}..${Math.max(...xs)}, y ${Math.min(...ys)}..${Math.max(...ys)}.`,
  );
  console.log("The viewBox is that, opened out by what the labels beside the outermost dots need.");
}

await main();
