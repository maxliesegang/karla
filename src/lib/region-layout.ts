/**
 * The region plan's layout: the Zentrum's stops pinned where the Zentrum plan draws them, the other
 * junctions annealed on an octilinear grid, and the places between junctions spaced evenly along
 * their branch. Kilometres set only a branch's direction, never its length.
 */

export type Point = { x: number; y: number };
export type RegionLayoutEdge = { from: string; to: string; lineIds: readonly string[] };
export type RegionLayoutNode = { id: string; latitude: number; longitude: number };

export type RegionLayout = {
  /** In map units, the plan's origin at its top-left corner. */
  positions: ReadonlyMap<string, Point>;
  /** The one bend an edge takes, by `regionEdgeKey`. */
  bends: ReadonlyMap<string, Point>;
  viewBox: { x: number; y: number; width: number; height: number };
  /** What the solve could not avoid: crowded dots, a way over a dot, two ways on one stretch. */
  faults: readonly string[];
  /** The drawing's total cost, faults aside: lower reads better. Compares solves of one network. */
  cost: number;
};

export const regionEdgeKey = ({ from, to }: { from: string; to: string }): string =>
  `${from} ${to}`;

/** The Zentrum's stops the region draws too, in Zentrum grid cells. */
export function getZentrumPins(
  nodeIds: readonly string[],
  zentrumNodes: readonly { id: string; x: number; y: number }[],
  zentrumGrid: number,
): Map<string, Point> {
  const wanted = new Set(nodeIds);
  return new Map(
    zentrumNodes
      .filter(({ id }) => wanted.has(id))
      .map(({ id, x, y }) => [
        id,
        { x: Math.round(x / zentrumGrid), y: Math.round(y / zentrumGrid) },
      ]),
  );
}

