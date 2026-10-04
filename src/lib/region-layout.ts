/**
 * The region plan's layout: the Zentrum's stops where the Zentrum plan draws them, the other
 * junctions routed on an octilinear grid graph, and the places between junctions set along their
 * branch at their share of it. Distance from home shrinks by a `RegionScale`.
 */

export type Point = { x: number; y: number };
export type RegionLayoutEdge = { from: string; to: string; lineIds: readonly string[] };
export type RegionLayoutNode = { id: string; latitude: number; longitude: number };

export type RegionLayout = {
  /** In map units, the plan's origin at its top-left corner. */
  positions: ReadonlyMap<string, Point>;
  /** The bends an edge takes, in order from its `from`, by `regionEdgeKey`. */
  bends: ReadonlyMap<string, readonly Point[]>;
  viewBox: { x: number; y: number; width: number; height: number };
  /** What the solve could not avoid: a way along another, a link too short for its places. */
  faults: readonly string[];
  /** The drawing's total cost, faults aside: lower reads better. Compares solves of one network. */
  cost: number;
  /** Map units per compressed kilometre. */
  unitsPerKm: number;
};

export const regionEdgeKey = ({ from, to }: { from: string; to: string }): string =>
  `${from} ${to}`;

const bearingOf = (from: Point, to: Point): number =>
  ((Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI + 360) % 360;
const angleBetween = (left: number, right: number): number =>
  Math.abs(((left - right + 540) % 360) - 180);

/**
 * The axis, west to east, grown from both ends: each step takes the neighbour within 45° of straight
 * on whose stretch keeps at least half the lines of the given axis's stretch at that end.
 */
export function extendAxis(
  axis: readonly string[],
  edges: readonly RegionLayoutEdge[],
  geography: ReadonlyMap<string, Point>,
): string[] {
  const grown = [...axis];
  const lineIdsBetween = (left: string, right: string) =>
    edges.find(({ from, to }) => (from === left && to === right) || (from === right && to === left))
      ?.lineIds ?? [];
  const step = (end: string, heading: number, trunk: readonly string[]): string | undefined => {
    const at = geography.get(end);
    if (!at) return undefined;
    const candidates = edges
      .filter(({ from, to }) => from === end || to === end)
      .map((edge) => ({
        id: edge.from === end ? edge.to : edge.from,
        shared: edge.lineIds.filter((lineId) => trunk.includes(lineId)).length,
      }))
      .filter(({ id, shared }) => {
        const point = geography.get(id);
        return (
          !grown.includes(id) &&
          point !== undefined &&
          shared * 2 >= trunk.length &&
          angleBetween(bearingOf(at, point), heading) <= 45
        );
      })
      .sort((left, right) => right.shared - left.shared);
    return candidates[0]?.id;
  };
  const eastTrunk = lineIdsBetween(axis[axis.length - 2], axis[axis.length - 1]);
  const westTrunk = lineIdsBetween(axis[0], axis[1]);
  for (;;) {
    const next = step(grown[grown.length - 1], 0, eastTrunk);
    if (!next) break;
    grown.push(next);
  }
  for (;;) {
    const next = step(grown[0], 180, westTrunk);
    if (!next) break;
    grown.unshift(next);
  }
  return grown;
}

const segmentLengths = (path: readonly Point[]): number[] =>
  path.slice(1).map((point, index) => Math.hypot(point.x - path[index].x, point.y - path[index].y));

const lengthOf = (path: readonly Point[]): number =>
  segmentLengths(path).reduce((sum, length) => sum + length, 0);

/**
 * Distances along a way of `total` length at the given shares, each at least `gap` from the one
 * before and the last at least `gap` from the end, while the way is long enough for that.
 */
function spreadAlong(total: number, shares: readonly number[], gap: number): number[] {
  const room = Math.min(gap, total / (shares.length + 1));
  const along = shares.map((share) => share * total);
  for (let index = 0; index < along.length; index += 1) {
    along[index] = Math.max(along[index], (index === 0 ? 0 : along[index - 1]) + room);
  }
  for (let index = along.length - 1; index >= 0; index -= 1) {
    const limit = index === along.length - 1 ? total : along[index + 1];
    along[index] = Math.min(along[index], limit - room);
  }
  return along;
}

/** The point `distance` along a way. */
function pointAlong(path: readonly Point[], distance: number): Point {
  const lengths = segmentLengths(path);
  let left = distance;
  let segment = 0;
  while (segment < lengths.length - 1 && left > lengths[segment] + 1e-9) {
    left -= lengths[segment];
    segment += 1;
  }
  const share = lengths[segment] === 0 ? 0 : left / lengths[segment];
  const [from, to] = [path[segment], path[segment + 1]];
  return {
    x: Math.round((from.x + (to.x - from.x) * share) * 1e6) / 1e6,
    y: Math.round((from.y + (to.y - from.y) * share) * 1e6) / 1e6,
  };
}

/** Places along a way at their shares of its length, kept `gap` apart as `spreadAlong` does. */
export const placeAtShares = (
  path: readonly Point[],
  shares: readonly number[],
  gap: number,
): Point[] =>
  spreadAlong(lengthOf(path), shares, gap).map((distance) => pointAlong(path, distance));

/** A way's corners: its ends and every point where it turns. */
function cornersOf(path: readonly Point[]): Point[] {
  return path.filter((point, index) => {
    if (index === 0 || index === path.length - 1) return true;
    const [before, after] = [path[index - 1], path[index + 1]];
    return (
      (point.x - before.x) * (after.y - point.y) !== (point.y - before.y) * (after.x - point.x)
    );
  });
}

/** How the map shrinks with distance from its home: a smooth fisheye, or bands with their own scale. */
export type RegionScale =
  | { kind: "fisheye"; coreKm: number; falloffKm: number }
  | { kind: "zones"; zones: readonly { untilKm: number; factor: number }[] }
  /** Zones up to the city's edge; beyond it straight arms with places a fixed step apart. */
  | { kind: "arms"; zones: readonly { untilKm: number; factor: number }[] };

/**
 * A point's place on the map, in kilometres from home. A fisheye keeps the core true; beyond it the
 * scale falls ever faster, as (1 + x / `falloffKm`)^-1.5, so the whole region fits within
 * `coreKm + 2 × falloffKm`, with no step at the edge. Zones scale each band; past the last zone a
 * point stands on its edge, so only its direction is kept.
 */
export function compressRegion(point: Point, scale: RegionScale): Point {
  const distance = Math.hypot(point.x, point.y);
  let reach = distance;
  if (scale.kind === "fisheye") {
    if (distance > scale.coreKm) {
      const beyond = (distance - scale.coreKm) / scale.falloffKm;
      reach = scale.coreKm + 2 * scale.falloffKm * (1 - 1 / Math.sqrt(1 + beyond));
    }
  } else {
    reach = 0;
    let from = 0;
    for (const { untilKm, factor } of scale.zones) {
      reach += (Math.min(distance, untilKm) - from) * factor;
      if (distance <= untilKm) break;
      from = untilKm;
    }
  }
  const factor = distance === 0 ? 0 : reach / distance;
  return { x: point.x * factor, y: point.y * factor };
}

/** Kilometres east and south of a point, for bearings only. */
export const projectKm = (node: RegionLayoutNode, origin: RegionLayoutNode): Point => ({
  x: (node.longitude - origin.longitude) * 111.32 * Math.cos((origin.latitude * Math.PI) / 180),
  y: -(node.latitude - origin.latitude) * 110.574,
});
/** Branches whose next one clockwise differs from the ground's, by bearing; 0 when the order holds. */
export function countOrderBreaks<Key>(
  layout: ReadonlyMap<Key, number>,
  ground: ReadonlyMap<Key, number>,
): number {
  const successors = (bearings: ReadonlyMap<Key, number>) => {
    const ids = [...bearings.keys()].sort(
      (left, right) => (bearings.get(left) ?? 0) - (bearings.get(right) ?? 0),
    );
    return new Map(ids.map((id, index) => [id, ids[(index + 1) % ids.length]]));
  };
  const drawn = successors(layout);
  const real = successors(ground);
  return [...real].filter(([id, next]) => drawn.get(id) !== next).length;
}

/** A run between two junctions: its places, edges in order, and lines. */
type Chain = {
  from: string;
  to: string;
  interior: readonly string[];
  edges: readonly RegionLayoutEdge[];
  lineIds: readonly string[];
};

const sameSet = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value) => right.includes(value));

