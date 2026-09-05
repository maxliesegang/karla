/**
 * Solves the Zentrum's drawing surface: the octilinear layout closest to the real city.
 *
 * `src/lib/zentrum-schematic-plan.ts` authors where each place is drawn, and that table is the one thing
 * on the plan geography can contradict. It was first produced by an annealing run that lived
 * outside the repository, so what it was solved for could only be read back out of a comment, and
 * what it had traded away could not be read at all. Measured against the coordinates the feed
 * publishes for the very platforms it draws, twelve of thirty-seven corridors ran in the wrong one
 * of the eight directions, Marktplatz's two tunnels among them.
 *
 * So the solve is a script, and it states its own result:
 *
 *     npm run solve:zentrum -- [--from <file>] [--save <file>] [--grid 22] [--scale 3.4]
 *
 * It reads the feed once, the way the app reads it and through the same portal rules, and keeps the
 * two things a layout can be solved against: where each node's platforms really are, as the median
 * of every call the feed placed there, and which corridors trips are running. Both are written
 * beside this script, so the solve can be re-run, argued with and compared without the network, and
 * so a reader can see exactly what the drawing was answerable to.
 *
 * Then it solves in three movements.
 *
 * 1. **A direction for every corridor**, taken from its true bearing: the nearest of the eight, and
 *    where two corridors at one place would claim the same one, the better-fitting keeps it. This
 *    is the step that repairs a wrong direction rather than polishing it.
 * 2. **Positions**, as the least-distorted placement those directions allow. Each place is pulled
 *    towards where it really stands and each corridor towards its true length, while every corridor
 *    is held to its direction by a weight heavy enough to win.
 * 3. **The grid**, which is where the drawing becomes a drawing. The settled positions are rounded
 *    to the step, and what rounding breaks -- a corridor no longer straight, two places closer than
 *    a name needs, a corridor running through a place it does not call at -- is repaired by
 *    annealing over whole cells, from which no infeasible arrangement is ever returned.
 *
 * What it prints is the node table, ready to be read and pasted, and the report that says whether
 * this drawing is better than the one it replaces.
 *
 * The layout stays authored: a human reads the table before it lands. That is why this prints
 * rather than writes. A solver that edited the app's own source would make the drawing an output,
 * and the one thing this drawing must remain is answerable.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { findCatalogStop } from "../src/data/generated/kvv-stop-catalog.ts";
import { KvvEfaClient } from "../src/data/kvv-efa-client.ts";
import { kvvStopMappingByLocalStopId } from "../src/data/kvv-stop-mappings.ts";
import { StopRegistry } from "../src/data/stop-registry.ts";
import type { DepartureBoard, TripCall } from "../src/data/transit-types.ts";
import { zentrumStopIds } from "../src/data/zentrum-stops.ts";
import { buildZentrumSchematicReading } from "../src/lib/zentrum-schematic.ts";
import {
  ZENTRUM_SCHEMATIC_GRID,
  ZENTRUM_SCHEMATIC_NODES,
  findZentrumSchematicNodeId,
} from "../src/lib/zentrum-schematic-plan.ts";

const OBSERVATIONS_PATH = "scripts/zentrum-layout-observations.json";

/** Metres to one drawing unit. Decides how large the plan is drawn; nothing about its shape. */
const DEFAULT_METRES_PER_UNIT = 3.4;

/**
 * The step positions are rounded to, which need not be the step the app has always drawn on.
 *
 * A coarse grid is what makes an octilinear drawing readable -- corridors meet at a few sizes of
 * angle and the eye reads a system rather than a scatter -- but it is also the last thing to
 * distort the geography, because a place may be a whole step from where it belongs. So it is a
 * parameter, and the report says what each setting cost. The angles do not depend on the step
 * being large; a diagonal is a diagonal on any grid.
 */
const DEFAULT_GRID = ZENTRUM_SCHEMATIC_GRID;

/**
 * The separation the plan keeps, so two names can stand beside two dots.
 *
 * Stated in drawing units rather than in grid steps, because what it protects is a label, and a
 * label does not get smaller when the grid does.
 */
const MINIMUM_SEPARATION = ZENTRUM_SCHEMATIC_GRID * 1.5;

