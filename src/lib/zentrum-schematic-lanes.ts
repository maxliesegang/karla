/**
 * Which lane of an edge each line is drawn in, and where the edge's band of lanes sits.
 *
 * The one part of the plan that is solved rather than read: lines must keep their order along
 * shared edges so each stays one stroke and companions stay side by side. The ordering follows
 * LOOM: a cost over crossings and separations, improved pass by pass until it settles, except that
 * the cost ranks crossings above separations.
 */
import {
  type SchematicPoint,
  type ZentrumSchematicLanedEdge,
  type ZentrumSchematicLinePath,
  type ZentrumSchematicNode,
  type ZentrumSchematicObservedEdge,
  compareLineIdsNaturally,
  crossProduct,
  dotProduct,
  getEdgeKey,
  getUnitVector,
  orientCorridorRun,
} from "./zentrum-schematic-plan";
/**
 * The cost's ranks, as weights far apart: fewest crossings, then crossings at bare junctions rather
 * than stops (whose capsules want straight lanes), then lanes ending where others turn away from
 * them, then fewest lanes standing between lines that travel together. No separation saved buys a
 * crossing.
 */
const TRACK_CROSSING_WEIGHT = 1e9;
const STOP_CROSSING_WEIGHT = 1e6;
const TRACK_END_WEIGHT = 1e3;
const TRACK_SEPARATION_WEIGHT = 3;

/** A cap on sweeps. Every move lowers (cost, order), so the search ends anyway; this bounds it. */
const TRACK_ORDER_PASS_LIMIT = 24;

/**
 * One pattern's passage through a stop, by the edges it uses, under its lane (a trunk and its
 * branches are one lane, with a passage each). One edge means the pattern ends here.
 */
type NodeTrackPassage = { trackId: string; edgeIds: readonly string[] };

/** How one edge meets a stop: which way it leaves, and which way its lanes are numbered. */
type NodeEdge = {
  /** The unit direction from the dot along the edge. */
  outward: SchematicPoint;
  /** +1 where the edge is measured away from this stop, -1 where it is measured towards it. */
  laneDirection: number;
};

const getNodeEdges = (
  node: ZentrumSchematicNode,
  edges: readonly ZentrumSchematicObservedEdge[],
): ReadonlyMap<string, NodeEdge> =>
  new Map(
    edges
      .filter((edge) => edge.from.id === node.id || edge.to.id === node.id)
      .map((edge) => {
        const other = edge.from.id === node.id ? edge.to : edge.from;
        const run = orientCorridorRun(edge);
        const outward = getUnitVector(node, other);
        return [
          edge.id,
          { outward, laneDirection: dotProduct(run, outward) >= 0 ? 1 : -1 },
        ] as const;
      }),
  );

/**
 * How far a line turns at a stop, from the arriving edge's frame: straight on is zero, and the
 * sign matches lane numbering. A pattern ending here reads zero.
 */
const getEdgeTurn = (edge: NodeEdge, exit: NodeEdge | undefined): number => {
  if (!exit) return 0;
  const arriving = { x: -edge.outward.x, y: -edge.outward.y };
  const rightwards = { x: -edge.outward.y, y: edge.outward.x };
  return Math.atan2(dotProduct(exit.outward, rightwards), dotProduct(exit.outward, arriving));
};

/**
 * A pair of lines at a stop, reduced to the test their lanes must pass not to cross. Sharing both
 * edges, lane numbers must reverse (they count outwards from the dot); sharing one, they cross
 * when the left one leaves right; sharing none, any order works. A pattern ending here crosses
 * nothing, but its lane should end on the side the other turns to, not leave a gap it turns from.
 */
type NodeTrackCrossing = {
  trackIds: readonly [string, string];
  /** Whether one of the pair ends here, so the test is the side its lane ends on. */
  isEnd: boolean;
  /** The edges the pair's lanes are read on, and which way each numbers them. */
  reads: readonly { edgeId: string; laneDirection: number }[];
  /** Where the pair parts, which way the second turns away from the first. */
  turnSign: number;
};