const bearingOf = (from: Point, to: Point): number =>
  ((Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI + 360) % 360;
const angleBetween = (left: number, right: number): number =>
  Math.abs(((left - right + 540) % 360) - 180);
const unitOf = (degrees: number): Point => ({
  x: Math.round(Math.cos((degrees * Math.PI) / 180) * 1e9) / 1e9,
  y: Math.round(Math.sin((degrees * Math.PI) / 180) * 1e9) / 1e9,
});

/**
 * The axis, west to east, grown from both ends: each step takes the neighbour that carries most of
 * the last stretch's lines (at least half), lies within 45° of straight on, and is in the home
 * place.
 */
export function extendAxis(
  axis: readonly string[],
  edges: readonly RegionLayoutEdge[],
  geography: ReadonlyMap<string, Point>,
  isHome: (id: string) => boolean,
): string[] {
  const grown = [...axis];
  const lineIdsBetween = (left: string, right: string) =>
    edges.find(({ from, to }) => (from === left && to === right) || (from === right && to === left))
      ?.lineIds ?? [];
  const step = (end: string, previous: string, heading: number): string | undefined => {
    const lineIds = lineIdsBetween(previous, end);
    const at = geography.get(end);
    if (!at) return undefined;
    const candidates = edges
      .filter(({ from, to }) => from === end || to === end)
      .map((edge) => ({
        id: edge.from === end ? edge.to : edge.from,
        shared: edge.lineIds.filter((lineId) => lineIds.includes(lineId)).length,
      }))
      .filter(({ id, shared }) => {
        const point = geography.get(id);
        return (
          !grown.includes(id) &&
          isHome(id) &&
          point !== undefined &&
          shared * 2 >= lineIds.length &&
          angleBetween(bearingOf(at, point), heading) <= 45
        );
      })
      .sort((left, right) => right.shared - left.shared);
    return candidates[0]?.id;
  };
  for (;;) {
    const next = step(grown[grown.length - 1], grown[grown.length - 2], 0);
    if (!next) break;
    grown.push(next);
  }
  for (;;) {
    const next = step(grown[0], grown[1], 180);
    if (!next) break;
    grown.unshift(next);
  }
  return grown;
}

/** A way's length as its places use it: on the level, names stand side by side and need twice the room. */
const readingLengths = (path: readonly Point[]): number[] =>
  path.slice(1).map((point, index) => {
    const length = Math.hypot(point.x - path[index].x, point.y - path[index].y);
    return point.y === path[index].y ? length / 2 : length;
  });
const readingLength = (path: readonly Point[]): number =>
  readingLengths(path).reduce((sum, length) => sum + length, 0);

/** Grid steps along `unit` that make `length` of reading length. */
const cellsFor = (unit: Point, length: number): number =>
  unit.y === 0 ? length * 2 : unit.x !== 0 ? length / Math.SQRT2 : length;

/** `count` points at equal reading steps along a way, its ends left out. */
export function placeEvenly(path: readonly Point[], count: number): Point[] {
  const lengths = readingLengths(path);
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const points: Point[] = [];
  for (let index = 1; index <= count; index += 1) {
    let along = (total * index) / (count + 1);
    let segment = 0;
    while (segment < lengths.length - 1 && along > lengths[segment] + 1e-9) {
      along -= lengths[segment];
      segment += 1;
    }
    const share = lengths[segment] === 0 ? 0 : along / lengths[segment];
    const [from, to] = [path[segment], path[segment + 1]];
    points.push({
      x: Math.round((from.x + (to.x - from.x) * share) * 1e6) / 1e6,
      y: Math.round((from.y + (to.y - from.y) * share) * 1e6) / 1e6,
    });
  }
  return points;
}

/** Kilometres east and south of a point, for bearings only. */
export const projectKm = (node: RegionLayoutNode, origin: RegionLayoutNode): Point => ({
  x: (node.longitude - origin.longitude) * 111.32 * Math.cos((origin.latitude * Math.PI) / 180),
  y: -(node.latitude - origin.latitude) * 110.574,
});

/** The octilinear ways between two grid points with at most one bend. */
function getPathOptions(from: Point, to: Point): Point[][] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy)) return [[from, to]];
  const run = Math.min(Math.abs(dx), Math.abs(dy));
  const bends = [
    { x: from.x + Math.sign(dx) * run, y: from.y + Math.sign(dy) * run },
    { x: to.x - Math.sign(dx) * run, y: to.y - Math.sign(dy) * run },
    { x: to.x, y: from.y },
    { x: from.x, y: to.y },
  ];
  // Two diagonals meet on the grid when the run is even.
  if ((dx + dy) % 2 === 0) {
    bends.push(
      { x: from.x + (dx + dy) / 2, y: from.y + (dx + dy) / 2 },
      { x: from.x + (dx - dy) / 2, y: from.y - (dx - dy) / 2 },
    );
  }
  return bends.map((bend) => [from, bend, to]);
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

const cross = (p: Point, q: Point, r: Point) =>
  (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);

const segmentsCross = (a: Point, b: Point, c: Point, d: Point): boolean =>
  Math.sign(cross(a, b, c)) * Math.sign(cross(a, b, d)) < 0 &&
  Math.sign(cross(c, d, a)) * Math.sign(cross(c, d, b)) < 0;

/** Two segments on one line for some length: two ways drawn as one. */
function segmentsOverlap(a: Point, b: Point, c: Point, d: Point): boolean {
  if (Math.abs(cross(a, b, c)) > 1e-9 || Math.abs(cross(a, b, d)) > 1e-9) return false;
  const axis = Math.abs(a.x - b.x) > 1e-9 ? "x" : "y";
  const [low, high] = [Math.min(a[axis], b[axis]), Math.max(a[axis], b[axis])];
  const [otherLow, otherHigh] = [Math.min(c[axis], d[axis]), Math.max(c[axis], d[axis])];
  return Math.min(high, otherHigh) - Math.max(low, otherLow) > 1e-9;
}

/** A line's cost for turning by `turn` degrees: straight on is free, a hairpin dearest (octi). */
const turnCost = (turn: number): number =>
  turn < 1 ? 0 : turn <= 46 ? 1 : turn <= 91 ? 1.5 : turn <= 136 ? 2 : 3;

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

