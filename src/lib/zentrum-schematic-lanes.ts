/**
 * Which lane of a corridor each line is drawn in, and where that corridor's band of lanes sits.
 *
 * The plan's hardest question, and the one thing in it that is solved rather than read: lines
 * sharing a corridor have to keep their order along it, so that a line is one stroke from end to
 * end and two lines travelling together stay side by side. The ordering follows LOOM — a cost over
 * crossings and separations, improved pass by pass until it settles.
 */
import {
  type SchematicPoint,
  type ZentrumSchematicLanedEdge,
  type ZentrumSchematicLinePath,
  type ZentrumSchematicNode,
  type ZentrumSchematicObservedEdge,
  crossProduct,
  dotProduct,
  getEdgeKey,
  getUnitVector,
  orientCorridorRun,
} from "./zentrum-schematic-plan";
/**
 * LOOM's relative weights for the two things a line ordering can get wrong: a crossing at a stop,
 * and a lane left standing between two lines that travel together. Both are counted into one cost
 * rather than ranked, so a drawing may accept a crossing to keep a shared route whole.
 */
const LINE_CROSSING_WEIGHT = 4;
const LINE_SEPARATION_WEIGHT = 3;

/**
 * How many times the whole drawing is swept looking for a better order.
 *
 * Every move taken lowers the pair (cost, how the orders read), so the search ends on its own; the
 * limit is only here so that a drawing far larger than the Zentrum could not make a refresh slow.
 */
const LINE_ORDER_PASS_LIMIT = 24;

/**
 * One lane's passage through one stop, named by the corridors it uses there.
 *
 * A lane rather than a line, because a trunk drawn with its branches is one lane: `lineId` is the
 * lane's name, and the corridors are every one its lines were observed using here. A lane that
 * splits at the dot therefore names more than two, which the tests below read as running through.
 *
 * Two corridors is a line running through: it holds a lane on each, and can cross its companions
 * between them. One is a line whose drawn pattern ends here. That is not the same as crossing
 * nothing: the pattern is drawn into the middle of the dot, so a line swinging round the dot from
 * one corridor to another passes over everything standing on the side it swings towards.
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
 * How far a line turns at a stop, arriving along one corridor and leaving along another.
 *
 * Measured in the frame the arriving corridor sets: straight on is zero, and a turn is signed the
 * same way lane numbers are, so a line's turn and its lane can be compared directly. A line whose
 * drawn pattern ends at the dot turns nowhere and reads zero, which is what puts it in the path of
 * anything swinging round the dot rather than out of the way of it.
 */
const getCorridorTurn = (corridor: NodeCorridor, exit: NodeCorridor | undefined): number => {
  if (!exit) return 0;
  const arriving = { x: -corridor.outward.x, y: -corridor.outward.y };
  const rightwards = { x: -corridor.outward.y, y: corridor.outward.x };
  return Math.atan2(dotProduct(exit.outward, rightwards), dotProduct(exit.outward, arriving));
};

/**
 * One pair of lines at one stop, and what their lanes have to do there for them not to cross.
 *
 * Everything turns on how many corridors the pair shares at the stop. Sharing both is a pair
 * running side by side through it: lane numbers are counted outwards from the dot on each corridor,
 * so the pair keep their order exactly by reversing their numbers, and cross when they do not.
 * Sharing one is a pair that parts here, and it crosses when the one standing on the left leaves to
 * the right. Sharing none is two lines that never meet a kerb together, which no order can part.
 *
 * Which of those a pair is, and which way each of them turns, is fixed by the plan's geometry and
 * the routes the trips state -- never by the lanes. So each pair is read once into the test its
 * lanes must pass, and answering it afterwards is two lane numbers and a sign.
 */
type NodeLineCrossing = {
  lineIds: readonly [string, string];
  /** The corridors the pair's lanes are read on, and which way each numbers them. */
  reads: readonly { edgeId: string; laneDirection: number }[];
  /** Where the pair parts, which way the second line turns away from the first. */
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
    const compared = left[index].localeCompare(right[index], "de", { numeric: true });
    if (compared !== 0) return compared;
  }
  return left.length - right.length;
};