const getNodeTrackCrossings = (
  nodeEdges: ReadonlyMap<string, NodeEdge>,
  passages: readonly NodeTrackPassage[],
): readonly NodeTrackCrossing[] =>
  passages.flatMap((left, index) =>
    passages.slice(index + 1).flatMap((right): NodeTrackCrossing[] => {
      // One lane holds one place, whichever of its patterns is read.
      if (left.trackId === right.trackId) return [];
      const trackIds = [left.trackId, right.trackId] as const;
      const shared = left.edgeIds.filter((edgeId) => right.edgeIds.includes(edgeId));
      const read = (edgeId: string) => ({
        edgeId,
        laneDirection: nodeEdges.get(edgeId)?.laneDirection ?? 1,
      });
      if (shared.length === 2) {
        return [{ trackIds, isEnd: false, reads: shared.map(read), turnSign: 0 }];
      }
      if (shared.length !== 1) return [];
      const edge = nodeEdges.get(shared[0]);
      if (!edge) return [];
      const [leftExit, rightExit] = [left, right].map((passage) =>
        nodeEdges.get(passage.edgeIds.find((id) => id !== shared[0]) ?? ""),
      );
      const turnSign = Math.sign(getEdgeTurn(edge, leftExit) - getEdgeTurn(edge, rightExit));
      const isEnd = !leftExit || !rightExit;
      return turnSign === 0 ? [] : [{ trackIds, isEnd, reads: [read(shared[0])], turnSign }];
    }),
  );

/** The crossings at a stop, and the lanes ending where another turns away from them. */
const countNodeTrackCrossings = (
  crossings: readonly NodeTrackCrossing[],
  orderByEdgeId: ReadonlyMap<string, readonly string[]>,
): { crossings: number; ends: number } => {
  const count = { crossings: 0, ends: 0 };
  for (const { trackIds, isEnd, reads, turnSign } of crossings) {
    const sides = reads.map(({ edgeId, laneDirection }) => {
      const order = orderByEdgeId.get(edgeId) ?? [];
      return Math.sign(laneDirection * (order.indexOf(trackIds[0]) - order.indexOf(trackIds[1])));
    });
    if (reads.length === 2) {
      if (sides[0] === sides[1]) count.crossings += 1;
    } else if (isEnd) {
      // Turning over the end's lane is what draws cleanly.
      if (sides[0] * turnSign > 0) count.ends += 1;
    } else if (sides[0] * turnSign < 0) {
      count.crossings += 1;
    }
  }
  return count;
};

const getLinePathEdgeIds = (linePath: ZentrumSchematicLinePath): ReadonlySet<string> =>
  new Set(
    linePath.nodes.slice(1).map((node, index) => getEdgeKey(linePath.nodes[index].id, node.id)),
  );

const getTrackPairKey = (leftTrackId: string, rightTrackId: string): string =>
  leftTrackId < rightTrackId
    ? `${leftTrackId}\u0000${rightTrackId}`
    : `${rightTrackId}\u0000${leftTrackId}`;

const compareTrackOrders = (left: readonly string[], right: readonly string[]): number => {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const compared = compareLineIdsNaturally(left[index], right[index]);
    if (compared !== 0) return compared;
  }
  return left.length - right.length;
};

/** Two lanes' run together: consecutive edges both run through, unbroken at stops. */
type SharedTrackRun = {
  trackIds: readonly [string, string];
  edgeIds: readonly string[];
  /** Where the run passes from one of its edges into the next. */
  steps: readonly { fromEdgeId: string; toEdgeId: string; nodeId: string }[];
};