const WEIGHT = {
  fault: 1e6,
  /** Per (45°)² that a chain's chord strays from its geographic bearing. */
  direction: 10,
  /** Per line, per octi turn unit. */
  bend: 6,
  /** Per cell² a chain's length strays from its places' even spacing. */
  length: 4,
  /** Per branch around a junction that leaves in another turn than on the ground. */
  order: 60,
  /** Per (45°)² that a junction's bearing from home strays from its geographic one. */
  topography: 6,
  crossing: 80,
  /** Per cell² outside the frame. */
  frame: 30,
} as const;
/** In cells: dots closer than this crowd; a way closer to a foreign dot passes over it. */
const SEPARATION = 1.5;
const CLEARANCE = 0.75;

type ChainShape = { path: Point[]; dots: Point[]; length: number };

/**
 * Lays the network out. `pins` are in grid cells, `frame` the cells the plan may reach beyond them;
 * `spacing` is the step between places
 * on a branch, in cells. The axis's nodes keep the pinned row.
 */
export function solveRegionLayout({
  nodes,
  edges,
  pins,
  axis,
  homeId,
  grid,
  spacing,
  frame,
  seed,
  steps = 400_000,
}: {
  nodes: readonly RegionLayoutNode[];
  edges: readonly RegionLayoutEdge[];
  pins: ReadonlyMap<string, Point>;
  axis: readonly string[];
  homeId: string;
  grid: number;
  spacing: number;
  frame: { x: number; y: number };
  seed: number;
  steps?: number;
}): RegionLayout {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const homeNode = nodeById.get(homeId) ?? nodes[0];
  const geography = new Map(nodes.map((node) => [node.id, projectKm(node, homeNode)]));
  const axisRow = axis.map((id) => pins.get(id)?.y).find((y) => y !== undefined) ?? 0;
  const fixed = new Set([...pins.keys(), ...axis]);
  const { skeleton, chains } = buildChains(
    nodes.map(({ id }) => id),
    edges,
    fixed,
  );
  const skeletonIds = [...skeleton];
  const chainsAt = new Map<string, Chain[]>(skeletonIds.map((id) => [id, []]));
  for (const chain of chains) {
    chainsAt.get(chain.from)?.push(chain);
    if (chain.to !== chain.from) chainsAt.get(chain.to)?.push(chain);
  }
  const desiredLength = (chain: Chain) => (chain.interior.length + 1) * spacing;

  // Start: pins and the axis where they belong, the rest grown outward along geographic bearings.
  const layout = new Map<string, Point>(pins);
  const homeCell = pins.get(homeId) ?? { x: 0, y: 0 };
  for (const id of axis) {
    if (layout.has(id)) continue;
    const point = geography.get(id) ?? { x: 0, y: 0 };
    const pinned = [...axis].filter((other) => pins.has(other));
    const nearest = pinned.reduce((best, other) =>
      Math.abs((geography.get(other)?.x ?? 0) - point.x) <
      Math.abs((geography.get(best)?.x ?? 0) - point.x)
        ? other
        : best,
    );
    const offset = axis.indexOf(id) - axis.indexOf(nearest);
    layout.set(id, {
      x: (pins.get(nearest)?.x ?? 0) + offset * spacing * 2,
      y: axisRow,
    });
  }
  const queue = [...layout.keys()];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    const from = layout.get(id) as Point;
    for (const chain of chainsAt.get(id) ?? []) {
      const other = chain.from === id ? chain.to : chain.from;
      if (layout.has(other)) continue;
      const bearing = bearingOf(
        geography.get(id) ?? { x: 0, y: 0 },
        geography.get(other) ?? { x: 0, y: 0 },
      );
      const unit = unitOf(Math.round(bearing / 45) * 45);
      const length = cellsFor(unit, desiredLength(chain));
      layout.set(other, {
        x: from.x + Math.round(unit.x * length),
        y: from.y + Math.round(unit.y * length),
      });
      queue.push(other);
    }
  }
  for (const id of skeletonIds) {
    if (!layout.has(id)) {
      const point = geography.get(id) ?? { x: 0, y: 0 };
      layout.set(id, { x: Math.round(point.x), y: Math.round(point.y) });
    }
  }

  // Each junction's nodes beyond it, seen from the fixed core: they move with it.
  const beyond = new Map<string, string[]>();
  for (const id of skeletonIds) {
    if (fixed.has(id)) continue;
    const reached = new Set<string>([...fixed].filter((other) => other !== id));
    const stack = [...reached];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      for (const chain of chainsAt.get(current) ?? []) {
        const other = chain.from === current ? chain.to : chain.from;
        if (other === id || reached.has(other)) continue;
        reached.add(other);
        stack.push(other);
      }
    }
    beyond.set(
      id,
      skeletonIds.filter((other) => other === id || !reached.has(other)),
    );
  }

  const minimumDistance = (point: Point, path: readonly Point[]): number => {
    let best = Number.POSITIVE_INFINITY;
    for (let index = 1; index < path.length; index += 1) {
      best = Math.min(best, distanceToSegment(point, path[index - 1], path[index]));
    }
    return best;
  };
  const shapes = new Map<Chain, ChainShape>();
  /** A chain not shaped yet reads as its first way, so shaping one never waits on another. */
  const shapeOf = (chain: Chain): ChainShape => {
    const known = shapes.get(chain);
    if (known) return known;
    const [path] = getPathOptions(
      layout.get(chain.from) ?? { x: 0, y: 0 },
      layout.get(chain.to) ?? { x: 0, y: 0 },
    );
    return {
      path,
      dots: placeEvenly(path, chain.interior.length),
      length: readingLength(path),
    };
  };
  const leavingBearing = (chain: Chain, id: string, path: readonly Point[]): number =>
    chain.from === id
      ? bearingOf(path[0], path[1])
      : bearingOf(path[path.length - 1], path[path.length - 2]);

  /** What each of the chain's lines pays to turn at a node, against the other chains there. */
  const turnsAt = (id: string, chain: Chain, path: readonly Point[]): number => {
    let cost = 0;
    const leaving = leavingBearing(chain, id, path);
    for (const lineId of chain.lineIds) {
      let best: number | undefined;
      for (const other of chainsAt.get(id) ?? []) {
        if (other === chain || !other.lineIds.includes(lineId)) continue;
        const turn = 180 - angleBetween(leaving, leavingBearing(other, id, shapeOf(other).path));
        best = Math.min(best ?? Number.POSITIVE_INFINITY, turnCost(turn));
      }
      cost += best ?? 0;
    }
    return cost;
  };

  /** The node's order breaks: chains drawn as they leave, on the ground towards their far end. */
  const orderBreaksAt = (id: string): number => {
    const drawn = new Map<Chain, number>();
    const ground = new Map<Chain, number>();
    for (const chain of chainsAt.get(id) ?? []) {
      if (chain.from === chain.to) continue;
      const other = chain.from === id ? chain.to : chain.from;
      drawn.set(chain, leavingBearing(chain, id, shapeOf(chain).path));
      ground.set(
        chain,
        bearingOf(geography.get(id) ?? { x: 0, y: 0 }, geography.get(other) ?? { x: 0, y: 0 }),
      );
    }
    return countOrderBreaks(drawn, ground);
  };

  const ownCost = (chain: Chain, path: readonly Point[], length: number): number => {
    const from = path[0];
    const to = path[path.length - 1];
    if (from.x === to.x && from.y === to.y) return WEIGHT.fault;
    const geoBearing = bearingOf(geography.get(chain.from) ?? from, geography.get(chain.to) ?? to);
    let cost = WEIGHT.direction * (angleBetween(bearingOf(from, to), geoBearing) / 45) ** 2;
    if (path.length > 2) {
      const turn = angleBetween(bearingOf(path[0], path[1]), bearingOf(path[1], path[2]));
      cost += WEIGHT.bend * chain.lineIds.length * turnCost(turn);
    }
    const lengthWeight = chain.interior.length > 0 ? WEIGHT.length : WEIGHT.length / 4;
    cost += lengthWeight * (length - desiredLength(chain)) ** 2;
    return cost;
  };

  function shapeChain(chain: Chain): ChainShape {
    const from = layout.get(chain.from) ?? { x: 0, y: 0 };
    const to = layout.get(chain.to) ?? { x: 0, y: 0 };
    const options = getPathOptions(from, to).map((path) => {
      const length = readingLength(path);
      const passed = skeletonIds.filter((id) => {
        if (id === chain.from || id === chain.to) return false;
        const point = layout.get(id);
        return point !== undefined && minimumDistance(point, path) < CLEARANCE;
      }).length;
      const score =
        passed * WEIGHT.fault +
        ownCost(chain, path, length) +
        WEIGHT.bend * (turnsAt(chain.from, chain, path) + turnsAt(chain.to, chain, path));
      return { path, length, score };
    });
    options.sort((left, right) => left.score - right.score);
    const { path, length } = options[0];
    return { path, length, dots: placeEvenly(path, chain.interior.length) };
  }
  const reshape = (ids: Iterable<string>) => {
    const touched = new Set<Chain>();
    for (const id of ids) for (const chain of chainsAt.get(id) ?? []) touched.add(chain);
    for (const chain of touched) shapes.set(chain, shapeChain(chain));
  };
  for (const chain of chains) shapes.set(chain, shapeChain(chain));
  reshape(skeletonIds);

  const pairTerms = (left: readonly Point[], right: readonly Point[]) => {
    let crossings = 0;
    let overlaps = 0;
    for (let i = 1; i < left.length; i += 1) {
      for (let j = 1; j < right.length; j += 1) {
        if (segmentsCross(left[i - 1], left[i], right[j - 1], right[j])) crossings += 1;
        if (segmentsOverlap(left[i - 1], left[i], right[j - 1], right[j])) overlaps += 1;
      }
    }
    return { crossings, overlaps };
  };
  const pinXs = [...pins.values()].map(({ x }) => x);
  const pinYs = [...pins.values()].map(({ y }) => y);
  const bounds = {
    left: Math.min(...pinXs) - frame.x,
    right: Math.max(...pinXs) + frame.x,
    top: Math.min(...pinYs) - frame.y,
    bottom: Math.max(...pinYs) + frame.y,
  };
  const frameExcess = (point: Point): number =>
    Math.max(0, bounds.left - point.x, point.x - bounds.right) +
    Math.max(0, bounds.top - point.y, point.y - bounds.bottom);

  type Dot = { point: Point; id: string; nodeId?: string; chain?: Chain };
  const dotsOf = (moved: ReadonlySet<string>, chainSet: ReadonlySet<Chain>): Dot[] => [
    ...[...moved].map((id) => ({ point: layout.get(id) as Point, id, nodeId: id })),
    ...[...chainSet].flatMap((chain) =>
      shapeOf(chain).dots.map((point, index) => ({ point, id: chain.interior[index], chain })),
    ),
  ];
  const allDots = (): Dot[] => dotsOf(new Set(skeletonIds), new Set(chains));
  const belongsTo = (dot: Dot, chain: Chain) =>
    dot.chain === chain || dot.nodeId === chain.from || dot.nodeId === chain.to;

  /** Every term that changes when `moved` move, with the faults counted apart. */
  const scoreAround = (moved: ReadonlySet<string>, describe?: string[]): number => {
    const touched = new Set<Chain>();
    for (const id of moved) for (const chain of chainsAt.get(id) ?? []) touched.add(chain);
    let cost = 0;
    const ends = new Set<string>();
    for (const chain of touched) {
      const shape = shapeOf(chain);
      cost += ownCost(chain, shape.path, shape.length);
      ends.add(chain.from);
      ends.add(chain.to);
    }
    for (const id of ends) {
      const around = chainsAt.get(id) ?? [];
      for (const chain of around) {
        cost += WEIGHT.bend * turnsAt(id, chain, shapeOf(chain).path);
      }
      if (around.length > 2) cost += WEIGHT.order * orderBreaksAt(id);
    }

    const touchedList = [...touched];
    for (const [index, chain] of touchedList.entries()) {
      const path = shapeOf(chain).path;
      for (const other of chains) {
        if (other === chain || (touched.has(other) && touchedList.indexOf(other) < index)) continue;
        const { crossings, overlaps } = pairTerms(path, shapeOf(other).path);
        cost += WEIGHT.crossing * crossings + WEIGHT.fault * overlaps;
        if (overlaps && describe)
          describe.push(`overlap ${chain.from}–${chain.to} ${other.from}–${other.to}`);
      }
    }
    const dirty = dotsOf(moved, touched);
    const everyDot = allDots();
    for (const dot of dirty) {
      cost += WEIGHT.frame * frameExcess(dot.point) ** 2;
      const geo = geography.get(dot.id);
      if (!dot.nodeId || dot.id === homeId || !geo || Math.hypot(geo.x, geo.y) === 0) continue;
      if (dot.point.x === homeCell.x && dot.point.y === homeCell.y) continue;
      const stray = angleBetween(bearingOf(homeCell, dot.point), bearingOf({ x: 0, y: 0 }, geo));
      cost += WEIGHT.topography * (stray / 45) ** 2;
    }
    for (const [index, dot] of dirty.entries()) {
      for (const other of everyDot) {
        if (other.point === dot.point) continue;
        const isDirty = dirty.some((entry) => entry.point === other.point);
        if (isDirty && dirty.findIndex((entry) => entry.point === other.point) < index) continue;
        if (Math.hypot(dot.point.x - other.point.x, dot.point.y - other.point.y) < SEPARATION) {
          cost += WEIGHT.fault;
          describe?.push(
            `crowded ${dot.nodeId ?? dot.chain?.interior.join(",")} ${other.nodeId ?? "a place"}`,
          );
        }
      }
      for (const chain of chains) {
        if (belongsTo(dot, chain)) continue;
        if (minimumDistance(dot.point, shapeOf(chain).path) < CLEARANCE) {
          cost += WEIGHT.fault;
          describe?.push(`${dot.nodeId ?? "a place"} on ${chain.from}–${chain.to}`);
        }
      }
    }
    for (const dot of everyDot) {
      if (dirty.some((entry) => entry.point === dot.point)) continue;
      for (const chain of touched) {
        if (belongsTo(dot, chain)) continue;
        if (minimumDistance(dot.point, shapeOf(chain).path) < CLEARANCE) {
          cost += WEIGHT.fault;
          describe?.push(`${dot.nodeId ?? "a place"} on ${chain.from}–${chain.to}`);
        }
      }
    }
    return cost;
  };

  const movable = skeletonIds.filter((id) => !pins.has(id));
  const isAxis = new Set(axis);
  const random = makeRandom(seed);
  /** The chain towards the core, where a node has exactly one. */
  const parentChain = new Map<string, Chain>();
  for (const id of movable) {
    const subtree = new Set(beyond.get(id) ?? [id]);
    const towardsCore = (chainsAt.get(id) ?? []).filter(
      (chain) => !subtree.has(chain.from === id ? chain.to : chain.from),
    );
    if (towardsCore.length === 1) parentChain.set(id, towardsCore[0]);
  }
  /** A shift that sets a node its chain's length from the chain's other end, folded at random. */
  const getJump = (id: string, chain: Chain): Point => {
    const anchor = layout.get(chain.from === id ? chain.to : chain.from) as Point;
    const point = layout.get(id) as Point;
    const first = Math.floor(random() * 8) * 45;
    const second = first + [0, 45, -45, 90, -90][Math.floor(random() * 5)];
    const length = desiredLength(chain);
    const along = Math.round(random() * length);
    const step = (degrees: number, distance: number): Point => {
      const unit = unitOf(degrees);
      const cells = cellsFor(unit, distance);
      return { x: Math.round(unit.x * cells), y: Math.round(unit.y * cells) };
    };
    const [a, b] = [step(first, along), step(second, length - along)];
    return { x: anchor.x + a.x + b.x - point.x, y: anchor.y + a.y + b.y - point.y };
  };
  const tryMove = (group: readonly string[], dx: number, dy: number, temperature: number) => {
    const moved = new Set(group);
    const before = scoreAround(moved);
    const previous = group.map((id) => layout.get(id) as Point);
    for (const [index, id] of group.entries()) {
      layout.set(id, { x: previous[index].x + dx, y: previous[index].y + dy });
    }
    reshape(moved);
    const after = scoreAround(moved);
    const accepted =
      after <= before || (temperature > 0 && random() < Math.exp((before - after) / temperature));
    if (!accepted) {
      for (const [index, id] of group.entries()) layout.set(id, previous[index]);
      reshape(moved);
    }
    return accepted ? before - after : 0;
  };

  for (let step = 0; step < steps && movable.length > 0; step += 1) {
    const temperature = 40 * (1 - step / steps) ** 3 + 0.05;
    const id = movable[Math.floor(random() * movable.length)];
    const subtree = beyond.get(id) ?? [id];
    const canCarry = !subtree.some((other) => isAxis.has(other));
    const parent = parentChain.get(id);
    if (parent && canCarry && random() < 0.15) {
      const jump = getJump(id, parent);
      tryMove(subtree, jump.x, jump.y, temperature);
      continue;
    }
    const group = random() < 0.35 && canCarry ? subtree : [id];
    const reach = random() < 0.75 ? 1 : 2;
    const dx = (Math.floor(random() * 3) - 1) * reach;
    const dy = isAxis.has(id) ? 0 : (Math.floor(random() * 3) - 1) * reach;
    if (dx === 0 && dy === 0) continue;
    tryMove(group, dx, dy, temperature);
  }
  // Repair: each node still in a fault tries every cell within three, alone or with its branch.
  for (let round = 0; round < 30; round += 1) {
    let improved = false;
    for (const id of movable) {
      if (scoreAround(new Set([id])) < WEIGHT.fault) continue;
      for (const group of [[id], beyond.get(id) ?? [id]]) {
        if (group.some((other) => isAxis.has(other) && other !== id)) continue;
        for (let dx = -3; dx <= 3; dx += 1) {
          for (let dy = isAxis.has(id) ? 0 : -3; dy <= (isAxis.has(id) ? 0 : 3); dy += 1) {
            if ((dx !== 0 || dy !== 0) && tryMove(group, dx, dy, 0) > 0) improved = true;
          }
        }
      }
    }
    if (!improved) break;
  }
  for (const chain of chains) shapes.set(chain, shapeChain(chain));

  const faults: string[] = [];
  const total = scoreAround(new Set(skeletonIds), faults);

  // Into map units, the frame's corner at the origin.
  const cells = new Map<string, Point>(layout);
  for (const chain of chains) {
    const { dots } = shapeOf(chain);
    for (const [index, id] of chain.interior.entries()) cells.set(id, dots[index]);
  }
  const margin = 2;
  const xs = [...cells.values()].map(({ x }) => x);
  const ys = [...cells.values()].map(({ y }) => y);
  const shift = { x: margin - Math.min(...xs), y: margin - Math.min(...ys) };
  const toUnits = (point: Point): Point => ({
    x: Math.round((point.x + shift.x) * grid * 100) / 100,
    y: Math.round((point.y + shift.y) * grid * 100) / 100,
  });

  const bends = new Map<string, Point>();
  for (const chain of chains) {
    const { path, length } = shapeOf(chain);
    if (path.length < 3) continue;
    const bendAt = readingLength(path.slice(0, 2));
    const step = length / (chain.interior.length + 1);
    const index = Math.floor(bendAt / step);
    if (Math.abs(bendAt - index * step) < 1e-6) continue;
    bends.set(regionEdgeKey(chain.edges[index]), toUnits(path[1]));
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
    faults: [...new Set(faults)],
    cost: Math.round(total % WEIGHT.fault),
  };
}

/** A repeatable shuffle, so a solve prints the same plan twice. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 1_000_000) / 1_000_000;
  };
}