/** How close a corridor may pass to a place it does not call at. */
const MINIMUM_CLEARANCE = ZENTRUM_SCHEMATIC_GRID * 0.75;

type Observations = {
  capturedAt: string;
  nodes: { id: string; latitude: number; longitude: number; samples: number }[];
  edges: { from: string; to: string; lineIds: string[] }[];
};

type Point = { x: number; y: number };
type Edge = { from: string; to: string };

const readOption = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  return index < 0 ? undefined : process.argv[index + 1];
};

const edgeKey = (edge: Edge): string => `${edge.from} ${edge.to}`;

/* ------------------------------------------------------------------ reading */

/**
 * Reads the feed the way the app reads it, and keeps only what a layout can be solved against.
 *
 * A node's position is the median of every call the feed placed there rather than the mean: one
 * call published at the wrong end of a complex would drag a mean across the street, and the median
 * of a few hundred simply ignores it.
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
  const reading = buildZentrumSchematicReading(boards);
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
    edges: reading.edges
      .map((edge) => ({ from: edge.from.id, to: edge.to.id, lineIds: [...edge.lineIds] }))
      .sort((left, right) => edgeKey(left).localeCompare(edgeKey(right))),
  };
}

/* --------------------------------------------------------------- projecting */

/**
 * Degrees onto the drawing's own units, north up.
 *
 * Equirectangular around the middle of the Zentrum: across three kilometres of one city the error
 * of that is centimetres, and it keeps north pointing up the page -- which a plan of a place
 * someone is standing in has to do, whatever a best fit would rotate it to.
 */
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

/* ------------------------------------------------------------ octilinearity */