/** Junctions, ends, pins and the axis stay nodes of the solve; every other place rides a chain. */
function buildChains(
  nodeIds: readonly string[],
  edges: readonly RegionLayoutEdge[],
  fixed: ReadonlySet<string>,
): { skeleton: Set<string>; chains: Chain[] } {
  const incident = new Map<string, RegionLayoutEdge[]>();
  for (const edge of edges) {
    for (const id of [edge.from, edge.to]) incident.set(id, [...(incident.get(id) ?? []), edge]);
  }
  const skeleton = new Set(
    nodeIds.filter((id) => {
      const around = incident.get(id) ?? [];
      return fixed.has(id) || around.length !== 2 || !sameSet(around[0].lineIds, around[1].lineIds);
    }),
  );
  const chains: Chain[] = [];
  const walked = new Set<RegionLayoutEdge>();
  const walkFrom = (start: string) => {
    for (const first of incident.get(start) ?? []) {
      if (walked.has(first)) continue;
      const chainEdges = [first];
      const interior: string[] = [];
      walked.add(first);
      let current = first.from === start ? first.to : first.from;
      while (!skeleton.has(current)) {
        interior.push(current);
        const next = (incident.get(current) ?? []).find((edge) => !walked.has(edge));
        if (!next) break;
        walked.add(next);
        chainEdges.push(next);
        current = next.from === current ? next.to : next.from;
      }
      chains.push({
        from: start,
        to: current,
        interior,
        edges: chainEdges,
        lineIds: [...new Set(chainEdges.flatMap(({ lineIds }) => lineIds))],
      });
    }
  };
  for (const id of skeleton) walkFrom(id);
  // A loop of places alone: one of them stands as its junction.
  for (const edge of edges) {
    if (walked.has(edge)) continue;
    skeleton.add(edge.from);
    walkFrom(edge.from);
  }
  return { skeleton, chains };
}