const getSharedTrackRuns = (
  edgeIdsByTrackId: ReadonlyMap<string, ReadonlySet<string>>,
  passagesByNodeId: ReadonlyMap<string, readonly NodeTrackPassage[]>,
): readonly SharedTrackRun[] => {
  // The stop each lane runs through between two edges, by the pair.
  const throughNodeByTrackId = new Map<string, Map<string, string>>();
  for (const [nodeId, passages] of passagesByNodeId) {
    for (const { trackId, edgeIds } of passages) {
      const nodeByKey = throughNodeByTrackId.get(trackId) ?? new Map<string, string>();
      for (const from of edgeIds) {
        for (const to of edgeIds) {
          if (from !== to) nodeByKey.set(`${from}\u0000${to}`, nodeId);
        }
      }
      throughNodeByTrackId.set(trackId, nodeByKey);
    }
  }
  const runs: SharedTrackRun[] = [];
  const lanes = [...edgeIdsByTrackId];
  for (let leftIndex = 0; leftIndex < lanes.length; leftIndex += 1) {
    const [leftTrackId, leftEdgeIds] = lanes[leftIndex];
    const leftThrough = throughNodeByTrackId.get(leftTrackId);
    for (const [rightTrackId, rightEdgeIds] of lanes.slice(leftIndex + 1)) {
      const shared = [...leftEdgeIds].filter((edgeId) => rightEdgeIds.has(edgeId));
      const rightThrough = throughNodeByTrackId.get(rightTrackId);
      const reached = new Set<string>();
      for (const start of shared) {
        if (reached.has(start)) continue;
        const run = [start];
        const steps: SharedTrackRun["steps"][number][] = [];
        reached.add(start);
        for (let at = 0; at < run.length; at += 1) {
          for (const next of shared) {
            const key = `${run[at]}\u0000${next}`;
            const nodeId = leftThrough?.get(key);
            if (reached.has(next) || !nodeId || rightThrough?.get(key) !== nodeId) continue;
            reached.add(next);
            run.push(next);
            steps.push({ fromEdgeId: run[at], toEdgeId: next, nodeId });
          }
        }
        runs.push({ trackIds: [leftTrackId, rightTrackId], edgeIds: run, steps });
      }
    }
  }
  return runs;
};

/**
 * How much two lanes want to be neighbours on each edge: the length of their run through it.
 * A pair meeting for one edge wants little, so a long shared route elsewhere cannot buy a
 * crossing here.
 */
const getTrackAffinitiesByEdgeId = (
  runs: readonly SharedTrackRun[],
): ReadonlyMap<string, ReadonlyMap<string, number>> => {
  const affinitiesByEdgeId = new Map<string, Map<string, number>>();
  for (const { trackIds, edgeIds } of runs) {
    for (const edgeId of edgeIds) {
      const affinities = affinitiesByEdgeId.get(edgeId) ?? new Map<string, number>();
      affinities.set(getTrackPairKey(...trackIds), edgeIds.length);
      affinitiesByEdgeId.set(edgeId, affinities);
    }
  }
  return affinitiesByEdgeId;
};

const getEdgeSeparationCost = (
  trackIds: readonly string[],
  affinityByTrackPair: ReadonlyMap<string, number> = new Map(),
): number => {
  let cost = 0;
  for (let leftIndex = 0; leftIndex < trackIds.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < trackIds.length; rightIndex += 1) {
      const affinity = affinityByTrackPair.get(
        getTrackPairKey(trackIds[leftIndex], trackIds[rightIndex]),
      );
      if (affinity) {
        cost += TRACK_SEPARATION_WEIGHT * affinity * Math.max(rightIndex - leftIndex - 1, 0);
      }
    }
  }
  return cost;
};

/**
 * Moves of a run of neighbouring lines elsewhere, plus the reversal. Runs, because a group leaving
 * together (S-Bahnen turning north out of the Poststraße) can only cross others as a block.
 */
const getTrackOrderMoves = (order: readonly string[]): (readonly string[])[] => {
  const moves: string[][] = [];
  for (let start = 0; start < order.length; start += 1) {
    for (let length = 1; length <= order.length - start; length += 1) {
      if (length === order.length) continue;
      const rest = [...order];
      const block = rest.splice(start, length);
      for (let at = 0; at <= rest.length; at += 1) {
        if (at === start) continue;
        moves.push([...rest.slice(0, at), ...block, ...rest.slice(at)]);
      }
    }
  }
  // A mirrored edge rights itself in one scorable step.
  if (order.length > 2) moves.push([...order].reverse());
  return moves;
};

/** One edge's order carried into the next at a stop; read once, since routes fix them. */
type TrackOrderHandover = {
  fromEdgeId: string;
  toEdgeId: string;
  nodeId: string;
  /** The lines running from one edge into the other: what the handover is worth. */
  throughTrackIds: ReadonlySet<string>;
};