/**
 * How much two lines want to be neighbours, from how much of their drawn route they share.
 *
 * Charging for every lane standing between a pair makes a long common route a block that short
 * workings weave around rather than through, which is why line 1 and S2 stay together on the
 * corridors they share without either being named anywhere.
 *
 * Read between lanes rather than between lines: a trunk drawn with its branches is one thing to
 * keep beside its neighbours, and it wants to be beside them wherever either branch runs.
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
 * Every order reachable from this one by lifting a run of neighbouring lines out and putting it
 * back elsewhere, plus the order turned end for end.
 *
 * A single line is the commonest case, but it is not enough on its own. Where a group of services
 * shares a corridor and then leaves it together -- the six S-Bahnen turning north out of the
 * Poststraße while the trams carry on east -- moving one of them past the trams costs a crossing
 * with each of the five it left behind, so every single-line move looks worse than standing still
 * and the whole group stays on the wrong side. Offering the run as one move lets the group cross
 * together, which is the move a person drawing this by hand would make.
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
  // A corridor sitting the wrong way round is one decision, not one per line it carries: offering
  // the reversal lets a mirrored straight right itself in a single step that can be scored.
  if (order.length > 2) moves.push([...order].reverse());
  return moves;
};

/**
 * One corridor's order carried into the next, at the stop where the two meet.
 *
 * Which lines run through a stop from one corridor into another is fixed by the routes the trips
 * state, so every handover the drawing has is read once and then only chosen between.
 */