const DIRECTIONS = [0, 45, 90, 135, 180, 225, 270, 315] as const;
const unitOf = (degrees: number): Point => ({
  x: Math.round(Math.cos((degrees * Math.PI) / 180) * 1e6) / 1e6,
  y: Math.round(Math.sin((degrees * Math.PI) / 180) * 1e6) / 1e6,
});
const bearingOf = (from: Point, to: Point): number =>
  ((Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI + 360) % 360;
const angleBetween = (left: number, right: number): number =>
  Math.abs(((left - right + 540) % 360) - 180);

/**
 * One of the eight for every corridor, best fits first.
 *
 * Two corridors leaving one place in the same direction would be drawn over each other, so a
 * direction is claimed once per place. Claiming in order of fit means a corridor whose bearing
 * geography states plainly keeps the direction geography gives it, and the one that has to give way
 * is always the one that was least sure of itself.
 */
function assignDirections(
  edges: readonly Edge[],
  geography: ReadonlyMap<string, Point>,
): Map<string, number> {
  const candidates = edges.map((edge) => {
    const from = geography.get(edge.from);
    const to = geography.get(edge.to);
    const bearing = from && to ? bearingOf(from, to) : 0;
    const ranked = [...DIRECTIONS].sort(
      (left, right) => angleBetween(left, bearing) - angleBetween(right, bearing),
    );
    return { edge, bearing, ranked, best: angleBetween(ranked[0], bearing) };
  });
  candidates.sort((left, right) => left.best - right.best);

  const claimed = new Map<string, Set<number>>();
  const isFree = (nodeId: string, direction: number) => !claimed.get(nodeId)?.has(direction);
  const claim = (nodeId: string, direction: number) => {
    const set = claimed.get(nodeId) ?? new Set<number>();
    set.add(direction);
    claimed.set(nodeId, set);
  };

  const assignments = new Map<string, number>();
  for (const candidate of candidates) {
    const direction =
      candidate.ranked.find(
        (option) =>
          isFree(candidate.edge.from, option) && isFree(candidate.edge.to, (option + 180) % 360),
      ) ?? candidate.ranked[0];
    claim(candidate.edge.from, direction);
    claim(candidate.edge.to, (direction + 180) % 360);
    assignments.set(edgeKey(candidate.edge), direction);
  }
  return assignments;
}

/* ------------------------------------------------------------------ solving */

/**
 * The least-distorted positions the assigned directions allow.
 *
 * Every place is pulled towards where it really stands, every corridor towards its true length, and
 * every corridor is held to its direction sideways by a weight heavy enough that the other two
 * never win. Each place's own best position given its neighbours is a two-by-two solve; sweeping
 * them until nothing moves is the whole method, and on thirty-seven places it settles in a blink.
 */
function solvePositions(
  nodeIds: readonly string[],
  edges: readonly Edge[],
  geography: ReadonlyMap<string, Point>,
  directions: ReadonlyMap<string, number>,
  lengths: ReadonlyMap<string, number>,
): Map<string, Point> {
  const POSITION_WEIGHT = 1;
  const LENGTH_WEIGHT = 2;
  const DIRECTION_WEIGHT = 400;

  const positions = new Map<string, Point>(
    nodeIds.map((id) => [id, { ...(geography.get(id) ?? { x: 0, y: 0 }) }]),
  );
  const edgesByNode = new Map<string, { edge: Edge; isFrom: boolean }[]>();
  for (const edge of edges) {
    for (const [id, isFrom] of [
      [edge.from, true],
      [edge.to, false],
    ] as const) {
      const list = edgesByNode.get(id) ?? [];
      list.push({ edge, isFrom });
      edgesByNode.set(id, list);
    }
  }

  for (let sweep = 0; sweep < 4000; sweep += 1) {
    let movement = 0;
    for (const id of nodeIds) {
      const target = geography.get(id);
      // cost = pAp - 2b.p, least at p = inverse(A) b.
      let a11 = POSITION_WEIGHT;
      let a12 = 0;
      let a22 = POSITION_WEIGHT;
      let b1 = POSITION_WEIGHT * (target?.x ?? 0);
      let b2 = POSITION_WEIGHT * (target?.y ?? 0);

      for (const { edge, isFrom } of edgesByNode.get(id) ?? []) {
        const key = edgeKey(edge);
        const direction = directions.get(key) ?? 0;
        const length = lengths.get(key) ?? ZENTRUM_SCHEMATIC_GRID;
        // Pointing from the neighbour back to this place.
        const tangent = unitOf(isFrom ? (direction + 180) % 360 : direction);
        const normal = { x: -tangent.y, y: tangent.x };
        const other = positions.get(isFrom ? edge.to : edge.from);
        if (!other) continue;
        const wanted = { x: other.x + tangent.x * length, y: other.y + tangent.y * length };
        const m11 = LENGTH_WEIGHT * tangent.x ** 2 + DIRECTION_WEIGHT * normal.x ** 2;
        const m12 = LENGTH_WEIGHT * tangent.x * tangent.y + DIRECTION_WEIGHT * normal.x * normal.y;
        const m22 = LENGTH_WEIGHT * tangent.y ** 2 + DIRECTION_WEIGHT * normal.y ** 2;
        a11 += m11;
        a12 += m12;
        a22 += m22;
        b1 += m11 * wanted.x + m12 * wanted.y;
        b2 += m12 * wanted.x + m22 * wanted.y;
      }

      const determinant = a11 * a22 - a12 * a12;
      if (Math.abs(determinant) < 1e-9) continue;
      const solved = {
        x: (a22 * b1 - a12 * b2) / determinant,
        y: (a11 * b2 - a12 * b1) / determinant,
      };
      const current = positions.get(id);
      if (!current) continue;
      movement = Math.max(movement, Math.hypot(solved.x - current.x, solved.y - current.y));
      positions.set(id, solved);
    }
    if (movement < 1e-4) break;
  }
  return positions;
}

/* ------------------------------------------------------------- the grid step */

/** Every way the drawing can be wrong, counted rather than argued about. */
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

function distanceToSegment(point: Point, from: Point, to: Point): number {
  const runX = to.x - from.x;
  const runY = to.y - from.y;
  const lengthSquared = runX * runX + runY * runY;
  if (lengthSquared === 0) return Math.hypot(point.x - from.x, point.y - from.y);
  const along = Math.max(
    0,
    Math.min(1, ((point.x - from.x) * runX + (point.y - from.y) * runY) / lengthSquared),
  );
  return Math.hypot(point.x - (from.x + along * runX), point.y - (from.y + along * runY));
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
    // A corridor pointing the wrong way is the error a reader sees first, so it is weighed first.
    cost += 12 * angleBetween(bearingOf(from, to), bearingOf(geoFrom, geoTo)) ** 2;
    const drawn = Math.hypot(to.x - from.x, to.y - from.y);
    const true_ = Math.hypot(geoTo.x - geoFrom.x, geoTo.y - geoFrom.y);
    cost += 2 * (drawn - true_) ** 2;
  }
  // And the whole shape has to stay recognisable, not only each corridor separately.
  for (const id of nodeIds) {
    const drawn = layout.get(id);
    const target = geography.get(id);
    if (!drawn || !target) continue;
    cost += (drawn.x - target.x) ** 2 + (drawn.y - target.y) ** 2;
  }
  return cost;
}