const getTrackOrderHandovers = (
  edgesByNodeId: ReadonlyMap<string, ReadonlyMap<string, NodeEdge>>,
  passagesByNodeId: ReadonlyMap<string, readonly NodeTrackPassage[]>,
): ReadonlyMap<string, readonly TrackOrderHandover[]> => {
  const handoversByEdgeId = new Map<string, TrackOrderHandover[]>();
  for (const [nodeId, nodeEdges] of edgesByNodeId) {
    for (const fromEdgeId of nodeEdges.keys()) {
      for (const toEdgeId of nodeEdges.keys()) {
        if (fromEdgeId === toEdgeId) continue;
        const throughTrackIds = new Set(
          (passagesByNodeId.get(nodeId) ?? [])
            .filter(
              (passage) =>
                passage.edgeIds.includes(fromEdgeId) && passage.edgeIds.includes(toEdgeId),
            )
            .map(({ trackId }) => trackId),
        );
        if (throughTrackIds.size === 0) continue;
        const handovers = handoversByEdgeId.get(fromEdgeId) ?? [];
        handovers.push({ fromEdgeId, toEdgeId, nodeId, throughTrackIds });
        handoversByEdgeId.set(fromEdgeId, handovers);
      }
    }
  }
  return handoversByEdgeId;
};

/**
 * Whether lines running between two edges keep their lane numbers: measured the same way from
 * the stop they reverse; measured opposite ways (a straight) they match.
 */
const keepsLaneOrder = (arriving: NodeEdge, leaving: NodeEdge): boolean =>
  arriving.laneDirection !== leaving.laneDirection;

/**
 * Carries orders outwards across stops so no line crosses another where it runs through;
 * per-edge moves cannot fix a group turning off together. The busiest handover goes first;
 * lines joining at a stop keep their places.
 */
const propagateTrackOrders = (
  busiestFirst: readonly ZentrumSchematicObservedEdge[],
  handoversByEdgeId: ReadonlyMap<string, readonly TrackOrderHandover[]>,
  edgesByNodeId: ReadonlyMap<string, ReadonlyMap<string, NodeEdge>>,
  orderByEdgeId: ReadonlyMap<string, readonly string[]>,
  firstSeedEdgeId?: string,
): Map<string, readonly string[]> => {
  const settled = new Map<string, readonly string[]>();
  const open: TrackOrderHandover[] = [];
  const settle = (edgeId: string, order: readonly string[]) => {
    settled.set(edgeId, order);
    for (const handover of handoversByEdgeId.get(edgeId) ?? []) {
      if (!settled.has(handover.toEdgeId)) open.push(handover);
    }
  };
  if (firstSeedEdgeId) settle(firstSeedEdgeId, orderByEdgeId.get(firstSeedEdgeId) ?? []);

  while (settled.size < busiestFirst.length) {
    let best: TrackOrderHandover | undefined;
    for (const handover of open) {
      if (settled.has(handover.toEdgeId)) continue;
      if (
        !best ||
        handover.throughTrackIds.size > best.throughTrackIds.size ||
        (handover.throughTrackIds.size === best.throughTrackIds.size &&
          `${handover.toEdgeId} ${handover.fromEdgeId}` < `${best.toEdgeId} ${best.fromEdgeId}`)
      ) {
        best = handover;
      }
    }
    if (!best) {
      const seed = busiestFirst.find((edge) => !settled.has(edge.id));
      if (!seed) break;
      settle(seed.id, orderByEdgeId.get(seed.id) ?? []);
      continue;
    }

    const arriving = edgesByNodeId.get(best.nodeId)?.get(best.fromEdgeId);
    const leaving = edgesByNodeId.get(best.nodeId)?.get(best.toEdgeId);
    const base = orderByEdgeId.get(best.toEdgeId) ?? [];
    const through = best.throughTrackIds;
    const carried = (settled.get(best.fromEdgeId) ?? []).filter((trackId) => through.has(trackId));
    const derived =
      arriving && leaving && keepsLaneOrder(arriving, leaving) ? carried : [...carried].reverse();
    const next = [...base];
    const places = base.flatMap((trackId, index) => (through.has(trackId) ? [index] : []));
    derived.forEach((trackId, index) => {
      if (places[index] !== undefined) next[places[index]] = trackId;
    });
    // The same array where nothing moved, so the search sees by identity what was disturbed.
    settle(best.toEdgeId, next.every((trackId, index) => trackId === base[index]) ? base : next);
  }
  return settled;
};