type LineOrderHandover = {
  fromEdgeId: string;
  toEdgeId: string;
  nodeId: string;
  /** The lines running from the one corridor into the other, which is what the handover is worth. */
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
 * Whether two corridors meeting at a stop carry the lines running between them in the same order.
 *
 * Lane numbers are counted along each corridor's own normal, which points one way at the stop at
 * each of its ends. Where two corridors are measured the same way round from this stop, the lines
 * running through keep their order only by reversing their numbers; where they are measured
 * opposite ways, the numbers read alike. A straight is the second case, which is why a line keeps
 * its lane through a stop it merely calls at.
 */
const keepsLaneOrder = (arriving: NodeCorridor, leaving: NodeCorridor): boolean =>
  arriving.laneDirection !== leaving.laneDirection;

/**
 * A drawing in which no line crosses another at a stop it merely runs through.
 *
 * The refinement that follows can only lower the cost, so it can only ever move one corridor at a
 * time -- and a group of services that turns off together, the six S-Bahnen leaving the Poststraße
 * northwards, cannot be put right one corridor at a time. Reversing their lanes on the corridor
 * they turn into repairs the turn and breaks the corridor beyond it by exactly as much, so every
 * single step looks no better than standing still and the group stays woven. Carrying an order
 * outwards settles all of that at once; what is then left to decide is which side of the drawing
 * each group belongs on, which can be decided one corridor at a time.
 *
 * The order is carried across the busiest handover still open rather than in any fixed sweep, so
 * where two corridors cannot both be made consistent with a third it is the pair with the fewest
 * lines running through that gives way. Lines that join at a stop keep the places they held, so a
 * service the carrying has nothing to say about is neither promoted nor buried by it. Naming a
 * corridor to start from is how a move made on that corridor is carried out across the rest.
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
    // Keeping the array it came from where nothing moved is what lets the search recognise, by
    // identity alone, which corridors a carried order actually disturbed.
    settle(best.toEdgeId, next.every((lineId, index) => lineId === base[index]) ? base : next);
  }
  return settled;
};

/**
 * The lane order on every corridor, solved for the drawing as a whole.
 *
 * This is the line-ordering problem LOOM states, at the size the Zentrum is: every corridor carries
 * an order of its lines, and a drawing costs the crossings those orders force at the stops plus the
 * lanes they leave standing between lines that travel together. Ordering each corridor on its own
 * -- by which side its lines branched off it, as this once did -- cannot see what an order costs at
 * the far end of a turn: two lines swinging together out of the Kaiserstraße into the Kriegsstraße
 * were ordered once by what the level corridor wanted and again by what the upright one wanted, and
 * crossed wherever the two answers disagreed. Scoring stops rather than corridors is what removes
 * that whole class of fault: an order is now chosen knowing what it costs on every corridor it
 * meets, however far round the plan the consequence lands.
 *
 * A move lifts a run of neighbouring lines into another place on one corridor. It is offered twice
 * over: once on its own, and once carried out across every corridor the change reaches, which is
 * the version that can move a group of services bodily across a drawing rather than one lane at a
 * time. Either is taken only while it lowers the cost, ties going to the order that reads lower, so
 * the search cannot cycle and the same boards always draw the same plan.
 */
export const getTrackLineIdsByEdgeId = (
  edges: readonly ZentrumSchematicObservedEdge[],
  linePaths: readonly ZentrumSchematicLinePath[],
): ReadonlyMap<string, readonly string[]> => {
  const trackIdByLineId = new Map(linePaths.map(({ lineId, trackId }) => [lineId, trackId]));
  let orderByEdgeId = new Map<string, readonly string[]>(
    edges.map((edge) => [
      // A line observed on a corridor whose drawn pattern runs elsewhere reserves no lane here,
      // exactly as it reserves no drawing; ordering only ever arranges the lines actually drawn.
      // What is arranged is lanes: a trunk and the branches drawn with it ask for one place here,
      // and get one lane's width of the corridor rather than one each.
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
  // One passage per lane at a stop, and one set of edges per lane: a trunk and its branch arrive
  // together and hold one place, and where they part the lane is what carries on into both
  // corridors, which is exactly what a trunk with a branch off it does on the drawing.
  const edgeIdsByTrackId = new Map<string, Set<string>>();
  const passageEdgeIdsByNodeId = new Map<string, Map<string, Set<string>>>();
  for (const linePath of linePaths) {
    const pathEdgeIds = edgeIdsByTrackId.get(linePath.trackId) ?? new Set<string>();
    for (const edgeId of getLinePathEdgeIds(linePath)) pathEdgeIds.add(edgeId);
    edgeIdsByTrackId.set(linePath.trackId, pathEdgeIds);
    for (const [index, node] of linePath.nodes.entries()) {
      const edgeIds = [linePath.nodes[index - 1], linePath.nodes[index + 1]]
        .filter((neighbour): neighbour is ZentrumSchematicNode => neighbour !== undefined)
        .map((neighbour) => getEdgeKey(node.id, neighbour.id));
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
      const compared = compareLineOrders(left.get(edge.id) ?? [], right.get(edge.id) ?? []);
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

  // The cost is kept as the parts it is made of, because a move only ever disturbs some of them.
  // Scoring a candidate then means re-counting the stops on the corridors it actually moved, which
  // is what makes offering every move on every corridor affordable at all.
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
   * One sweep of the drawing, taking the best move offered on each corridor in turn.
   *
   * Carrying a move outwards is what gets the search off a plateau, but it is also much the dearer
   * of the two, so a sweep that only moves lanes on the corridor in hand is tried first and the
   * carried sweep is kept for when that has nothing left to offer.
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

/**
 * Whether two corridors meeting at a stop are one straight through it.
 *
 * Both corridors run through the stop in one line -- the way the Kaiserstraße runs through the
 * Europaplatz and the Marktplatz -- rather than turning there. The authored coordinates are exact,
 * so the test is exact: collinear and pointing the same way through the stop.
 */
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
 * How far each corridor's band of lanes sits off the middle of its corridor.
 *
 * Laid out on their own, every corridor centres its band on its own middle -- which re-centres the
 * lanes at every stop. On a straight that is the one thing the drawing must not do: the
 * Kaiserstraße is one corridor to the eye, and a line running along it -- the 1 from the
 * Mühlburger Tor to the Durlacher Tor, say -- reads as one line only while it holds one line
 * across each stop it merely calls at. Corridor by corridor, it steps half a lane's width aside at
 * every one of them, and where a corridor carries fewer lines than its neighbours the whole
 * through band steps with it.
 *
 * So a lane that runs straight through a stop keeps, across that stop, the distance from the
 * corridor middle it arrived with. Each pair of corridors meeting at a stop as one straight states
 * the offset between their bands that does this for their through lanes -- and where the through
 * lanes disagree, because lanes turning off the straight stand between them and make two of them
 * state different offsets, the majority is taken, ties to standing still. A corridor then takes
 * its offset from the straight it belongs to: the busiest corridor of the straight keeps its
 * middle -- it is the band a reader is following and the one the stop marks are sized to -- and
 * every other corridor of the straight hangs its lanes off the through lanes' continuing
 * positions, so a narrower straight hangs from the top of its neighbours' band rather than
 * re-centring its own. A corridor belonging to no straight keeps its band on the middle.
 *
 * One offset per straight is as much as the drawing can hold: the lanes of a corridor are laid one
 * lane's width apart, so aligning one through lane aligns them all or aligns none. Where a pair's
 * through lanes disagree, the losers keep their order and move as smoothly as a lane can -- the
 * bend a straight join draws -- while the winners hold their line.
 */
export const getTrackBandOffsetByEdgeId = (
  edges: readonly ZentrumSchematicLanedEdge[],
  linePaths: readonly ZentrumSchematicLinePath[],
  trackWidth: number,
): ReadonlyMap<string, number> => {
  const edgeById = new Map(edges.map((edge) => [edge.id, edge]));

  // One vote per lane per straight: the offset between the two bands that puts the lane's line
  // where it arrived. Read off the drawn patterns, so a lane turning off the straight at the stop
  // -- present on both corridors only by belonging to a different passage -- votes nowhere.
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
      // The pair is named left to right by edge id, and the vote with it: an edge id carries a
      // separator of its own, so the pair is carried as its ends, never split back apart.
      const leftId = arriving.id < leaving.id ? arriving.id : leaving.id;
      const rightId = leftId === arriving.id ? leaving.id : arriving.id;
      const pairKey = `${leftId}\u0000${rightId}`;
      const voteKey = `${pairKey}\u0000${linePath.trackId}`;
      if (votedLanes.has(voteKey)) continue;
      votedLanes.add(voteKey);
      const arrivingLane = arriving.trackLineIds.indexOf(linePath.trackId);
      const leavingLane = leaving.trackLineIds.indexOf(linePath.trackId);
      if (arrivingLane < 0 || leavingLane < 0) continue;
      // b_leaving - b_arriving, from o_arriving(arrivingLane) = o_leaving(leavingLane), where a
      // band's own lanes are one track width apart either side of its offset.
      const delta =
        (arrivingLane -
          leavingLane +
          (leaving.trackLineIds.length - arriving.trackLineIds.length) / 2) *
        trackWidth;
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

  const neighboursByEdgeId = new Map<string, { otherId: string; delta: number }[]>();
  const addNeighbour = (edgeId: string, otherId: string, delta: number) => {
    const neighbours = neighboursByEdgeId.get(edgeId) ?? [];
    neighbours.push({ otherId, delta });
    neighboursByEdgeId.set(edgeId, neighbours);
  };
  for (const { leftId, rightId, votes } of votesByPairKey.values()) {
    const [winningDelta] = [...votes.entries()].sort(
      ([leftDelta, leftCount], [rightDelta, rightCount]) =>
        rightCount - leftCount ||
        Math.abs(leftDelta) - Math.abs(rightDelta) ||
        leftDelta - rightDelta,
    )[0];
    addNeighbour(leftId, rightId, winningDelta);
    addNeighbour(rightId, leftId, -winningDelta);
  }

  // Each straight is anchored once, at its busiest corridor: everything hangs off that, so the
  // offset is carried outwards from it and never argued twice. Corridors no straight ties down are
  // absent here and stay centred.
  const bandOffsetByEdgeId = new Map<string, number>();
  for (const edge of edges) {
    if (bandOffsetByEdgeId.has(edge.id)) continue;
    const component: ZentrumSchematicLanedEdge[] = [];
    const open = [edge];
    const reached = new Set<string>([edge.id]);
    while (open.length > 0) {
      const current = open.pop()!;
      component.push(current);
      for (const { otherId } of neighboursByEdgeId.get(current.id) ?? []) {
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
      for (const { otherId, delta } of neighboursByEdgeId.get(current.id) ?? []) {
        if (bandOffsetByEdgeId.has(otherId)) continue;
        bandOffsetByEdgeId.set(otherId, bandOffsetByEdgeId.get(current.id)! + delta);
        const other = edgeById.get(otherId);
        if (other) queue.push(other);
      }
    }
  }
  return bandOffsetByEdgeId;
};
