/**
 * Which lane of a corridor each line is drawn in, and where the corridor's band of lanes sits.
 *
 * The one part of the plan that is solved rather than read: lines must keep their order along
 * shared corridors so each stays one stroke and companions stay side by side. The ordering follows
 * LOOM: a cost over crossings and separations, improved pass by pass until it settles.
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
 * LOOM's weights for a crossing at a stop and for a lane standing between two lines that travel
 * together. One cost, not a ranking, so a crossing may be accepted to keep a shared route whole.
 */
const LINE_CROSSING_WEIGHT = 4;
const LINE_SEPARATION_WEIGHT = 3;

/** A cap on sweeps. Every move lowers (cost, order), so the search ends anyway; this bounds it. */
const LINE_ORDER_PASS_LIMIT = 24;

/**
 * One lane's passage through a stop, by the corridors it uses (a trunk and its branches are one
 * lane). One corridor means the pattern ends here, drawn into the dot.
 */
type NodeLinePassage = { lineId: string; edgeIds: readonly string[] };

/** How one corridor meets a stop: which way it leaves, and which way its lanes are numbered. */
type NodeCorridor = {
  /** The unit direction from the dot along the corridor. */
  outward: SchematicPoint;
  /** +1 where the corridor is measured away from this stop, -1 where it is measured towards it. */
  laneDirection: number;
};

const getNodeCorridors = (
  node: ZentrumSchematicNode,
  edges: readonly ZentrumSchematicObservedEdge[],
): ReadonlyMap<string, NodeCorridor> =>
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
 * How far a line turns at a stop, from the arriving corridor's frame: straight on is zero, and the
 * sign matches lane numbering. A pattern ending here reads zero, in the way of anything turning.
 */
const getCorridorTurn = (corridor: NodeCorridor, exit: NodeCorridor | undefined): number => {
  if (!exit) return 0;
  const arriving = { x: -corridor.outward.x, y: -corridor.outward.y };
  const rightwards = { x: -corridor.outward.y, y: corridor.outward.x };
  return Math.atan2(dotProduct(exit.outward, rightwards), dotProduct(exit.outward, arriving));
};

/**
 * A pair of lines at a stop, reduced to the test their lanes must pass not to cross. Sharing both
 * corridors, lane numbers must reverse (they count outwards from the dot); sharing one, they cross
 * when the left one leaves right; sharing none, any order works.
 */
type NodeLineCrossing = {
  lineIds: readonly [string, string];
  /** The corridors the pair's lanes are read on, and which way each numbers them. */
  reads: readonly { edgeId: string; laneDirection: number }[];
  /** Where the pair parts, which way the second turns away from the first. */
  turnSign: number;
};

const getNodeLineCrossings = (
  corridors: ReadonlyMap<string, NodeCorridor>,
  passages: readonly NodeLinePassage[],
): readonly NodeLineCrossing[] =>
  passages.flatMap((left, index) =>
    passages.slice(index + 1).flatMap((right): NodeLineCrossing[] => {
      const lineIds = [left.lineId, right.lineId] as const;
      const shared = left.edgeIds.filter((edgeId) => right.edgeIds.includes(edgeId));
      const read = (edgeId: string) => ({
        edgeId,
        laneDirection: corridors.get(edgeId)?.laneDirection ?? 1,
      });
      if (shared.length === 2) {
        return [{ lineIds, reads: shared.map(read), turnSign: 0 }];
      }
      if (shared.length !== 1) return [];
      const corridor = corridors.get(shared[0]);
      if (!corridor) return [];
      const getTurn = (passage: NodeLinePassage) =>
        getCorridorTurn(
          corridor,
          corridors.get(passage.edgeIds.find((id) => id !== shared[0]) ?? ""),
        );
      const turnSign = Math.sign(getTurn(left) - getTurn(right));
      return turnSign === 0 ? [] : [{ lineIds, reads: [read(shared[0])], turnSign }];
    }),
  );

const countNodeLineCrossings = (
  crossings: readonly NodeLineCrossing[],
  orderByEdgeId: ReadonlyMap<string, readonly string[]>,
): number => {
  let count = 0;
  for (const { lineIds, reads, turnSign } of crossings) {
    const sides = reads.map(({ edgeId, laneDirection }) => {
      const order = orderByEdgeId.get(edgeId) ?? [];
      return Math.sign(laneDirection * (order.indexOf(lineIds[0]) - order.indexOf(lineIds[1])));
    });
    const crosses = reads.length === 2 ? sides[0] === sides[1] : sides[0] * turnSign < 0;
    if (crosses) count += 1;
  }
  return count;
};

const getLinePathEdgeIds = (linePath: ZentrumSchematicLinePath): ReadonlySet<string> =>
  new Set(
    linePath.nodes.slice(1).map((node, index) => getEdgeKey(linePath.nodes[index].id, node.id)),
  );