/** The eight grid headings, clockwise from east, y pointing south. */
const HEADINGS: readonly Point[] = [
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
  { x: -1, y: 1 },
  { x: -1, y: 0 },
  { x: -1, y: -1 },
  { x: 0, y: -1 },
  { x: 1, y: -1 },
];
const START = 8;
/** 45° steps between two headings, 0 to 4. */
const turnSteps = (left: number, right: number): number => {
  const steps = Math.abs(left - right) % 8;
  return Math.min(steps, 8 - steps);
};
/** A line's price for a turn of so many 45° steps (octi): straight on is free. */
const TURN_PRICE = [0, 1, 1.5, 2, 3] as const;
const headingBetween = (from: Point, to: Point): number =>
  HEADINGS.findIndex(
    ({ x, y }) => x === Math.sign(to.x - from.x) && y === Math.sign(to.y - from.y),
  );

const COST = {
  step: 1,
  /** Per turn price and line. */
  bend: 3,
  /** Per cell a junction stands from where its geography puts it. */
  move: 1.5,
  /** A step beside a junction the way does not serve. */
  crowd: 3,
  /** A step along a way already drawn: a fault, allowed so a way is always found. */
  blocked: 1000,
  /** A way crossing another, straight through. */
  crossing: 40,
  /** Per branch around a junction that leaves in another turn than on the ground. */
  order: 25,
  /** A step inside the core by a link that does not serve it. */
  core: 30,
  /** Per cell² a link between junctions is too short for its places. */
  spring: 10,
} as const;
/** Cells between two places on an arm beyond the city's edge. */
const ARM_STEP = 2;
/** Cells of room kept around everything placed. */
const GRID_MARGIN = 3;
/** The least cells between two stops of the axis beyond the core, room for their names. */
const AXIS_GAP = 3;
/** Cells around its target a junction may stand in. */
const CANDIDATE_RADIUS = 4;
const LOCAL_SEARCH_ROUNDS = 12;

/**
 * The scale and offset that best carry kilometres onto cells for the given pairs (least squares,
 * no rotation): the region drawn at the core plan's scale.
 */
function fitToCells(pairs: readonly { km: Point; cell: Point }[]): {
  cellsPerKm: number;
  toCells: (km: Point) => Point;
} {
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const km = { x: mean(pairs.map(({ km }) => km.x)), y: mean(pairs.map(({ km }) => km.y)) };
  const cell = {
    x: mean(pairs.map(({ cell }) => cell.x)),
    y: mean(pairs.map(({ cell }) => cell.y)),
  };
  let spread = 0;
  let covariance = 0;
  for (const pair of pairs) {
    const [dx, dy] = [pair.km.x - km.x, pair.km.y - km.y];
    spread += dx ** 2 + dy ** 2;
    covariance += dx * (pair.cell.x - cell.x) + dy * (pair.cell.y - cell.y);
  }
  const cellsPerKm = spread > 0 ? covariance / spread : 1;
  return {
    cellsPerKm,
    toCells: (point) => ({
      x: cell.x + (point.x - km.x) * cellsPerKm,
      y: cell.y + (point.y - km.y) * cellsPerKm,
    }),
  };
}

/**
 * Lays the network out on an octilinear grid graph, after Bast, Brosi and Storandt's octi: places
 * between junctions are taken out and set back at their share of the way; links between junctions
 * are routed one by one, busiest first, around what is already drawn, paying for every turn; a local
 * search then moves junctions a cell at a time. The core's stops keep its plan's shape and fix the
 * scale; the axis keeps their row; `scale` shrinks the region with distance from `homeId`.
 */
