/**
 * Octilinear layout for the Zentrum plan's solver: directions per corridor and least-distortion
 * positions. The region plan lays itself out in `src/lib/region-layout.ts`.
 */

export type Point = { x: number; y: number };
export type Edge = { from: string; to: string };
export type LabelSide = "left" | "right" | "above" | "below";

export const edgeKey = (edge: Edge): string => `${edge.from} ${edge.to}`;

const DIRECTIONS = [0, 45, 90, 135, 180, 225, 270, 315] as const;
export const unitOf = (degrees: number): Point => ({
  x: Math.round(Math.cos((degrees * Math.PI) / 180) * 1e6) / 1e6,
  y: Math.round(Math.sin((degrees * Math.PI) / 180) * 1e6) / 1e6,
});
export const bearingOf = (from: Point, to: Point): number =>
  ((Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI + 360) % 360;
export const angleBetween = (left: number, right: number): number =>
  Math.abs(((left - right + 540) % 360) - 180);

/** One direction per corridor, claimed once per place, best fits first. */
export function assignDirections(
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

/**
 * The least-distorted positions under the assigned directions: each place solved against its
 * neighbours (a 2×2 system), swept until nothing moves.
 */
export function solvePositions(
  nodeIds: readonly string[],
  edges: readonly Edge[],
  geography: ReadonlyMap<string, Point>,
  directions: ReadonlyMap<string, number>,
  lengths: ReadonlyMap<string, number>,
  defaultLength: number,
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
        const length = lengths.get(key) ?? defaultLength;
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

export function distanceToSegment(point: Point, from: Point, to: Point): number {
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

/** A repeatable shuffle, so a solve prints the same table twice. */
export function makeRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 1_000_000) / 1_000_000;
  };
}

/** Which side of its dot a name can stand on: the one no corridor leaves in. */
export function chooseLabelSide(
  id: string,
  layout: ReadonlyMap<string, Point>,
  edges: readonly Edge[],
): LabelSide {
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