/**
 * The lane order on every edge (LOOM's line ordering): crossings at stops plus lanes left
 * between companions, scored at stops so a turn's far end counts. A move is taken only if it lowers
 * the cost; ties go to the lower-reading order, so the search cannot cycle and is deterministic.
 */
export const getTrackIdsByEdgeId = (
  edges: readonly ZentrumSchematicObservedEdge[],
  linePaths: readonly ZentrumSchematicLinePath[],
): ReadonlyMap<string, readonly string[]> => {
  const trackIdByLineId = new Map(linePaths.map(({ lineId, trackId }) => [lineId, trackId]));
  let orderByEdgeId = new Map<string, readonly string[]>(
    edges.map((edge) => [
      // Only drawn lanes are ordered; a trunk with its branches takes one.
      edge.id,
      [...new Set(edge.lineIds.flatMap((lineId) => trackIdByLineId.get(lineId) ?? []))],
    ]),
  );

  const nodesById = new Map(
    edges.flatMap(({ from, to }) => [from, to]).map((node) => [node.id, node] as const),
  );
  const edgesByNodeId = new Map(
    [...nodesById].map(([nodeId, node]) => [nodeId, getNodeEdges(node, edges)] as const),
  );
  // One passage per drawn pattern at a stop, under its lane: a branch ending here ends, though its
  // trunk runs on.
  const edgeIdsByTrackId = new Map<string, Set<string>>();
  const passageByKeyByNodeId = new Map<string, Map<string, NodeTrackPassage>>();
  for (const linePath of linePaths) {
    const pathEdgeIds = edgeIdsByTrackId.get(linePath.trackId) ?? new Set<string>();
    for (const edgeId of getLinePathEdgeIds(linePath)) pathEdgeIds.add(edgeId);
    edgeIdsByTrackId.set(linePath.trackId, pathEdgeIds);
    for (const [index, node] of linePath.nodes.entries()) {
      const edgeIds = [linePath.nodes[index - 1], linePath.nodes[index + 1]]
        .filter((neighbor): neighbor is ZentrumSchematicNode => neighbor !== undefined)
        .map((neighbor) => getEdgeKey(node.id, neighbor.id))
        .sort();
      const passageByKey = passageByKeyByNodeId.get(node.id) ?? new Map<string, NodeTrackPassage>();
      passageByKey.set(`${linePath.trackId}\u0001${edgeIds.join("\u0001")}`, {
        trackId: linePath.trackId,
        edgeIds,
      });
      passageByKeyByNodeId.set(node.id, passageByKey);
    }
  }
  const passagesByNodeId = new Map<string, readonly NodeTrackPassage[]>(
    [...passageByKeyByNodeId].map(([nodeId, passageByKey]) => [nodeId, [...passageByKey.values()]]),
  );

  const handoversByEdgeId = getTrackOrderHandovers(edgesByNodeId, passagesByNodeId);
  const busiestFirst = [...edges].sort(
    (left, right) =>
      (orderByEdgeId.get(right.id)?.length ?? 0) - (orderByEdgeId.get(left.id)?.length ?? 0) ||
      left.id.localeCompare(right.id),
  );

  const sharedRuns = getSharedTrackRuns(edgeIdsByTrackId, passagesByNodeId);
  const affinitiesByEdgeId = getTrackAffinitiesByEdgeId(sharedRuns);
  const trackCrossingsByNodeId = new Map(
    [...edgesByNodeId].map(
      ([nodeId, nodeEdges]) =>
        [nodeId, getNodeTrackCrossings(nodeEdges, passagesByNodeId.get(nodeId) ?? [])] as const,
    ),
  );
  const getNodeCost = (nodeId: string, orders: ReadonlyMap<string, readonly string[]>): number => {
    const { crossings, ends } = countNodeTrackCrossings(
      trackCrossingsByNodeId.get(nodeId) ?? [],
      orders,
    );
    const crossingWeight =
      TRACK_CROSSING_WEIGHT + (nodesById.get(nodeId)?.isJunction ? 0 : STOP_CROSSING_WEIGHT);
    return crossingWeight * crossings + TRACK_END_WEIGHT * ends;
  };
  const searchOrder = [...edges].sort((left, right) => left.id.localeCompare(right.id));
  const compareDrawings = (
    left: ReadonlyMap<string, readonly string[]>,
    right: ReadonlyMap<string, readonly string[]>,
  ): number => {
    for (const edge of searchOrder) {
      const leftOrder = left.get(edge.id);
      const rightOrder = right.get(edge.id);
      // A move leaves every edge it did not touch holding the very same array.
      if (leftOrder === rightOrder) continue;
      const compared = compareTrackOrders(leftOrder ?? [], rightOrder ?? []);
      if (compared !== 0) return compared;
    }
    return 0;
  };

  orderByEdgeId = propagateTrackOrders(
    busiestFirst,
    handoversByEdgeId,
    edgesByNodeId,
    orderByEdgeId,
  );

  // The cost is kept in parts, so scoring a candidate re-counts only the stops it disturbed.
  const nodeCostByNodeId = new Map<string, number>();
  const separationByEdgeId = new Map<string, number>();
  let cost = 0;
  const readCost = (orders: ReadonlyMap<string, readonly string[]>) => {
    cost = 0;
    for (const nodeId of edgesByNodeId.keys()) {
      const nodeCost = getNodeCost(nodeId, orders);
      nodeCostByNodeId.set(nodeId, nodeCost);
      cost += nodeCost;
    }
    for (const edge of searchOrder) {
      const separation = getEdgeSeparationCost(
        orders.get(edge.id) ?? [],
        affinitiesByEdgeId.get(edge.id),
      );
      separationByEdgeId.set(edge.id, separation);
      cost += separation;
    }
  };
  readCost(orderByEdgeId);

  const getCandidateCost = (candidate: ReadonlyMap<string, readonly string[]>): number => {
    const moved = searchOrder.filter(
      (edge) => candidate.get(edge.id) !== orderByEdgeId.get(edge.id),
    );
    let candidateCost = cost;
    for (const edge of moved) {
      candidateCost +=
        getEdgeSeparationCost(candidate.get(edge.id) ?? [], affinitiesByEdgeId.get(edge.id)) -
        (separationByEdgeId.get(edge.id) ?? 0);
    }
    for (const nodeId of new Set(moved.flatMap(({ from, to }) => [from.id, to.id]))) {
      candidateCost += getNodeCost(nodeId, candidate) - (nodeCostByNodeId.get(nodeId) ?? 0);
    }
    return candidateCost;
  };

  const withOrder = (
    orders: ReadonlyMap<string, readonly string[]>,
    edgeId: string,
    order: readonly string[],
  ): Map<string, readonly string[]> => new Map(orders).set(edgeId, order);

  /**
   * One sweep, taking the best move on each edge in turn. Carried moves escape plateaus but
   * cost far more, so they are swept only once local moves have nothing left.
   */
  const sweep = (carries: boolean): boolean => {
    let improved = false;
    for (const edge of searchOrder) {
      const order = orderByEdgeId.get(edge.id) ?? [];
      if (order.length < 2) continue;
      let best = orderByEdgeId;
      let bestCost = cost;
      for (const candidate of getTrackOrderMoves(order)) {
        const moved = withOrder(orderByEdgeId, edge.id, candidate);
        const drawing = carries
          ? propagateTrackOrders(busiestFirst, handoversByEdgeId, edgesByNodeId, moved, edge.id)
          : moved;
        const candidateCost = getCandidateCost(drawing);
        if (
          candidateCost < bestCost ||
          (candidateCost === bestCost && compareDrawings(drawing, best) < 0)
        ) {
          best = drawing;
          bestCost = candidateCost;
        }
      }
      if (best !== orderByEdgeId) {
        orderByEdgeId = best;
        readCost(orderByEdgeId);
        improved = true;
      }
    }
    return improved;
  };

  /**
   * Run moves: a pair set to one side along all of its run at once, so it crosses nowhere on it. A
   * edge at a time cannot get there without crossing them first (3 and 6 from Tivoli on).
   */
  const getRunMoves = ({
    trackIds,
    edgeIds,
    steps,
  }: SharedTrackRun): Map<string, readonly string[]>[] => {
    // The side each edge must keep, relative to the first, for the pair not to cross.
    const sideByEdgeId = new Map([[edgeIds[0], 1]]);
    for (const { fromEdgeId, toEdgeId, nodeId } of steps) {
      const nodeEdges = edgesByNodeId.get(nodeId);
      const arriving = nodeEdges?.get(fromEdgeId);
      const leaving = nodeEdges?.get(toEdgeId);
      if (!arriving || !leaving) continue;
      const side = sideByEdgeId.get(fromEdgeId) ?? 1;
      sideByEdgeId.set(toEdgeId, keepsLaneOrder(arriving, leaving) ? side : -side);
    }
    const getSide = (order: readonly string[]) =>
      Math.sign(order.indexOf(trackIds[0]) - order.indexOf(trackIds[1]));
    return [1, -1].flatMap((target) => {
      const candidate = new Map(orderByEdgeId);
      let moved = false;
      for (const edgeId of edgeIds) {
        const order = orderByEdgeId.get(edgeId) ?? [];
        if (getSide(order) === target * (sideByEdgeId.get(edgeId) ?? 1)) continue;
        moved = true;
        candidate.set(
          edgeId,
          order.map((trackId) =>
            trackId === trackIds[0] ? trackIds[1] : trackId === trackIds[1] ? trackIds[0] : trackId,
          ),
        );
      }
      return moved ? [candidate] : [];
    });
  };
  const sweepRuns = (): boolean => {
    let improved = false;
    for (const run of sharedRuns) {
      if (run.edgeIds.length < 2) continue;
      for (const candidate of getRunMoves(run)) {
        const candidateCost = getCandidateCost(candidate);
        if (
          candidateCost < cost ||
          (candidateCost === cost && compareDrawings(candidate, orderByEdgeId) < 0)
        ) {
          orderByEdgeId = candidate;
          readCost(orderByEdgeId);
          improved = true;
          break;
        }
      }
    }
    return improved;
  };

  for (let pass = 0; pass < TRACK_ORDER_PASS_LIMIT; pass += 1) {
    if (!sweep(false) && !sweepRuns() && !sweep(true)) break;
  }
  return orderByEdgeId;
};