export function solveRegionLayout({
  nodes,
  edges,
  core,
  axis,
  homeId,
  scale,
  grid,
  gap,
}: {
  nodes: readonly RegionLayoutNode[];
  edges: readonly RegionLayoutEdge[];
  /** An authored plan of the core, on a grid of `cell` units. */
  core: { cell: number; stops: readonly { id: string; x: number; y: number }[] };
  axis: readonly string[];
  homeId: string;
  scale: RegionScale;
  /** Map units per cell. */
  grid: number;
  /** The least cells between two places on a link. */
  gap: number;
}): RegionLayout {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const homeNode = nodeById.get(homeId) ?? nodes[0];
  const geography = new Map(nodes.map((node) => [node.id, projectKm(node, homeNode)]));
  const compressed = new Map(
    [...geography].map(([id, point]) => [id, compressRegion(point, scale)] as const),
  );
  // The core plan's stops stand on its own grid; the region is fitted to that scale.
  const pins = new Map(
    core.stops
      .filter(({ id }) => nodeById.has(id))
      .map(({ id, x, y }) => [id, { x: Math.round(x / core.cell), y: Math.round(y / core.cell) }]),
  );
  const fit = fitToCells(
    [...pins].map(([id, cell]) => ({ km: compressed.get(id) ?? { x: 0, y: 0 }, cell })),
  );
  /** Where the projection puts a stop, in cells. */
  const projected = (id: string): Point => fit.toCells(compressed.get(id) ?? { x: 0, y: 0 });
  const axisRow = axis.map((id) => pins.get(id)?.y).find((y) => y !== undefined) ?? 0;
  const onAxis = new Set(axis);
  const { skeleton, chains } = buildChains(
    nodes.map(({ id }) => id),
    edges,
    new Set([...pins.keys(), ...axis]),
  );
  const chainsAt = new Map<string, number[]>();
  for (const [index, chain] of chains.entries()) {
    for (const id of new Set([chain.from, chain.to])) {
      chainsAt.set(id, [...(chainsAt.get(id) ?? []), index]);
    }
  }
  // Beyond the city's edge, only the step count and direction of a stop count.
  const cityEdgeKm =
    scale.kind === "arms" ? (scale.zones[scale.zones.length - 1]?.untilKm ?? 0) : Infinity;
  const isOutside = (id: string) => {
    const point = geography.get(id) ?? { x: 0, y: 0 };
    return Math.hypot(point.x, point.y) > cityEdgeKm;
  };
  /** A step's cells: as projected inside the city, out to its edge and then a fixed arm step. */
  const stepCells = (from: string, to: string) => {
    if (isOutside(from) && isOutside(to)) return ARM_STEP;
    // Beyond the edge the projection stands a stop on the edge, so this reaches it.
    const [a, b] = [projected(from), projected(to)];
    const inside = Math.hypot(a.x - b.x, a.y - b.y);
    return isOutside(from) || isOutside(to) ? inside + ARM_STEP : inside;
  };
  const stopsOf = (chain: Chain) => [chain.from, ...chain.interior, chain.to];
  const armTargets = new Map<string, Point>();
  if (scale.kind === "arms") {
    const known = (id: string) =>
      pins.get(id) ?? armTargets.get(id) ?? (isOutside(id) ? undefined : projected(id));
    const queue = [...skeleton].filter((id) => known(id) !== undefined);
    while (queue.length > 0) {
      const id = queue.shift() as string;
      const start = known(id) as Point;
      for (const index of chainsAt.get(id) ?? []) {
        const chain = chains[index];
        const other = chain.from === id ? chain.to : chain.from;
        if (known(other) !== undefined) continue;
        const stops = chain.from === id ? stopsOf(chain) : stopsOf(chain).reverse();
        const length = stops
          .slice(1)
          .reduce((sum, stop, step) => sum + stepCells(stops[step], stop), 0);
        const [from, to] = [geography.get(id), geography.get(other)];
        const run = from && to ? Math.hypot(to.x - from.x, to.y - from.y) || 1 : 1;
        armTargets.set(other, {
          x: start.x + (from && to ? (to.x - from.x) / run : 1) * length,
          y: start.y + (from && to ? (to.y - from.y) / run : 0) * length,
        });
        queue.push(other);
      }
    }
  }
  /** Every line on a link pays for its turns, as at a node. */
  const lineWeight = (chain: Chain) => chain.lineIds.length;
  const neededLength = (chain: Chain) => (chain.interior.length + 1) * gap;

  // The grid: everything the projection places, and a margin around it.
  const everywhere = [
    ...pins.values(),
    ...[...skeleton].map((id) => armTargets.get(id) ?? projected(id)),
  ];
  const box = {
    left: Math.floor(Math.min(...everywhere.map(({ x }) => x))) - GRID_MARGIN,
    right: Math.ceil(Math.max(...everywhere.map(({ x }) => x))) + GRID_MARGIN,
    top: Math.floor(Math.min(...everywhere.map(({ y }) => y))) - GRID_MARGIN,
    bottom: Math.ceil(Math.max(...everywhere.map(({ y }) => y))) + GRID_MARGIN,
  };
  // Inside the core plan's box, only links between its stops run.
  const pinPoints = [...pins.values()];
  const coreBox = {
    left: Math.min(...pinPoints.map(({ x }) => x)),
    right: Math.max(...pinPoints.map(({ x }) => x)),
    top: Math.min(...pinPoints.map(({ y }) => y)),
    bottom: Math.max(...pinPoints.map(({ y }) => y)),
  };
  const isInCore = ({ x, y }: Point) =>
    x > coreBox.left && x < coreBox.right && y > coreBox.top && y < coreBox.bottom;
  const servesCore = (chain: Chain) => pins.has(chain.from) && pins.has(chain.to);
  const width = box.right - box.left + 1;
  const cellCount = width * (box.bottom - box.top + 1);
  const isInside = ({ x, y }: Point) =>
    x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
  const cellOf = ({ x, y }: Point) => x - box.left + (y - box.top) * width;
  const pointOf = (cell: number): Point => ({
    x: (cell % width) + box.left,
    y: Math.floor(cell / width) + box.top,
  });
  /** The shortest octilinear length between two cells. */
  const octile = (left: Point, right: Point) => {
    const [dx, dy] = [Math.abs(left.x - right.x), Math.abs(left.y - right.y)];
    return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
  };

  const targetOf = (id: string): Point => {
    const pinned = pins.get(id);
    if (pinned) return pinned;
    const point = armTargets.get(id) ?? projected(id);
    return { x: point.x, y: onAxis.has(id) ? axisRow : point.y };
  };

  // What is drawn: junctions on cells, and each chain's way through cells.
  const placed = new Map<string, number>();
  const stationAt = new Map<number, string>();
  const usedBy = new Int32Array(cellCount).fill(-1);
  const drawnSteps = new Map<string, number>();
  const ways = new Map<number, number[]>();
  const stepKey = (left: number, right: number) =>
    left < right ? `${left}:${right}` : `${right}:${left}`;
  const settle = (id: string, cell: number) => {
    placed.set(id, cell);
    stationAt.set(cell, id);
  };
  const unsettle = (id: string) => {
    const cell = placed.get(id);
    if (cell !== undefined) stationAt.delete(cell);
    placed.delete(id);
  };
  const draw = (index: number, cells: number[]) => {
    ways.set(index, cells);
    for (const cell of cells.slice(1, -1)) usedBy[cell] = index;
    for (let step = 1; step < cells.length; step += 1) {
      drawnSteps.set(stepKey(cells[step - 1], cells[step]), index);
    }
  };
  const erase = (index: number) => {
    const cells = ways.get(index);
    if (!cells) return;
    for (const cell of cells.slice(1, -1)) if (usedBy[cell] === index) usedBy[cell] = -1;
    for (let step = 1; step < cells.length; step += 1) {
      const key = stepKey(cells[step - 1], cells[step]);
      if (drawnSteps.get(key) === index) drawnSteps.delete(key);
    }
    ways.delete(index);
  };
  /** A step along a drawn way, across one, or clear of both. */
  const stepKind = (from: number, heading: number, index: number): "along" | "across" | "clear" => {
    const at = pointOf(from);
    const { x, y } = HEADINGS[heading];
    const to = cellOf({ x: at.x + x, y: at.y + y });
    const owner = drawnSteps.get(stepKey(from, to));
    if (owner !== undefined && owner !== index) return "along";
    if (usedBy[to] !== -1 && usedBy[to] !== index) return "across";
    if (x === 0 || y === 0) return "clear";
    const crossing = drawnSteps.get(
      stepKey(cellOf({ x: at.x + x, y: at.y }), cellOf({ x: at.x, y: at.y + y })),
    );
    return crossing !== undefined && crossing !== index ? "across" : "clear";
  };
  const stepPrice = (from: number, heading: number, index: number): number => {
    const kind = stepKind(from, heading, index);
    return kind === "along" ? COST.blocked : kind === "across" ? COST.crossing : 0;
  };
  const crowds = (cell: number, served: readonly string[]): boolean => {
    const at = pointOf(cell);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const near = { x: at.x + dx, y: at.y + dy };
        if (!isInside(near)) continue;
        const station = stationAt.get(cellOf(near));
        if (station && !served.includes(station)) return true;
      }
    }
    return false;
  };
  /** The heading a drawn chain leaves a node in. */
  const leavingAt = (index: number, id: string): number | undefined => {
    const cells = ways.get(index);
    if (!cells || cells.length < 2) return undefined;
    const chain = chains[index];
    const atStart = placed.get(id) === cells[0] && chain.from !== chain.to;
    const [from, to] = atStart
      ? [cells[0], cells[1]]
      : [cells[cells.length - 1], cells[cells.length - 2]];
    return headingBetween(pointOf(from), pointOf(to));
  };
  /** What a chain's lines pay to turn at a node against the chains already drawn there. */
  const nodeTurn = (id: string, index: number, leaving: number): number => {
    let price = 0;
    for (const lineId of chains[index].lineIds) {
      let best: number | undefined;
      for (const other of chainsAt.get(id) ?? []) {
        if (other === index || !chains[other].lineIds.includes(lineId)) continue;
        const otherLeaving = leavingAt(other, id);
        if (otherLeaving === undefined) continue;
        const turn = TURN_PRICE[4 - turnSteps(leaving, otherLeaving)];
        best = Math.min(best ?? Number.POSITIVE_INFINITY, turn);
      }
      price += best ?? 0;
    }
    return price * COST.bend;
  };

  /** The cheapest way from any source cell to any target cell (A*), what is drawn as obstacles. */
  const route = (
    index: number,
    from: { id: string; cells: Map<number, number> },
    to: { id: string; cells: Map<number, number>; settled: boolean },
  ): number[] => {
    const chain = chains[index];
    const served = [chain.from, chain.to];
    const targets = [...to.cells.keys()].map(pointOf);
    const estimate = (cell: number) => {
      const at = pointOf(cell);
      return Math.min(...targets.map((target) => octile(at, target))) * COST.step;
    };
    const states = cellCount * 9;
    const cost = new Float64Array(states).fill(Number.POSITIVE_INFINITY);
    const previous = new Int32Array(states).fill(-1);
    const heap: [number, number][] = [];
    const push = (priority: number, state: number) => {
      heap.push([priority, state]);
      let child = heap.length - 1;
      while (child > 0) {
        const parent = (child - 1) >> 1;
        if (heap[parent][0] <= heap[child][0]) break;
        [heap[parent], heap[child]] = [heap[child], heap[parent]];
        child = parent;
      }
    };
    const pop = (): [number, number] | undefined => {
      const top = heap[0];
      const last = heap.pop();
      if (heap.length > 0 && last) {
        heap[0] = last;
        let parent = 0;
        for (;;) {
          const [left, right] = [parent * 2 + 1, parent * 2 + 2];
          let smallest = parent;
          if (left < heap.length && heap[left][0] < heap[smallest][0]) smallest = left;
          if (right < heap.length && heap[right][0] < heap[smallest][0]) smallest = right;
          if (smallest === parent) break;
          [heap[parent], heap[smallest]] = [heap[smallest], heap[parent]];
          parent = smallest;
        }
      }
      return top;
    };
    for (const [cell, startCost] of from.cells) {
      cost[cell * 9 + START] = startCost;
      push(startCost + estimate(cell), cell * 9 + START);
    }
    let best = { cost: Number.POSITIVE_INFINITY, state: -1, cell: -1 };
    for (let entry = pop(); entry; entry = pop()) {
      const [priority, state] = entry;
      if (priority >= best.cost) break;
      const spent = cost[state];
      if (priority - estimate(Math.floor(state / 9)) > spent + 1e-9) continue;
      const cell = Math.floor(state / 9);
      const heading = state % 9;
      const at = pointOf(cell);
      for (let next = 0; next < 8; next += 1) {
        if (heading !== START && turnSteps(heading, next) === 4) continue;
        // A way crosses another straight through, never turning on it.
        if (
          heading !== START &&
          usedBy[cell] !== -1 &&
          usedBy[cell] !== index &&
          next !== heading
        ) {
          continue;
        }
        const nextPoint = { x: at.x + HEADINGS[next].x, y: at.y + HEADINGS[next].y };
        if (!isInside(nextPoint)) continue;
        const nextCell = cellOf(nextPoint);
        if (from.cells.has(nextCell)) continue;
        const station = stationAt.get(nextCell);
        const isTarget = to.cells.has(nextCell);
        if (station !== undefined && !(isTarget && to.settled)) continue;
        let price = COST.step * (next % 2 === 1 ? Math.SQRT2 : 1);
        price += stepPrice(cell, next, index);
        if (!isTarget && crowds(nextCell, served)) price += COST.crowd;
        if (!servesCore(chain) && isInCore(nextPoint)) price += COST.core;
        price +=
          heading === START
            ? placed.has(from.id)
              ? nodeTurn(from.id, index, next)
              : 0
            : TURN_PRICE[turnSteps(heading, next)] * COST.bend * lineWeight(chain);
        const reached = spent + price;
        const nextState = nextCell * 9 + next;
        if (isTarget) {
          const arrival =
            reached +
            (to.cells.get(nextCell) ?? 0) +
            (to.settled ? nodeTurn(to.id, index, (next + 4) % 8) : 0);
          if (arrival < best.cost) {
            best = { cost: arrival, state, cell: nextCell };
          }
          continue;
        }
        if (reached < cost[nextState]) {
          cost[nextState] = reached;
          previous[nextState] = state;
          push(reached + estimate(nextCell), nextState);
        }
      }
    }
    if (best.state < 0) return [];
    const cells = [best.cell];
    for (let state = best.state; state >= 0; state = previous[state]) {
      cells.push(Math.floor(state / 9));
    }
    return cells.reverse();
  };

  /** Free cells for an unplaced junction, priced by how far they stand from where it belongs. */
  const candidatesFor = (id: string, from: Point | undefined, chain: Chain) => {
    let target = targetOf(id);
    const needed = chain.interior.length > 0 ? neededLength(chain) : 0;
    if (from && Math.hypot(target.x - from.x, target.y - from.y) < needed) {
      const away = Math.hypot(target.x - from.x, target.y - from.y) || 1;
      target = {
        x: from.x + ((target.x - from.x) / away) * needed,
        y: onAxis.has(id) ? axisRow : from.y + ((target.y - from.y) / away) * needed,
      };
    }
    for (let radius = CANDIDATE_RADIUS; radius <= 64; radius *= 2) {
      const cells = new Map<number, number>();
      for (let dx = -radius; dx <= radius; dx += 1) {
        for (let dy = onAxis.has(id) ? 0 : -radius; dy <= (onAxis.has(id) ? 0 : radius); dy += 1) {
          const point = {
            x: Math.round(target.x) + dx,
            y: onAxis.has(id) ? axisRow : Math.round(target.y) + dy,
          };
          if (!isInside(point)) continue;
          const cell = cellOf(point);
          if (stationAt.has(cell) || usedBy[cell] !== -1 || crowds(cell, [])) continue;
          if (from && Math.hypot(point.x - from.x, point.y - from.y) < needed - 0.5) continue;
          cells.set(cell, COST.move * Math.hypot(point.x - target.x, point.y - target.y));
        }
      }
      if (cells.size > 0) return cells;
    }
    return new Map([[cellOf({ x: Math.round(target.x), y: Math.round(target.y) }), 0]]);
  };

  /** Draws one chain from its placed end, placing the other. */
  const lay = (index: number) => {
    const chain = chains[index];
    if (chain.from === chain.to) return;
    const [from, to] = placed.has(chain.from) ? [chain.from, chain.to] : [chain.to, chain.from];
    if (!placed.has(from)) {
      const target = targetOf(from);
      const [cell] = candidatesFor(from, undefined, chain).keys();
      settle(from, cell ?? cellOf({ x: Math.round(target.x), y: Math.round(target.y) }));
    }
    const fromPoint = pointOf(placed.get(from) as number);
    const toCells = placed.has(to)
      ? new Map([[placed.get(to) as number, 0]])
      : candidatesFor(to, fromPoint, chain);
    let cells = route(
      index,
      { id: from, cells: new Map([[placed.get(from) as number, 0]]) },
      { id: to, cells: toCells, settled: placed.has(to) },
    );
    if (cells.length === 0) cells = [placed.get(from) as number, [...toCells.keys()][0]];
    if (!placed.has(to)) settle(to, cells[cells.length - 1]);
    if (placed.get(chain.from) !== cells[0]) cells.reverse();
    draw(index, cells);
  };

  // Busiest first, outward from the pins (octi's ordering).
  for (const [id, cell] of pins) settle(id, cellOf(cell));
  // The axis beyond the pins: on their row, in order, where geography puts it but never crowded.
  const pinnedAt = axis.flatMap((id, index) => (pins.has(id) ? [index] : []));
  if (pinnedAt.length > 0) {
    for (const [first, last, direction] of [
      [pinnedAt[pinnedAt.length - 1], axis.length, 1],
      [pinnedAt[0], -1, -1],
    ] as const) {
      let previous = pins.get(axis[first])?.x ?? 0;
      for (let index = first + direction; index !== last; index += direction) {
        const wanted = Math.round(targetOf(axis[index]).x);
        const x =
          direction === 1
            ? Math.max(wanted, previous + AXIS_GAP)
            : Math.min(wanted, previous - AXIS_GAP);
        settle(axis[index], cellOf({ x, y: axisRow }));
        previous = x;
      }
    }
  }
  const lineDegree = (id: string) =>
    (chainsAt.get(id) ?? []).reduce((sum, index) => sum + chains[index].lineIds.length, 0);
  const order: number[] = [];
  const reached = new Set<string>(pins.keys());
  const queue = [...pins.keys()];
  const ordered = new Set<number>();
  const visit = () => {
    while (queue.length > 0) {
      queue.sort((left, right) => lineDegree(right) - lineDegree(left));
      const id = queue.shift() as string;
      const around = [...(chainsAt.get(id) ?? [])].sort(
        (left, right) => chains[right].lineIds.length - chains[left].lineIds.length,
      );
      for (const index of around) {
        if (ordered.has(index)) continue;
        ordered.add(index);
        order.push(index);
        for (const other of [chains[index].from, chains[index].to]) {
          if (reached.has(other)) continue;
          reached.add(other);
          queue.push(other);
        }
      }
    }
  };
  visit();
  for (const id of skeleton) {
    if (reached.has(id)) continue;
    reached.add(id);
    queue.push(id);
    visit();
  }
  for (const index of order) lay(index);

  /** The drawing's cost: lengths, turns, crowding, faults, strays from geography, order breaks. */
  const score = (): number => {
    let total = 0;
    for (const [index, cells] of ways) {
      const chain = chains[index];
      const points = cells.map(pointOf);
      for (let step = 1; step < cells.length; step += 1) {
        const heading = headingBetween(points[step - 1], points[step]);
        total += COST.step * (heading % 2 === 1 ? Math.SQRT2 : 1);
        total += stepPrice(cells[step - 1], heading, index);
        if (step > 1) {
          const turn = turnSteps(headingBetween(points[step - 2], points[step - 1]), heading);
          total += TURN_PRICE[turn] * COST.bend * lineWeight(chain);
        }
      }
      for (const point of points) if (!servesCore(chain) && isInCore(point)) total += COST.core;
      const short = neededLength(chain) - lengthOf(points);
      if (chain.interior.length > 0 && short > 0.5) total += COST.spring * short ** 2;
    }
    for (const [id, cell] of placed) {
      if (pins.has(id)) continue;
      const point = pointOf(cell);
      const target = targetOf(id);
      total += COST.move * Math.hypot(point.x - target.x, point.y - target.y);
      const around = chainsAt.get(id) ?? [];
      for (const index of around) {
        const leaving = leavingAt(index, id);
        if (leaving !== undefined) total += nodeTurn(id, index, leaving) / 2;
      }
      if (around.length > 2) {
        const drawn = new Map<number, number>();
        const ground = new Map<number, number>();
        for (const index of around) {
          const leaving = leavingAt(index, id);
          const chain = chains[index];
          const other = chain.from === id ? chain.to : chain.from;
          if (leaving === undefined) continue;
          drawn.set(index, leaving * 45);
          ground.set(
            index,
            bearingOf(geography.get(id) ?? { x: 0, y: 0 }, geography.get(other) ?? { x: 0, y: 0 }),
          );
        }
        total += COST.order * countOrderBreaks(drawn, ground);
      }
    }
    return total;
  };

  // Local search: each junction tries its eight neighbouring cells, its chains drawn again.
  const movable = [...skeleton].filter((id) => !pins.has(id) && !onAxis.has(id) && placed.has(id));
  const relay = (id: string, cell: number) => {
    const around = chainsAt.get(id) ?? [];
    for (const index of around) erase(index);
    unsettle(id);
    settle(id, cell);
    const sorted = [...around].sort(
      (left, right) => chains[right].lineIds.length - chains[left].lineIds.length,
    );
    for (const index of sorted) lay(index);
  };
  let current = score();
  for (let round = 0; round < LOCAL_SEARCH_ROUNDS; round += 1) {
    let improved = false;
    for (const id of movable) {
      const home = placed.get(id) as number;
      const at = pointOf(home);
      let best = { cell: home, score: current };
      for (const heading of onAxis.has(id) ? [0, 4] : [0, 1, 2, 3, 4, 5, 6, 7]) {
        const next = { x: at.x + HEADINGS[heading].x, y: at.y + HEADINGS[heading].y };
        if (!isInside(next)) continue;
        const cell = cellOf(next);
        const ownWay = (chainsAt.get(id) ?? []).includes(usedBy[cell]);
        if (stationAt.has(cell) || (usedBy[cell] !== -1 && !ownWay)) continue;
        relay(id, cell);
        const tried = score();
        if (tried < best.score - 1e-6) best = { cell, score: tried };
      }
      relay(id, best.cell);
      if (best.cell !== home) {
        current = score();
        improved = true;
      }
    }
    if (!improved) break;
  }

  // Into the plan: places at their projected share of their chain, cells into map units.
  const cells = new Map<string, Point>();
  for (const [id, cell] of placed) cells.set(id, pointOf(cell));
  const shapes = new Map<number, { corners: Point[]; along: number[] }>();
  for (const [index, way] of ways) {
    const chain = chains[index];
    const corners = cornersOf(way.map(pointOf));
    const stops = stopsOf(chain);
    const reach = stops.slice(1).map((stop, step) => stepCells(stops[step], stop));
    const whole = reach.reduce((sum, length) => sum + length, 0) || 1;
    let walked = 0;
    const shares = chain.interior.map((_, place) => {
      walked += reach[place];
      return walked / whole;
    });
    const along = spreadAlong(lengthOf(corners), shares, gap);
    shapes.set(index, { corners, along });
    for (const [place, id] of chain.interior.entries()) {
      cells.set(id, pointAlong(corners, along[place]));
    }
  }
  const faults: string[] = [];
  for (const [index, way] of ways) {
    const points = way.map(pointOf);
    for (let step = 1; step < way.length; step += 1) {
      const heading = headingBetween(points[step - 1], points[step]);
      if (stepKind(way[step - 1], heading, index) === "along") {
        faults.push(`${chains[index].from}–${chains[index].to} along another way`);
        break;
      }
    }
    const chain = chains[index];
    if (chain.interior.length > 0 && neededLength(chain) - lengthOf(points) > 0.5) {
      faults.push(`${chain.from}–${chain.to} too short for its places`);
    }
  }
  const margin = 2;
  const xs = [...cells.values()].map(({ x }) => x);
  const ys = [...cells.values()].map(({ y }) => y);
  const shift = { x: margin - Math.min(...xs), y: margin - Math.min(...ys) };
  const toUnits = (point: Point): Point => ({
    x: Math.round((point.x + shift.x) * grid * 100) / 100,
    y: Math.round((point.y + shift.y) * grid * 100) / 100,
  });
  // Each bend belongs to the edge between the two places it falls between.
  const bends = new Map<string, Point[]>();
  for (const [index, { corners, along }] of shapes) {
    const chain = chains[index];
    const sequence = [chain.from, ...chain.interior];
    const legs = segmentLengths(corners);
    let bendAt = 0;
    for (let corner = 1; corner < corners.length - 1; corner += 1) {
      bendAt += legs[corner - 1];
      if (along.some((distance) => Math.abs(distance - bendAt) < 1e-6)) continue;
      const place = along.filter((distance) => distance < bendAt).length;
      const edge = chain.edges[place];
      const forward = edge.from === sequence[place];
      const known = bends.get(regionEdgeKey(edge)) ?? [];
      const point = toUnits(corners[corner]);
      bends.set(regionEdgeKey(edge), forward ? [...known, point] : [point, ...known]);
    }
  }
  return {
    positions: new Map([...cells].map(([id, point]) => [id, toUnits(point)])),
    bends,
    viewBox: {
      x: 0,
      y: 0,
      width: (Math.max(...xs) - Math.min(...xs) + 2 * margin) * grid,
      height: (Math.max(...ys) - Math.min(...ys) + 2 * margin) * grid,
    },
    faults,
    cost: Math.round(current % COST.blocked),
    unitsPerKm: fit.cellsPerKm * grid,
  };
}