const getLinePairKey = (leftLineId: string, rightLineId: string): string =>
  leftLineId < rightLineId
    ? `${leftLineId}\u0000${rightLineId}`
    : `${rightLineId}\u0000${leftLineId}`;

const compareLineOrders = (left: readonly string[], right: readonly string[]): number => {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const compared = compareLineIdsNaturally(left[index], right[index]);
    if (compared !== 0) return compared;
  }
  return left.length - right.length;
};

/**
 * How much two lanes want to be neighbours: the corridors their drawn routes share. Charging for
 * each lane between them keeps long shared routes together, with short workings around them.
 */
const getLineAffinities = (
  edgeIdsByTrackId: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlyMap<string, number> => {
  const affinityByLinePair = new Map<string, number>();
  const edgeIdsByLinePath = [...edgeIdsByTrackId];
  for (let leftIndex = 0; leftIndex < edgeIdsByLinePath.length; leftIndex += 1) {
    const [leftLineId, leftEdgeIds] = edgeIdsByLinePath[leftIndex];
    for (const [rightLineId, rightEdgeIds] of edgeIdsByLinePath.slice(leftIndex + 1)) {
      const affinity = [...leftEdgeIds].filter((edgeId) => rightEdgeIds.has(edgeId)).length;
      if (affinity > 0) affinityByLinePair.set(getLinePairKey(leftLineId, rightLineId), affinity);
    }
  }
  return affinityByLinePair;
};

const getEdgeSeparationCost = (
  lineIds: readonly string[],
  affinityByLinePair: ReadonlyMap<string, number>,
): number => {
  let cost = 0;
  for (let leftIndex = 0; leftIndex < lineIds.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < lineIds.length; rightIndex += 1) {
      const affinity = affinityByLinePair.get(
        getLinePairKey(lineIds[leftIndex], lineIds[rightIndex]),
      );
      if (affinity) {
        cost += LINE_SEPARATION_WEIGHT * affinity * Math.max(rightIndex - leftIndex - 1, 0);
      }
    }
  }
  return cost;
};

/**
 * Moves of a run of neighbouring lines elsewhere, plus the reversal. Runs, because a group leaving
 * together (S-Bahnen turning north out of the Poststraße) can only cross others as a block.
 */
const getLineOrderMoves = (order: readonly string[]): (readonly string[])[] => {
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
  // A mirrored corridor rights itself in one scorable step.
  if (order.length > 2) moves.push([...order].reverse());
  return moves;
};

/** One corridor's order carried into the next at a stop; read once, since routes fix them. */
type LineOrderHandover = {
  fromEdgeId: string;
  toEdgeId: string;
  nodeId: string;
  /** The lines running from one corridor into the other: what the handover is worth. */
  throughLineIds: ReadonlySet<string>;
};

const getLineOrderHandovers = (
  corridorsByNodeId: ReadonlyMap<string, ReadonlyMap<string, NodeCorridor>>,
  passagesByNodeId: ReadonlyMap<string, readonly NodeLinePassage[]>,
): ReadonlyMap<string, readonly LineOrderHandover[]> => {
  const handoversByEdgeId = new Map<string, LineOrderHandover[]>();
  for (const [nodeId, corridors] of corridorsByNodeId) {
    for (const fromEdgeId of corridors.keys()) {
      for (const toEdgeId of corridors.keys()) {
        if (fromEdgeId === toEdgeId) continue;
        const throughLineIds = new Set(
          (passagesByNodeId.get(nodeId) ?? [])
            .filter(
              (passage) =>
                passage.edgeIds.includes(fromEdgeId) && passage.edgeIds.includes(toEdgeId),
            )
            .map(({ lineId }) => lineId),
        );
        if (throughLineIds.size === 0) continue;
        const handovers = handoversByEdgeId.get(fromEdgeId) ?? [];
        handovers.push({ fromEdgeId, toEdgeId, nodeId, throughLineIds });
        handoversByEdgeId.set(fromEdgeId, handovers);
      }
    }
  }
  return handoversByEdgeId;
};

/**
 * Whether lines running between two corridors keep their lane numbers: measured the same way from
 * the stop they reverse; measured opposite ways (a straight) they match.
 */
const keepsLaneOrder = (arriving: NodeCorridor, leaving: NodeCorridor): boolean =>
  arriving.laneDirection !== leaving.laneDirection;

/**
 * Carries orders outwards across stops so no line crosses another where it runs through;
 * per-corridor moves cannot fix a group turning off together. The busiest handover goes first;
 * lines joining at a stop keep their places.
 */