/** Whether two edges meeting at a stop are one straight through it (exact: coordinates are). */
const isStraightPair = (
  beforeEdge: ZentrumSchematicLanedEdge,
  afterEdge: ZentrumSchematicLanedEdge,
  node: ZentrumSchematicNode,
): boolean => {
  const before = beforeEdge.from.id === node.id ? beforeEdge.to : beforeEdge.from;
  const after = afterEdge.from.id === node.id ? afterEdge.to : afterEdge.from;
  const through = { x: node.x - before.x, y: node.y - before.y };
  const onward = { x: after.x - node.x, y: after.y - node.y };
  return crossProduct(through, onward) === 0 && dotProduct(through, onward) > 0;
};

/**
 * Each edge's band offset from its middle, in lanes, so a lane running straight through a stop
 * keeps its distance from the middle (no stepping aside along the Kaiserstraße). Each straight pair
 * of edges votes per through lane; the majority wins, ties shift nothing. The busiest edge
 * of a straight stays centred. In lanes, so the lane width can change without a re-layout.
 */
export const getTrackBandOffsetByEdgeId = (
  edges: readonly ZentrumSchematicLanedEdge[],
  linePaths: readonly ZentrumSchematicLinePath[],
): ReadonlyMap<string, number> => {
  const edgeById = new Map(edges.map((edge) => [edge.id, edge]));

  // Read off the drawn patterns, so a lane turning off the straight votes nowhere.
  const votesByPairKey = new Map<
    string,
    { leftId: string; rightId: string; votes: Map<number, number> }
  >();
  const votedLanes = new Set<string>();
  for (const linePath of linePaths) {
    for (let index = 1; index < linePath.nodes.length - 1; index += 1) {
      const node = linePath.nodes[index];
      const arriving = edgeById.get(getEdgeKey(linePath.nodes[index - 1].id, node.id));
      const leaving = edgeById.get(getEdgeKey(node.id, linePath.nodes[index + 1].id));
      if (!arriving || !leaving || !isStraightPair(arriving, leaving, node)) continue;
      // Edge ids contain the separator, so the pair is kept as its ends, never split from the key.
      const leftId = arriving.id < leaving.id ? arriving.id : leaving.id;
      const rightId = leftId === arriving.id ? leaving.id : arriving.id;
      const pairKey = `${leftId}\u0000${rightId}`;
      const voteKey = `${pairKey}\u0000${linePath.trackId}`;
      if (votedLanes.has(voteKey)) continue;
      votedLanes.add(voteKey);
      const arrivingLane = arriving.trackIds.indexOf(linePath.trackId);
      const leavingLane = leaving.trackIds.indexOf(linePath.trackId);
      if (arrivingLane < 0 || leavingLane < 0) continue;
      // b_leaving - b_arriving, from o_arriving(arrivingLane) = o_leaving(leavingLane).
      const delta =
        arrivingLane - leavingLane + (leaving.trackIds.length - arriving.trackIds.length) / 2;
      const canonicalDelta = arriving.id === leftId ? delta : -delta;
      const pair = votesByPairKey.get(pairKey) ?? {
        leftId,
        rightId,
        votes: new Map<number, number>(),
      };
      pair.votes.set(canonicalDelta, (pair.votes.get(canonicalDelta) ?? 0) + 1);
      votesByPairKey.set(pairKey, pair);
    }
  }

  const neighborsByEdgeId = new Map<string, { otherId: string; delta: number }[]>();
  const addNeighbor = (edgeId: string, otherId: string, delta: number) => {
    const neighbors = neighborsByEdgeId.get(edgeId) ?? [];
    neighbors.push({ otherId, delta });
    neighborsByEdgeId.set(edgeId, neighbors);
  };
  for (const { leftId, rightId, votes } of votesByPairKey.values()) {
    const [winningDelta] = [...votes.entries()].sort(
      ([leftDelta, leftCount], [rightDelta, rightCount]) =>
        rightCount - leftCount ||
        Math.abs(leftDelta) - Math.abs(rightDelta) ||
        leftDelta - rightDelta,
    )[0];
    addNeighbor(leftId, rightId, winningDelta);
    addNeighbor(rightId, leftId, -winningDelta);
  }

  // Each straight is anchored at its busiest edge and its offsets carried outwards from there.
  const bandOffsetByEdgeId = new Map<string, number>();
  for (const edge of edges) {
    if (bandOffsetByEdgeId.has(edge.id)) continue;
    const component: ZentrumSchematicLanedEdge[] = [];
    const open = [edge];
    const reached = new Set<string>([edge.id]);
    while (open.length > 0) {
      const current = open.pop()!;
      component.push(current);
      for (const { otherId } of neighborsByEdgeId.get(current.id) ?? []) {
        if (reached.has(otherId)) continue;
        reached.add(otherId);
        const other = edgeById.get(otherId);
        if (other) open.push(other);
      }
    }
    const anchor = component.reduce((widest, candidate) =>
      candidate.trackIds.length > widest.trackIds.length ||
      (candidate.trackIds.length === widest.trackIds.length && candidate.id < widest.id)
        ? candidate
        : widest,
    );
    const queue = [anchor];
    bandOffsetByEdgeId.set(anchor.id, 0);
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const { otherId, delta } of neighborsByEdgeId.get(current.id) ?? []) {
        if (bandOffsetByEdgeId.has(otherId)) continue;
        bandOffsetByEdgeId.set(otherId, bandOffsetByEdgeId.get(current.id)! + delta);
        const other = edgeById.get(otherId);
        if (other) queue.push(other);
      }
    }
  }
  return bandOffsetByEdgeId;
};