/** A repeatable shuffle, so a solve prints the same table twice. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 1_000_000) / 1_000_000;
  };
}

/**
 * Rounding to the grid, and the repair of what rounding breaks.
 *
 * The settled positions are real numbers, and a place half a step off the grid puts its corridors
 * at angles the plan does not draw. So each is rounded to the nearest cell, and the arrangement is
 * then annealed over whole cells: a place is picked, shifted a cell or two, and kept when the
 * drawing came out closer to the city or when the anneal is still warm enough to allow a step
 * backwards. Every remaining fault carries a weight nothing else can outbid, so a feasible
 * arrangement is always preferred to a prettier broken one -- and none is returned that still has
 * a fault at all.
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
    // Warm enough to climb out of what rounding did, never warm enough to forget the solve.
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

/** Which side of its dot a name can stand on: the one no corridor leaves in. */
function chooseLabelSide(
  id: string,
  layout: ReadonlyMap<string, Point>,
  edges: readonly Edge[],
): "left" | "right" | "above" | "below" {
  const point = layout.get(id);
  if (!point) return "below";
  const bearings = edges
    .filter((edge) => edge.from === id || edge.to === id)
    .flatMap((edge) => {
      const other = layout.get(edge.from === id ? edge.to : edge.from);
      return other ? [bearingOf(point, other)] : [];
    });
  const sides = [
    { side: "right", bearing: 0 },
    { side: "below", bearing: 90 },
    { side: "left", bearing: 180 },
    { side: "above", bearing: 270 },
  ] as const;
  const ranked = sides
    .map((side) => ({
      ...side,
      clearance: bearings.length
        ? Math.min(...bearings.map((bearing) => angleBetween(bearing, side.bearing)))
        : 180,
    }))
    // Above and below carry a name better than beside it does, so they win a tie.
    .sort((left, right) => right.clearance - left.clearance || left.bearing - right.bearing);
  return ranked[0].side;
}

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

  // Measured after the best-fit shift: a drawing placed elsewhere on the canvas is not distorted,
  // and comparing it to one that is would flatter whichever happened to be centred.
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

  // A stop nothing was observed at still has to be placed, or it returns from its closure into a
  // plan with no room left for it. The timetable's own catalogue says where it stands, which is
  // weaker evidence than a call the feed placed there and is the only evidence there is. It takes
  // no part in any corridor, so it is only ever pushed aside by the places that do.
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

  // The drawing that stands today, so the two sets of numbers can be set against each other.
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
      // Never shorter than two places may stand: a corridor cannot pull them closer than that.
      return [edgeKey(edge), Math.max(distance, MINIMUM_SEPARATION)] as const;
    }),
  );
  const settled = solvePositions(solvedIds, edges, geography, directions, lengths);
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

  // The table keeps the numbers the size they have always been: the drawing is shifted so its own
  // top left sits where the old one's did, which is a crop rather than a change of coordinates.
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
    console.log(
      `  { id: "${node.id}", label: "${label}", x: ${node.x}, y: ${node.y}, ` +
        `labelSide: "${node.labelSide}" },`,
    );
  }

  const catalogued = observations.nodes.filter((node) => node.samples === 0).map((node) => node.id);
  if (catalogued.length) {
    console.log(
      `\nPlaced from the timetable catalogue, nothing having been observed: ${catalogued.join(", ")}`,
    );
  }

  // A solved table is also something to look at rather than only to read, so it can be written out
  // for a drawing to be made of it and set beside the drawing it would replace.
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