const propagateLineOrders = (
  busiestFirst: readonly ZentrumSchematicObservedEdge[],
  handoversByEdgeId: ReadonlyMap<string, readonly LineOrderHandover[]>,
  corridorsByNodeId: ReadonlyMap<string, ReadonlyMap<string, NodeCorridor>>,
  orderByEdgeId: ReadonlyMap<string, readonly string[]>,
  firstSeedEdgeId?: string,
): Map<string, readonly string[]> => {
  const settled = new Map<string, readonly string[]>();
  const open: LineOrderHandover[] = [];
  const settle = (edgeId: string, order: readonly string[]) => {
    settled.set(edgeId, order);
    for (const handover of handoversByEdgeId.get(edgeId) ?? []) {
      if (!settled.has(handover.toEdgeId)) open.push(handover);
    }
  };
  if (firstSeedEdgeId) settle(firstSeedEdgeId, orderByEdgeId.get(firstSeedEdgeId) ?? []);

  while (settled.size < busiestFirst.length) {
    let best: LineOrderHandover | undefined;
    for (const handover of open) {
      if (settled.has(handover.toEdgeId)) continue;
      if (
        !best ||
        handover.throughLineIds.size > best.throughLineIds.size ||
        (handover.throughLineIds.size === best.throughLineIds.size &&
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

    const arriving = corridorsByNodeId.get(best.nodeId)?.get(best.fromEdgeId);
    const leaving = corridorsByNodeId.get(best.nodeId)?.get(best.toEdgeId);
    const base = orderByEdgeId.get(best.toEdgeId) ?? [];
    const through = best.throughLineIds;
    const carried = (settled.get(best.fromEdgeId) ?? []).filter((lineId) => through.has(lineId));
    const derived =
      arriving && leaving && keepsLaneOrder(arriving, leaving) ? carried : [...carried].reverse();
    const next = [...base];
    const places = base.flatMap((lineId, index) => (through.has(lineId) ? [index] : []));
    derived.forEach((lineId, index) => {
      if (places[index] !== undefined) next[places[index]] = lineId;
    });
    // The same array where nothing moved, so the search sees by identity what was disturbed.
    settle(best.toEdgeId, next.every((lineId, index) => lineId === base[index]) ? base : next);
  }
  return settled;
};

/**
 * The lane order on every corridor (LOOM's line ordering): crossings at stops plus lanes left
 * between companions, scored at stops so a turn's far end counts. A move is taken only if it lowers
 * the cost; ties go to the lower-reading order, so the search cannot cycle and is deterministic.
 */
export const getTrackLineIdsByEdgeId = (
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
  const corridorsByNodeId = new Map(
    [...nodesById].map(([nodeId, node]) => [nodeId, getNodeCorridors(node, edges)] as const),
  );
  // One passage per lane at a stop: where a trunk and branch part, the lane carries on into both.
  const edgeIdsByTrackId = new Map<string, Set<string>>();
  const passageEdgeIdsByNodeId = new Map<string, Map<string, Set<string>>>();
  for (const linePath of linePaths) {
    const pathEdgeIds = edgeIdsByTrackId.get(linePath.trackId) ?? new Set<string>();
    for (const edgeId of getLinePathEdgeIds(linePath)) pathEdgeIds.add(edgeId);
    edgeIdsByTrackId.set(linePath.trackId, pathEdgeIds);
    for (const [index, node] of linePath.nodes.entries()) {
      const edgeIds = [linePath.nodes[index - 1], linePath.nodes[index + 1]]
        .filter((neighbor): neighbor is ZentrumSchematicNode => neighbor !== undefined)
        .map((neighbor) => getEdgeKey(node.id, neighbor.id));
      const passageEdgeIdsByTrackId =
        passageEdgeIdsByNodeId.get(node.id) ?? new Map<string, Set<string>>();
      const passageEdgeIds = passageEdgeIdsByTrackId.get(linePath.trackId) ?? new Set<string>();
      for (const edgeId of edgeIds) passageEdgeIds.add(edgeId);
      passageEdgeIdsByTrackId.set(linePath.trackId, passageEdgeIds);
      passageEdgeIdsByNodeId.set(node.id, passageEdgeIdsByTrackId);
    }
  }
  const passagesByNodeId = new Map<string, readonly NodeLinePassage[]>(
    [...passageEdgeIdsByNodeId].map(([nodeId, passageEdgeIdsByTrackId]) => [
      nodeId,
      [...passageEdgeIdsByTrackId].map(([lineId, passageEdgeIds]) => ({
        lineId,
        edgeIds: [...passageEdgeIds],
      })),
    ]),
  );

  const handoversByEdgeId = getLineOrderHandovers(corridorsByNodeId, passagesByNodeId);
  const busiestFirst = [...edges].sort(
    (left, right) =>
      (orderByEdgeId.get(right.id)?.length ?? 0) - (orderByEdgeId.get(left.id)?.length ?? 0) ||
      left.id.localeCompare(right.id),
  );

  const affinityByLinePair = getLineAffinities(edgeIdsByTrackId);
  const lineCrossingsByNodeId = new Map(
    [...corridorsByNodeId].map(
      ([nodeId, corridors]) =>
        [nodeId, getNodeLineCrossings(corridors, passagesByNodeId.get(nodeId) ?? [])] as const,
    ),
  );
  const countCrossingsAt = (
    nodeId: string,
    orders: ReadonlyMap<string, readonly string[]>,
  ): number => countNodeLineCrossings(lineCrossingsByNodeId.get(nodeId) ?? [], orders);
  const searchOrder = [...edges].sort((left, right) => left.id.localeCompare(right.id));
  const compareDrawings = (
    left: ReadonlyMap<string, readonly string[]>,
    right: ReadonlyMap<string, readonly string[]>,
  ): number => {
    for (const edge of searchOrder) {
      const leftOrder = left.get(edge.id);
      const rightOrder = right.get(edge.id);
      // A move leaves every corridor it did not touch holding the very same array.
      if (leftOrder === rightOrder) continue;
      const compared = compareLineOrders(leftOrder ?? [], rightOrder ?? []);
      if (compared !== 0) return compared;
    }
    return 0;
  };

  orderByEdgeId = propagateLineOrders(
    busiestFirst,
    handoversByEdgeId,
    corridorsByNodeId,
    orderByEdgeId,
  );

  // The cost is kept in parts, so scoring a candidate re-counts only the stops it disturbed.
  const crossingCountByNodeId = new Map<string, number>();
  const separationByEdgeId = new Map<string, number>();
  let cost = 0;
  const readCost = (orders: ReadonlyMap<string, readonly string[]>) => {
    cost = 0;
    for (const nodeId of corridorsByNodeId.keys()) {
      const crossings = countCrossingsAt(nodeId, orders);
      crossingCountByNodeId.set(nodeId, crossings);
      cost += LINE_CROSSING_WEIGHT * crossings;
    }
    for (const edge of searchOrder) {
      const separation = getEdgeSeparationCost(orders.get(edge.id) ?? [], affinityByLinePair);
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
        getEdgeSeparationCost(candidate.get(edge.id) ?? [], affinityByLinePair) -
        (separationByEdgeId.get(edge.id) ?? 0);
    }
    for (const nodeId of new Set(moved.flatMap(({ from, to }) => [from.id, to.id]))) {
      candidateCost +=
        LINE_CROSSING_WEIGHT *
        (countCrossingsAt(nodeId, candidate) - (crossingCountByNodeId.get(nodeId) ?? 0));
    }
    return candidateCost;
  };

  const withOrder = (
    orders: ReadonlyMap<string, readonly string[]>,
    edgeId: string,
    order: readonly string[],
  ): Map<string, readonly string[]> => new Map(orders).set(edgeId, order);

  /**
   * One sweep, taking the best move on each corridor in turn. Carried moves escape plateaus but
   * cost far more, so they are swept only once local moves have nothing left.
   */
  const sweep = (carries: boolean): boolean => {
    let improved = false;
    for (const edge of searchOrder) {
      const order = orderByEdgeId.get(edge.id) ?? [];
      if (order.length < 2) continue;
      let best = orderByEdgeId;
      let bestCost = cost;
      for (const candidate of getLineOrderMoves(order)) {
        const moved = withOrder(orderByEdgeId, edge.id, candidate);
        const drawing = carries
          ? propagateLineOrders(busiestFirst, handoversByEdgeId, corridorsByNodeId, moved, edge.id)
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

  for (let pass = 0; pass < LINE_ORDER_PASS_LIMIT; pass += 1) {
    if (!sweep(false) && !sweep(true)) break;
  }
  return orderByEdgeId;
};

/** Whether two corridors meeting at a stop are one straight through it (exact: coordinates are). */
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
 * Each corridor's band offset from its middle, in lanes, so a lane running straight through a stop
 * keeps its distance from the middle (no stepping aside along the Kaiserstraße). Each straight pair
 * of corridors votes per through lane; the majority wins, ties shift nothing. The busiest corridor
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
      const arrivingLane = arriving.trackLineIds.indexOf(linePath.trackId);
      const leavingLane = leaving.trackLineIds.indexOf(linePath.trackId);
      if (arrivingLane < 0 || leavingLane < 0) continue;
      // b_leaving - b_arriving, from o_arriving(arrivingLane) = o_leaving(leavingLane).
      const delta =
        arrivingLane -
        leavingLane +
        (leaving.trackLineIds.length - arriving.trackLineIds.length) / 2;
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

  // Each straight is anchored at its busiest corridor and its offsets carried outwards from there.
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
      candidate.trackLineIds.length > widest.trackLineIds.length ||
      (candidate.trackLineIds.length === widest.trackLineIds.length && candidate.id < widest.id)
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
