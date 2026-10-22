/**
 * What is running through the Zentrum, read onto the plan: which corridors today's journeys state,
 * which lane each line holds, where bays stand, and where each vehicle is. A corridor no journey
 * states is not drawn, so a line that stops running leaves the plan by itself.
 */
import type { StopEvent, Call } from "../data/transit-types";
import {
  collapseTurnaroundCalls,
  getCallInstant,
  statesDatedJourneyEnd,
  statesDatedJourneyStart,
} from "./calls";
import { getDistinctTimetableJourneys, getDatedJourneyMarkKey } from "./journeys";
import {
  getDatedJourneyPlacement,
  type DatedJourneyMotions,
  type DatedJourneyPlacementMotion,
  type DatedJourneyPlacementPhase,
  type DatedJourneySegmentTrajectory,
} from "./vehicle-positioning";
import { toLocalMeters } from "./geo";
import { getOctilinearDirections } from "./bay-runs";
import { createSchematicBoardingReading } from "./schematic-boarding-places";
import { compareLineIds } from "./line-families";
import { findTurnarounds, type TurnaroundIndex } from "./line-turnarounds";
import {
  type SchematicPoint,
  type ZentrumSchematicBoardingPlace,
  type ZentrumSchematicEdge,
  type ZentrumSchematicLanedEdge,
  type ZentrumSchematicLinePath,
  type ZentrumSchematicNode,
  type ZentrumSchematicObservedEdge,
  compareLineIdsNaturally,
  getEdgeKey,
  getTrackIdByLineId,
  getTrackOffset,
  getZentrumSchematicRoutes,
  getZentrumSchematicTrackWidth,
  isRailStopEvent,
  BAY_RUN_VECTORS,
  ZENTRUM_SCHEMATIC_GRID,
  orientCorridorRun,
} from "./zentrum-schematic-plan";
import {
  type ZentrumSchematicDrawnPath,
  getZentrumSchematicDrawnPaths,
  getZentrumSchematicPathSteps,
  getZentrumSchematicVehiclePathPlacement,
  getZentrumSchematicStopStretchKey,
  getZentrumSchematicVehiclePaths,
  joinZentrumSchematicCorridorPaths,
  orientZentrumSchematicCorridorPath,
  orientZentrumSchematicStopStretch,
  trimZentrumSchematicCorridorPath,
  type ZentrumSchematicCorridorPath,
  type ZentrumSchematicStopStretch,
} from "./zentrum-schematic-paths";
import { getTrackBandOffsetByEdgeId, getTrackIdsByEdgeId } from "./zentrum-schematic-lanes";
import {
  getZentrumSchematicStopMarks,
  type ZentrumSchematicStopMark,
} from "./zentrum-schematic-stops";

export type ZentrumSchematicVehicle = {
  id: string;
  /** The dated journey the mark stands for. */
  stopEvent: StopEvent;
  markerKey?: string;
  lineId: string;
  destination: string;
  from: ZentrumSchematicNode;
  to: ZentrumSchematicNode;
  progress: number;
  phase?: DatedJourneyPlacementPhase;
  /** Every drawn corridor from the one the vehicle is on through the end of its dated journey. */
  aheadCorridorIds: readonly string[];
  /** The drawn stops the dated journey still calls at, in order, from the one its link leaves. */
  aheadStops: readonly ZentrumSchematicAheadStop[];
  x: number;
  y: number;
  angle: number;
  /**
   * The stretch of its line's lane the mark follows, turned the way this dated journey travels it.
   */
  path: ZentrumSchematicVehiclePath;
  /** Only travelled motion is animated as a journey; a placement is painted where it belongs. */
  motion: DatedJourneyPlacementMotion;
  /** See `DatedJourneyPlacement.placedAfterLinks`. */
  placedAfterLinks?: number;
  /** The curve the mark is animated along between ticks, where the placement planned one. */
  trajectory?: DatedJourneySegmentTrajectory;
};

/** One drawn stop ahead of a vehicle, as its journey states it. */
export type ZentrumSchematicAheadStop = {
  nodeId: string;
  /** The call the dated journey leaves the stop by: the last of a complex's calls. */
  call: Call;
  /** When the dated journey is expected to leave the stop. */
  departsAt?: number;
  /** Where the stop stands along the mark's path, if the path runs through it. */
  pathProgress?: number;
};

/**
 * The stretch of lane a mark follows, in the dated journey's direction. A link inside one complex
 * (its two tunnel calls) runs from one place's capsule to the other's, or is a single point where
 * the line crosses no two.
 */
export type ZentrumSchematicVehiclePath = {
  /** The first point is where the mark stands at progress 0. */
  points: readonly SchematicPoint[];
  /** Each point's share of the path's length, ascending to 1. */
  steps: readonly number[];
  /** The corridors making up the path, with their ranges of its progress. */
  corridorRanges: readonly ZentrumSchematicVehiclePathCorridorRange[];
};

export type ZentrumSchematicVehiclePathCorridorRange = {
  corridorId: string;
  start: number;
  end: number;
};

/** The plan as laid out for what runs over it: everything that holds whatever the lane width. */
export type ZentrumSchematicLayout = {
  nodesById: ReadonlyMap<string, ZentrumSchematicNode>;
  resolveNodeId: (call: Call) => string | undefined;
  placesByStopId: ReadonlyMap<string, readonly ZentrumSchematicBoardingPlace[]>;
  /** Identifies the layout: two layouts with one key place the same lanes. */
  layoutKey: string;
  /** The segments drawn: corridors, split at junctions. */
  edges: readonly ZentrumSchematicEdge[];
  /** Every corridor a drawn dated journey states, stop to stop. */
  corridors: readonly ZentrumSchematicObservedEdge[];
  linePaths: readonly ZentrumSchematicLinePath[];
  /**
   * Other paths of a line, drawn in its lanes only while one of their dated journeys is on the
   * plan.
   */
  branchPaths: readonly ZentrumSchematicBranchPath[];
  /** Every drawn line, in legend order. */
  lineIds: readonly string[];
  lineIdsByNodeId: ReadonlyMap<string, readonly string[]>;
  /** The stops with more than one place to stand, and those places. */
  boardingPlacesByNodeId: ReadonlyMap<string, readonly ZentrumSchematicBoardingPlace[]>;
};

/** A line's path beyond its drawn one, and the dated journeys taking it. */
export type ZentrumSchematicBranchPath = ZentrumSchematicLinePath & {
  datedJourneyKeys: readonly string[];
};

/** The layout drawn at one lane width, with every geometry that follows from that. */
export type ZentrumSchematicReading = ZentrumSchematicLayout & {
  /** The lane width, which is also the lane pitch, so neighbouring lanes meet exactly. */
  trackWidth: number;
  /** The strokes the drawing paints. */
  drawnPaths: readonly ZentrumSchematicDrawnPath[];
  /** The stretch a mark follows, by line and corridor, so placing a vehicle is a lookup. */
  vehiclePathsByLineId: ReadonlyMap<string, ReadonlyMap<string, ZentrumSchematicCorridorPath>>;
  /** The stretch across a stop between two of its capsules, by line and stretch key. */
  stopStretchesByLineId: ReadonlyMap<string, ReadonlyMap<string, ZentrumSchematicStopStretch>>;
  stopMarks: readonly ZentrumSchematicStopMark[];
};

const getPathKey = (nodes: readonly ZentrumSchematicNode[]): string => {
  const forward = nodes.map(({ id }) => id).join("\u0000");
  const reverse = nodes
    .map(({ id }) => id)
    .reverse()
    .join("\u0000");
  return forward < reverse ? forward : reverse;
};

const sortById = (
  left: ZentrumSchematicNode,
  right: ZentrumSchematicNode,
): readonly [ZentrumSchematicNode, ZentrumSchematicNode] =>
  left.id < right.id ? [left, right] : [right, left];

/** How far a line entering or leaving the plan runs past its last stop. */
const ZENTRUM_SCHEMATIC_EXIT_LENGTH = ZENTRUM_SCHEMATIC_GRID;

/**
 * A run of calls inside the plan, and where its journey goes beyond either end: east and
 * south.
 */
type ObservedSchematicPath = {
  nodes: ZentrumSchematicNode[];
  entry?: { heading?: SchematicPoint };
  exit?: { heading?: SchematicPoint };
};

const getHeading = (from: Call, to: Call): SchematicPoint | undefined => {
  if (
    from.latitude === undefined ||
    from.longitude === undefined ||
    to.latitude === undefined ||
    to.longitude === undefined
  ) {
    return undefined;
  }
  const offset = toLocalMeters(to.latitude, to.longitude, {
    latitude: from.latitude,
    longitude: from.longitude,
  });
  return Math.hypot(offset.x, offset.y) > 0 ? { x: offset.x, y: -offset.y } : undefined;
};

/**
 * The stub a line enters or leaves the plan by: along the stop's bays, else the way the journey
 * really goes, snapped octilinear; clear of the corridors drawn there, square to them if it can.
 */
const getStubNode = (
  node: ZentrumSchematicNode,
  inside: ZentrumSchematicNode,
  heading: SchematicPoint | undefined,
  taken: readonly SchematicPoint[],
): ZentrumSchematicNode => {
  const run = node.bayRun && BAY_RUN_VECTORS[node.bayRun];
  const along = run && Math.sign(run.x * (node.x - inside.x) + run.y * (node.y - inside.y));
  const toward = heading ?? { x: node.x - inside.x, y: node.y - inside.y };
  const candidates = [
    ...(run && along ? [{ x: run.x * along, y: run.y * along }] : []),
    ...getOctilinearDirections(toward.x, toward.y),
  ];
  const turn = (direction: SchematicPoint) =>
    Math.min(
      Math.PI,
      ...taken.map((other) =>
        Math.acos(
          Math.max(
            -1,
            Math.min(
              1,
              (direction.x * other.x + direction.y * other.y) /
                Math.hypot(direction.x, direction.y) /
                Math.hypot(other.x, other.y),
            ),
          ),
        ),
      ),
    );
  const direction =
    candidates.find((one) => turn(one) >= Math.PI / 2 - 1e-6) ??
    candidates.find((one) => turn(one) > 1e-6) ??
    candidates[0];
  // One length whichever way: a diagonal steps less along each axis.
  const step = Math.round(ZENTRUM_SCHEMATIC_EXIT_LENGTH / Math.hypot(direction.x, direction.y));
  const x = node.x + direction.x * step;
  const y = node.y + direction.y * step;
  return { id: `exit:${node.id}:${x},${y}`, label: "", x, y, isJunction: true };
};

const getStopEventSchematicPaths = (
  stopEvent: StopEvent,
  boarding: ReturnType<typeof createSchematicBoardingReading>,
): ObservedSchematicPath[] => {
  const paths: ObservedSchematicPath[] = [];
  let path: ZentrumSchematicNode[] = [];
  let firstCall: Call | undefined;
  let lastCall: Call | undefined;
  let outsideBefore: Call | undefined;
  const finishPath = (outsideAfter: Call | undefined) => {
    if (path.length >= 2) {
      paths.push({
        nodes: path,
        entry:
          outsideBefore && firstCall
            ? { heading: getHeading(firstCall, outsideBefore) }
            : undefined,
        exit:
          outsideAfter && lastCall ? { heading: getHeading(lastCall, outsideAfter) } : undefined,
      });
    }
    path = [];
  };

  const calls = collapseTurnaroundCalls(stopEvent.calls ?? []);
  for (const [index, call] of calls.entries()) {
    const node = boarding.nodesById.get(boarding.resolveNodeId(call) ?? "");
    if (!node) {
      // A dated journey that only turns or starts just outside goes no further: no stub.
      const isLast = index === calls.length - 1 && statesDatedJourneyEnd(call);
      finishPath(isLast ? undefined : call);
      outsideBefore = index === 0 && statesDatedJourneyStart(call) ? undefined : call;
      continue;
    }
    if (path.length === 0) firstCall = call;
    lastCall = call;
    if (path.at(-1)?.id !== node.id) path.push(node);
  }
  finishPath(undefined);
  return paths;
};

/** What the drawn dated journeys state about the plan, before any of it is laid out. */
type ZentrumSchematicObservation = Pick<
  ZentrumSchematicLayout,
  "nodesById" | "resolveNodeId" | "placesByStopId" | "branchPaths"
> & {
  /** Every segment drawn, in id order so the same corridors always read alike. */
  edges: readonly ZentrumSchematicObservedEdge[];
  corridors: readonly ZentrumSchematicObservedEdge[];
  linePaths: readonly ZentrumSchematicLinePath[];
  lineIdsByNodeId: ReadonlyMap<string, readonly string[]>;
  boardingPlacesByNodeId: ReadonlyMap<string, readonly ZentrumSchematicBoardingPlace[]>;
};

/**
 * The paths the drawn dated journeys state through the plan. Calls count only in adjacent pairs, so
 * a journey leaving and returning invents no shortcut, and an unknown call breaks the path. A
 * corridor is drawn over one segment, or several through a junction; the layout sees only segments.
 */
const observeZentrumSchematic = (
  drawnVehicles: readonly StopEvent[],
): ZentrumSchematicObservation => {
  const lineIdsByCorridorKey = new Map<string, Set<string>>();
  const corridorByKey = new Map<string, readonly [ZentrumSchematicNode, ZentrumSchematicNode]>();
  const pathsByLineId = new Map<
    string,
    Map<string, { nodes: readonly ZentrumSchematicNode[]; datedJourneyKeys: Set<string> }>
  >();

  const drawnStopEvents = getDistinctTimetableJourneys(drawnVehicles).filter(
    (stopEvent) => stopEvent.status !== "cancelled" && isRailStopEvent(stopEvent),
  );

  const boarding = createSchematicBoardingReading(drawnStopEvents);
  const observedPaths = drawnStopEvents.flatMap((stopEvent) =>
    getStopEventSchematicPaths(stopEvent, boarding).map((path) => ({ stopEvent, ...path })),
  );
  const innerCorridors = new Map<string, readonly [ZentrumSchematicNode, ZentrumSchematicNode]>();
  for (const { nodes } of observedPaths) {
    for (let index = 1; index < nodes.length; index += 1) {
      innerCorridors.set(
        getEdgeKey(nodes[index - 1].id, nodes[index].id),
        sortById(nodes[index - 1], nodes[index]),
      );
    }
  }
  // Stubs keep off the ways the routed corridors leave each stop.
  const takenByNodeId = new Map<string, SchematicPoint[]>();
  for (const through of getZentrumSchematicRoutes(
    [...innerCorridors.values()],
    [...boarding.nodesById.values()],
  ).values()) {
    for (const [end, next] of [
      [through[0], through[1]],
      [through.at(-1)!, through.at(-2)!],
    ]) {
      const taken = takenByNodeId.get(end.id) ?? [];
      taken.push({ x: next.x - end.x, y: next.y - end.y });
      takenByNodeId.set(end.id, taken);
    }
  }
  for (const { stopEvent, nodes, entry, exit } of observedPaths) {
    const stub = (
      node: ZentrumSchematicNode,
      inside: ZentrumSchematicNode,
      heading?: SchematicPoint,
    ) => getStubNode(node, inside, heading, takenByNodeId.get(node.id) ?? []);
    const path = [
      ...(entry ? [stub(nodes[0], nodes[1], entry.heading)] : []),
      ...nodes,
      ...(exit ? [stub(nodes.at(-1)!, nodes.at(-2)!, exit.heading)] : []),
    ];
    {
      const paths = pathsByLineId.get(stopEvent.lineId) ?? new Map();
      const pathKey = getPathKey(path);
      const observed = paths.get(pathKey);
      paths.set(pathKey, {
        nodes: observed?.nodes ?? path,
        datedJourneyKeys: (observed?.datedJourneyKeys ?? new Set()).add(
          getDatedJourneyMarkKey(stopEvent),
        ),
      });
      pathsByLineId.set(stopEvent.lineId, paths);
      for (let index = 1; index < path.length; index += 1) {
        const key = getEdgeKey(path[index - 1].id, path[index].id);
        const lineIds = lineIdsByCorridorKey.get(key) ?? new Set<string>();
        lineIds.add(stopEvent.lineId);
        lineIdsByCorridorKey.set(key, lineIds);
        if (!corridorByKey.has(key)) corridorByKey.set(key, sortById(path[index - 1], path[index]));
      }
    }
  }

  const routes = getZentrumSchematicRoutes(
    [...corridorByKey.values()],
    [...boarding.nodesById.values()],
  );
  const route = (nodes: readonly ZentrumSchematicNode[]): readonly ZentrumSchematicNode[] =>
    nodes.flatMap((node, index) => {
      if (index === 0) return [node];
      const through = routes.get(getEdgeKey(nodes[index - 1].id, node.id)) ?? [];
      const forward = through[0]?.id === nodes[index - 1].id ? through : [...through].reverse();
      return forward.length > 2 ? forward.slice(1) : [node];
    });

  const lineIdsByNodeId = new Map<string, Set<string>>();
  const segmentByKey = new Map<string, readonly [ZentrumSchematicNode, ZentrumSchematicNode]>();
  const lineIdsBySegmentKey = new Map<string, Set<string>>();
  for (const [key, lineIds] of lineIdsByCorridorKey) {
    const nodes = routes.get(key) ?? corridorByKey.get(key) ?? [];
    for (const node of [nodes[0], nodes.at(-1)]) {
      if (!node) continue;
      const nodeLineIds = lineIdsByNodeId.get(node.id) ?? new Set<string>();
      for (const lineId of lineIds) nodeLineIds.add(lineId);
      lineIdsByNodeId.set(node.id, nodeLineIds);
    }
    for (let index = 1; index < nodes.length; index += 1) {
      const [left, right] = sortById(nodes[index - 1], nodes[index]);
      const segmentKey = getEdgeKey(left.id, right.id);
      segmentByKey.set(segmentKey, [left, right]);
      const segmentLineIds = lineIdsBySegmentKey.get(segmentKey) ?? new Set<string>();
      for (const lineId of lineIds) segmentLineIds.add(lineId);
      lineIdsBySegmentKey.set(segmentKey, segmentLineIds);
    }
  }
  const toEdges = (
    byKey: ReadonlyMap<string, readonly [ZentrumSchematicNode, ZentrumSchematicNode]>,
    lineIdsByKey: ReadonlyMap<string, ReadonlySet<string>>,
  ): ZentrumSchematicObservedEdge[] =>
    [...byKey]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([id, [from, to]]) => ({
        id,
        from,
        to,
        lineIds: [...(lineIdsByKey.get(id) ?? [])].sort(compareLineIdsNaturally),
      }));
  const edges = toEdges(segmentByKey, lineIdsBySegmentKey);
  const corridors = toEdges(corridorByKey, lineIdsByCorridorKey);

  // Each line is laid out by the path most distinct journeys take, not every short working. Ties go
  // to the longer path, then the key, so refresh order cannot make the drawing flicker. Paths
  // leaving it are branches.
  const byLine = (left: { lineId: string; id: string }, right: { lineId: string; id: string }) =>
    compareLineIdsNaturally(left.lineId, right.lineId) || left.id.localeCompare(right.id);
  const trackIdByLineId = getTrackIdByLineId([...pathsByLineId.keys()]);
  const drawnPaths: ZentrumSchematicLinePath[] = [];
  const branchPaths: ZentrumSchematicBranchPath[] = [];
  for (const [lineId, paths] of pathsByLineId) {
    const [main, ...others] = [...paths.entries()]
      .sort(
        ([leftKey, left], [rightKey, right]) =>
          right.datedJourneyKeys.size - left.datedJourneyKeys.size ||
          right.nodes.length - left.nodes.length ||
          leftKey.localeCompare(rightKey),
      )
      .map(([pathKey, { nodes, datedJourneyKeys }]) => ({
        id: `${lineId}:${pathKey}`,
        lineId,
        trackId: trackIdByLineId.get(lineId) ?? lineId,
        nodes: route(nodes),
        datedJourneyKeys: [...datedJourneyKeys].sort(),
      }));
    drawnPaths.push({ id: main.id, lineId, trackId: main.trackId, nodes: main.nodes });
    const mainEdgeIds = new Set(getPathEdgeIds(main.nodes));
    branchPaths.push(
      ...others.filter(({ nodes }) => getPathEdgeIds(nodes).some((id) => !mainEdgeIds.has(id))),
    );
  }

  return {
    edges,
    corridors,
    linePaths: drawnPaths.sort(byLine),
    branchPaths: branchPaths.sort(byLine),
    lineIdsByNodeId: new Map(
      [...lineIdsByNodeId].map(([nodeId, lineIds]) => [
        nodeId,
        [...lineIds].sort(compareLineIdsNaturally),
      ]),
    ),
    ...boarding,
  };
};

const getPathEdgeIds = (nodes: readonly ZentrumSchematicNode[]): string[] =>
  nodes.slice(1).map((node, index) => getEdgeKey(nodes[index].id, node.id));

/** The lanes laid out for what was observed: the plan's one expensive step. */
const isStubNode = (node: ZentrumSchematicNode): boolean => node.id.startsWith("exit:");

/**
 * An edge's lanes; a stub running straight on keeps the slots of the corridor it continues, so its
 * lines hold their places and the lines ending there leave a gap.
 */
const getStubTrackIds = (
  edge: ZentrumSchematicObservedEdge,
  edges: readonly ZentrumSchematicObservedEdge[],
  trackIdsByEdgeId: ReadonlyMap<string, readonly string[]>,
): readonly string[] => {
  const own = trackIdsByEdgeId.get(edge.id) ?? [];
  const stub = isStubNode(edge.from) ? edge.from : isStubNode(edge.to) ? edge.to : undefined;
  if (!stub) return own;
  const node = stub === edge.from ? edge.to : edge.from;
  const out = { x: stub.x - node.x, y: stub.y - node.y };
  const continued = edges.find((other) => {
    if (other === edge || (other.from.id !== node.id && other.to.id !== node.id)) return false;
    const far = other.from.id === node.id ? other.to : other.from;
    const back = { x: far.x - node.x, y: far.y - node.y };
    const slots = trackIdsByEdgeId.get(other.id) ?? [];
    return (
      Math.abs(out.x * back.y - out.y * back.x) < 1e-6 &&
      out.x * back.x + out.y * back.y < 0 &&
      own.every((trackId) => slots.includes(trackId))
    );
  });
  return continued ? (trackIdsByEdgeId.get(continued.id) ?? own) : own;
};

const layOutZentrumSchematic = (
  {
    edges: observedEdges,
    corridors,
    linePaths,
    branchPaths,
    lineIdsByNodeId,
    boardingPlacesByNodeId,
    nodesById,
    resolveNodeId,
    placesByStopId,
  }: ZentrumSchematicObservation,
  layoutKey: string,
): ZentrumSchematicLayout => {
  const trackIdsByEdgeId = getTrackIdsByEdgeId(observedEdges, linePaths);
  const lanes: readonly ZentrumSchematicLanedEdge[] = observedEdges.map((edge) => ({
    ...edge,
    trackIds: getStubTrackIds(edge, observedEdges, trackIdsByEdgeId),
  }));
  const trackBandOffsetByEdgeId = getTrackBandOffsetByEdgeId(lanes, linePaths);
  const edges: readonly ZentrumSchematicEdge[] = lanes.map((edge) => ({
    ...edge,
    trackBandOffset: trackBandOffsetByEdgeId.get(edge.id) ?? 0,
  }));
  return {
    layoutKey,
    nodesById,
    resolveNodeId,
    placesByStopId,
    edges,
    corridors,
    linePaths,
    branchPaths,
    lineIds: [...new Set(edges.flatMap((edge) => edge.lineIds))].sort(compareLineIds),
    lineIdsByNodeId,
    boardingPlacesByNodeId,
  };
};

/** Everything the layout depends on: the corridors and the drawn patterns. */
const getZentrumSchematicLayoutKey = ({
  edges,
  linePaths,
  nodesById,
}: ZentrumSchematicObservation): string =>
  [
    ...[...nodesById.values()].map(({ id, x, y }) => `${id}:${x},${y}`),
    ...edges.map(({ id, lineIds }) => `${id}\u0001${lineIds.join(",")}`),
    ...linePaths.map(({ id, trackId }) => `${id}\u0001${trackId}`),
  ].join("\u0002");

/** One reading, for a caller that keeps none between refreshes. */
export function buildZentrumSchematicReading(
  drawnVehicles: readonly StopEvent[],
  planWidth?: number,
): ZentrumSchematicReading {
  return createZentrumSchematicDrawer()(createZentrumSchematicReader()(drawnVehicles), planWidth);
}

/**
 * A reader that lays the plan out again only when corridors or drawn patterns changed, since the
 * layout costs tens of milliseconds and dated journeys change every few seconds. Boarding places
 * and branches can change alone; the lanes are kept then.
 */
export function createZentrumSchematicReader(): (
  drawnVehicles: readonly StopEvent[],
) => ZentrumSchematicLayout {
  let last: { placesKey: string; layout: ZentrumSchematicLayout } | undefined;
  return (drawnVehicles) => {
    const observation = observeZentrumSchematic(drawnVehicles);
    const layoutKey = getZentrumSchematicLayoutKey(observation);
    const placesKey = [
      getBoardingPlacesKey(observation.boardingPlacesByNodeId),
      ...observation.branchPaths.map(
        ({ id, datedJourneyKeys }) => `${id}\u0001${datedJourneyKeys.join(",")}`,
      ),
    ].join("\u0002");
    const isSameLayout = last?.layout.layoutKey === layoutKey;
    if (last && isSameLayout && last.placesKey === placesKey) return last.layout;
    const layout =
      last && isSameLayout
        ? {
            ...last.layout,
            branchPaths: observation.branchPaths,
            boardingPlacesByNodeId: observation.boardingPlacesByNodeId,
            placesByStopId: observation.placesByStopId,
            resolveNodeId: observation.resolveNodeId,
          }
        : layOutZentrumSchematic(observation, layoutKey);
    last = { placesKey, layout };
    return layout;
  };
}

/**
 * A drawer that lays a layout's lanes at the plan's on-screen width, so a resize redraws geometry
 * without re-solving lanes. Branches given by id are drawn in their line's lanes. The same input
 * returns the same reading.
 */
export function createZentrumSchematicDrawer(): (
  layout: ZentrumSchematicLayout,
  planWidth: number | undefined,
  branchPathIds?: readonly string[],
) => ZentrumSchematicReading {
  let last: ZentrumSchematicReading | undefined;
  let lastKey: { layout: ZentrumSchematicLayout; branchKey: string } | undefined;
  return (layout, planWidth, branchPathIds = []) => {
    const trackWidth = getZentrumSchematicTrackWidth(layout.edges, planWidth);
    const branchKey = branchPathIds.join("\u0001");
    if (
      last &&
      lastKey?.layout === layout &&
      lastKey.branchKey === branchKey &&
      last.trackWidth === trackWidth
    )
      return last;
    const { edges } = layout;
    const stopMarks = getZentrumSchematicStopMarks(
      edges,
      layout.linePaths,
      trackWidth,
      layout.boardingPlacesByNodeId,
      layout.nodesById,
    );
    const drawnBranchIds = new Set(branchPathIds);
    const linePaths = [
      ...layout.linePaths,
      ...layout.branchPaths
        .filter(({ id }) => drawnBranchIds.has(id))
        .map(({ id, lineId, trackId, nodes }) => ({ id, lineId, trackId, nodes })),
    ];
    // From the final edges, so marks ride the painted geometry and halt at the capsules, where
    // the strokes end too.
    const stopLinesByNodeId = new Map(stopMarks.map(({ nodeId, capsules }) => [nodeId, capsules]));
    const vehiclePathsAndStretchesByPathId = new Map(
      linePaths.map((linePath) => [
        linePath.id,
        getZentrumSchematicVehiclePaths(linePath, edges, trackWidth, stopLinesByNodeId),
      ]),
    );
    const vehiclePathsByPathId = new Map(
      [...vehiclePathsAndStretchesByPathId].map(([id, { pathsByCorridorId }]) => [
        id,
        pathsByCorridorId,
      ]),
    );
    // A corridor the main path shares with a branch keeps the main path's stretch.
    const vehiclePathsByLineId = new Map<string, Map<string, ZentrumSchematicCorridorPath>>();
    const stopStretchesByLineId = new Map<string, Map<string, ZentrumSchematicStopStretch>>();
    for (const linePath of [...linePaths].reverse()) {
      const { pathsByCorridorId, stopStretches } =
        vehiclePathsAndStretchesByPathId.get(linePath.id) ?? {};
      const paths = vehiclePathsByLineId.get(linePath.lineId) ?? new Map();
      for (const [corridorId, path] of pathsByCorridorId ?? []) paths.set(corridorId, path);
      vehiclePathsByLineId.set(linePath.lineId, paths);
      const stretches = stopStretchesByLineId.get(linePath.lineId) ?? new Map();
      for (const stretch of stopStretches ?? []) {
        stretches.set(
          getZentrumSchematicStopStretchKey(stretch.nodeId, stretch.fromNodeId, stretch.toNodeId),
          stretch,
        );
      }
      stopStretchesByLineId.set(linePath.lineId, stretches);
    }
    last = {
      ...layout,
      trackWidth,
      drawnPaths: getZentrumSchematicDrawnPaths(
        linePaths,
        edges,
        trackWidth,
        vehiclePathsByPathId,
        stopLinesByNodeId,
      ),
      vehiclePathsByLineId,
      stopStretchesByLineId,
      stopMarks,
    };
    lastKey = { layout, branchKey };
    return last;
  };
}

/**
 * How long before its first drawn call a branch dated journey's stroke appears, and after its last
 * it stays.
 */
const ZENTRUM_BRANCH_MARGIN_MS = 2 * 60_000;

/** The branches a dated journey is on the plan for now, in layout order. */
export function getZentrumSchematicBranchIdsOnPlan(
  layout: Pick<ZentrumSchematicLayout, "branchPaths" | "nodesById" | "resolveNodeId">,
  datedJourneys: readonly StopEvent[],
  feedNow: number,
): string[] {
  if (layout.branchPaths.length === 0) return [];
  const onPlan = new Set(
    datedJourneys
      .filter((datedJourney) => {
        const calls = (datedJourney.calls ?? []).filter((call) =>
          layout.nodesById.has(layout.resolveNodeId(call) ?? ""),
        );
        const startsAt = getCallInstant(calls[0], "arrival");
        const endsAt = getCallInstant(calls.at(-1), "departure");
        return (
          startsAt !== undefined &&
          endsAt !== undefined &&
          startsAt - ZENTRUM_BRANCH_MARGIN_MS <= feedNow &&
          feedNow <= endsAt + ZENTRUM_BRANCH_MARGIN_MS
        );
      })
      .map(getDatedJourneyMarkKey),
  );
  return layout.branchPaths
    .filter(({ datedJourneyKeys }) => datedJourneyKeys.some((key) => onPlan.has(key)))
    .map(({ id }) => id);
}

const getBoardingPlacesKey = (
  placesByNodeId: ReadonlyMap<string, readonly ZentrumSchematicBoardingPlace[]>,
): string =>
  [...placesByNodeId]
    .map(
      ([nodeId, places]) =>
        `${nodeId}:${places
          .map(
            ({ armJourneyCounts, journeyCount, bays, bayKeys }) =>
              `${journeyCount}=${[...armJourneyCounts].join(",")}:${bays?.join(",")}:${bayKeys?.join(",")}`,
          )
          .join("|")}`,
    )
    .sort()
    .join(";");

/**
 * How far off the corridor's middle the line's lane sits, as a vector; zero where the reading
 * holds no lane for it.
 */
const getVehicleLaneOffset = (
  edge: ZentrumSchematicEdge | undefined,
  trackId: string | undefined,
  trackWidth: number | undefined,
): SchematicPoint => {
  if (!edge || trackWidth === undefined || trackId === undefined) return { x: 0, y: 0 };
  const laneIndex = edge.trackIds.indexOf(trackId);
  if (laneIndex < 0) return { x: 0, y: 0 };
  const offset = getTrackOffset(edge, laneIndex, trackWidth);
  const run = orientCorridorRun(edge);
  return { x: -run.y * offset, y: run.x * offset };
};

/** One observed vehicle placed on the plan, and the dated journey it still has ahead of it. */
type ZentrumSchematicPlacedDatedJourney = {
  stopEvent: StopEvent;
  /** The lane the line is drawn in. */
  trackId: string | undefined;
  /** The corridor the vehicle is on, if the reading holds one. */
  edge: ZentrumSchematicEdge | undefined;
  from: ZentrumSchematicNode;
  to: ZentrumSchematicNode;
  progress: number;
  phase: DatedJourneyPlacementPhase;
  markerKey: string;
  motion: DatedJourneyPlacementMotion;
  placedAfterLinks?: number;
  trajectory?: DatedJourneySegmentTrajectory;
  /**
   * The corridors from the one the vehicle is on to the end of its dated journey through the plan.
   */
  aheadCorridorIds: readonly string[];
  /** The drawn stops from the one the link leaves, not yet measured along the path. */
  aheadStops: readonly Omit<ZentrumSchematicAheadStop, "pathProgress">[];
  /**
   * Drawn stops between the link's ends that the feed left untimed. The path runs through them on
   * the line's lane rather than straight across.
   */
  via: readonly ZentrumSchematicNode[];
  /** For a link inside a complex: the corridor the journey leaves it by, where the mark parks. */
  leaving?: { from: ZentrumSchematicNode; to: ZentrumSchematicNode };
  /** The arriving corridor for a complex with no drawn way out. */
  entering?: { from: ZentrumSchematicNode; to: ZentrumSchematicNode };
  /** For a link between two places of one stop: the stroke from the first's capsule to the next's. */
  crossing?: ZentrumSchematicStopStretch;
  /**
   * The crossing of a stop the dated journey calls at twice next, which its link ends at the start
   * of.
   */
  crossingAhead?: ZentrumSchematicStopStretch;
  /**
   * The crossing of a stop the dated journey has just called at twice, which its link starts at the
   * end of.
   */
  crossingBehind?: ZentrumSchematicStopStretch;
};

const getZentrumSchematicPlacedDatedJourneys = (
  reading: ZentrumSchematicReading,
  stopEvents: readonly StopEvent[],
  feedNow: number,
  motions: DatedJourneyMotions,
  turnarounds: TurnaroundIndex,
): readonly ZentrumSchematicPlacedDatedJourney[] => {
  const edgeByKey = new Map(reading.edges.map((edge) => [edge.id, edge]));
  const trackIdByLineId = new Map(
    reading.linePaths.map(({ lineId, trackId }) => [lineId, trackId]),
  );
  const turningKeyByMarkKey = new Map<string, string>();
  for (const [arrivalKey, departureKey] of turnarounds.turningDepartureKeyByArrivalKey) {
    turningKeyByMarkKey.set(arrivalKey, departureKey);
    turningKeyByMarkKey.set(departureKey, departureKey);
  }

  const placedDatedJourneys: ZentrumSchematicPlacedDatedJourney[] = [];
  for (const stopEvent of stopEvents) {
    if (!isRailStopEvent(stopEvent)) continue;
    const standFrom = turnarounds.standFromByDepartureKey.get(getDatedJourneyMarkKey(stopEvent));
    const placement = getDatedJourneyPlacement(motions, stopEvent, feedNow, standFrom);
    if (!placement) continue;

    const calls = collapseTurnaroundCalls(stopEvent.calls ?? []);
    const nodeOf = (call: (typeof calls)[number] | undefined): ZentrumSchematicNode | undefined =>
      call && reading.nodesById.get(reading.resolveNodeId(call) ?? "");
    let selectedLink:
      | {
          index: number;
          toIndex: number;
          from: ZentrumSchematicNode;
          to: ZentrumSchematicNode;
          via: readonly ZentrumSchematicNode[];
        }
      | undefined;
    for (let index = 0; index < calls.length - 1; index += 1) {
      if (calls[index].localStopId !== placement.fromStopId) continue;
      // The far end is the first drawn call the link names; drawn calls before it were left
      // untimed and are ridden through, undrawn ones are ignored.
      const via: ZentrumSchematicNode[] = [];
      let toIndex = -1;
      for (let ahead = index + 1; ahead < calls.length; ahead += 1) {
        const node = nodeOf(calls[ahead]);
        if (!node) continue;
        if (calls[ahead].localStopId !== placement.toStopId) {
          via.push(node);
          continue;
        }
        toIndex = ahead;
        break;
      }
      if (toIndex < 0) continue;
      const from = nodeOf(calls[index]);
      const to = nodeOf(calls[toIndex]);
      if (!from || !to) continue;
      // A route may visit a stop twice and the placement names no occurrence, so the closest
      // matching pair wins, keeping a mark from being sent back around the route.
      if (
        selectedLink === undefined ||
        toIndex - index < selectedLink.toIndex - selectedLink.index
      ) {
        selectedLink = { index, toIndex, from, to, via };
      }
    }
    if (!selectedLink) continue;
    const { index, toIndex, from, to, via } = selectedLink;
    // The stroke between the capsules of a stop the dated journey calls at in two places in turn.
    const getCrossing = (callIndex: number): ZentrumSchematicStopStretch | undefined => {
      const node = nodeOf(calls[callIndex]);
      if (!node) return undefined;
      let first = callIndex;
      while (first > 0 && nodeOf(calls[first - 1])?.id === node.id) first -= 1;
      let last = callIndex;
      while (last < calls.length - 1 && nodeOf(calls[last + 1])?.id === node.id) last += 1;
      const placeOf = (call: Call) => `${call.providerStopPointId}|${call.bay}`;
      if (last - first !== 1 || placeOf(calls[first]) === placeOf(calls[last])) return undefined;
      const before = nodeOf(calls[first - 1]);
      const after = nodeOf(calls[last + 1]);
      const stretch =
        before &&
        after &&
        reading.stopStretchesByLineId
          .get(stopEvent.lineId)
          ?.get(getZentrumSchematicStopStretchKey(node.id, before.id, after.id));
      return stretch ? orientZentrumSchematicStopStretch(stretch, before.id) : undefined;
    };
    const crossing = from.id === to.id ? getCrossing(index) : undefined;
    const crossingBehind =
      from.id !== to.id && nodeOf(calls[index - 1])?.id === from.id
        ? getCrossing(index)
        : undefined;
    const crossingAhead =
      from.id !== to.id && nodeOf(calls[toIndex + 1])?.id === to.id
        ? getCrossing(toIndex)
        : undefined;
    const aheadCorridorIds: string[] = [];
    const aheadStops: Omit<ZentrumSchematicAheadStop, "pathProgress">[] = [];
    let leaving: { from: ZentrumSchematicNode; to: ZentrumSchematicNode } | undefined;
    let entering: { from: ZentrumSchematicNode; to: ZentrumSchematicNode } | undefined;
    if (placement.phase !== "afterEnd") {
      for (let ahead = index; ahead < calls.length - 1; ahead += 1) {
        const aheadFrom = nodeOf(calls[ahead]);
        const aheadTo = nodeOf(calls[ahead + 1]);
        if (!aheadFrom || !aheadTo || aheadFrom.id === aheadTo.id) continue;
        aheadCorridorIds.push(getEdgeKey(aheadFrom.id, aheadTo.id));
      }
      for (let ahead = index; ahead < calls.length; ahead += 1) {
        const node = nodeOf(calls[ahead]);
        if (!node) continue;
        const departsAt = getCallInstant(calls[ahead]);
        // The calls of one complex are one stop to a rider, left when its last call is.
        const last = aheadStops.at(-1);
        if (last?.nodeId === node.id) {
          last.call = calls[ahead];
          last.departsAt = departsAt ?? last.departsAt;
        } else aheadStops.push({ nodeId: node.id, call: calls[ahead], departsAt });
      }
    }
    if (from.id === to.id) {
      for (let behind = index - 1; behind >= 0; behind -= 1) {
        const node = nodeOf(calls[behind]);
        if (!node) break;
        if (node.id === from.id) continue;
        entering = { from: node, to: from };
        break;
      }
      for (let ahead = index + 1; ahead < calls.length - 1; ahead += 1) {
        const aheadFrom = nodeOf(calls[ahead]);
        const aheadTo = nodeOf(calls[ahead + 1]);
        if (!aheadFrom || aheadFrom.id !== from.id || !aheadTo || aheadTo.id === from.id) continue;
        leaving = { from: aheadFrom, to: aheadTo };
        break;
      }
    }
    const markerKey =
      turningKeyByMarkKey.get(getDatedJourneyMarkKey(stopEvent)) ??
      getDatedJourneyMarkKey(stopEvent);
    placedDatedJourneys.push({
      stopEvent,
      trackId: trackIdByLineId.get(stopEvent.lineId),
      edge: from.id === to.id ? undefined : edgeByKey.get(getEdgeKey(from.id, to.id)),
      from,
      to,
      progress: placement.progress,
      phase: placement.phase,
      markerKey,
      motion: placement.motion,
      placedAfterLinks: placement.placedAfterLinks,
      trajectory: placement.trajectory,
      aheadCorridorIds,
      aheadStops,
      via,
      ...(leaving ? { leaving } : {}),
      ...(entering ? { entering } : {}),
      ...(crossing ? { crossing } : {}),
      ...(crossingAhead ? { crossingAhead } : {}),
      ...(crossingBehind ? { crossingBehind } : {}),
    });
  }

  const placedKeys = new Set(
    placedDatedJourneys.map(({ stopEvent }) => getDatedJourneyMarkKey(stopEvent)),
  );
  const afterTurnarounds = placedDatedJourneys.filter(({ stopEvent, phase }) => {
    const turningKey = turnarounds.turningDepartureKeyByArrivalKey.get(
      getDatedJourneyMarkKey(stopEvent),
    );
    return !(phase === "afterEnd" && turningKey !== undefined && placedKeys.has(turningKey));
  });
  const arrivingTurnKeys = new Set(
    afterTurnarounds.flatMap(({ stopEvent, phase }) => {
      const turningKey = turnarounds.turningDepartureKeyByArrivalKey.get(
        getDatedJourneyMarkKey(stopEvent),
      );
      return phase === "running" && turningKey !== undefined ? [turningKey] : [];
    }),
  );
  return afterTurnarounds.filter((placement) => {
    if (placement.phase !== "beforeStart") return true;
    return !arrivingTurnKeys.has(getDatedJourneyMarkKey(placement.stopEvent));
  });
};

/** The path a mark follows over its link: its line's drawn stretches, in journey order. */
const getVehiclePath = (
  reading: ZentrumSchematicReading,
  {
    stopEvent,
    trackId,
    edge,
    from,
    to,
    via,
    leaving,
    entering,
    crossing,
    crossingAhead,
    crossingBehind,
  }: Pick<
    ZentrumSchematicPlacedDatedJourney,
    | "stopEvent"
    | "trackId"
    | "edge"
    | "from"
    | "to"
    | "via"
    | "leaving"
    | "entering"
    | "crossing"
    | "crossingAhead"
    | "crossingBehind"
  >,
): ZentrumSchematicVehiclePath => {
  const paths = reading.vehiclePathsByLineId.get(stopEvent.lineId);
  if (crossing) return { points: crossing.points, steps: crossing.steps, corridorRanges: [] };
  // Inside a complex the mark parks on its way out, or where it arrived if the way out is undrawn.
  if (from.id === to.id) {
    const leavingPath = getDatedJourneyCorridorPath(reading, stopEvent, leaving);
    const enteringPath = getDatedJourneyCorridorPath(reading, stopEvent, entering);
    return {
      points: [leavingPath?.points[0] ?? enteringPath?.points.at(-1) ?? from],
      steps: [0],
      corridorRanges: [],
    };
  }
  const stops = [from, ...via, to];
  const pieces: { corridorId: string; path: ZentrumSchematicCorridorPath }[] = [];
  for (let index = 0; index < stops.length - 1; index += 1) {
    const piece = paths?.get(getEdgeKey(stops[index].id, stops[index + 1].id));
    if (!piece) break;
    pieces.push({
      corridorId: getEdgeKey(stops[index].id, stops[index + 1].id),
      path: orientZentrumSchematicCorridorPath(piece, stops[index].id),
    });
  }
  // Around a stop called at in two places, the link ends and starts at those places' capsules.
  const first = pieces[0];
  if (first && crossingBehind) {
    first.path = trimZentrumSchematicCorridorPath(first.path, {
      start: crossingBehind.points.at(-1),
    });
  }
  const last = pieces.at(-1);
  if (last && pieces.length === stops.length - 1 && crossingAhead) {
    last.path = trimZentrumSchematicCorridorPath(last.path, { end: crossingAhead.points[0] });
  }
  const joined =
    pieces.length === stops.length - 1
      ? joinZentrumSchematicCorridorPaths(pieces.map(({ path }) => path))
      : undefined;
  if (joined) {
    const lengths = pieces.map(({ path }) => getPathLength(path.points));
    const totalLength = lengths.reduce((sum, length) => sum + length, 0);
    let startLength = 0;
    const corridorRanges = pieces.map(({ corridorId }, index) => {
      const endLength = startLength + lengths[index];
      const range = {
        corridorId,
        start: totalLength > 0 ? startLength / totalLength : 0,
        end: totalLength > 0 ? endLength / totalLength : 0,
      };
      startLength = endLength;
      return range;
    });
    return { ...joined, corridorRanges };
  }
  // A corridor the line's drawn pattern does not hold: its segments, along the line's lane.
  const segments = edge ? [edge] : getJunctionSegments(reading.edges, from, to);
  const points = segments.flatMap((segment, index) => {
    const lane = getVehicleLaneOffset(segment, trackId, reading.trackWidth);
    const start = index === 0 ? from : segment.from.id === to.id ? segment.to : segment.from;
    const end = segment.from.id === start.id ? segment.to : segment.from;
    return [
      { x: start.x + lane.x, y: start.y + lane.y },
      { x: end.x + lane.x, y: end.y + lane.y },
    ];
  });
  const steps = getZentrumSchematicPathSteps(points);
  if (!steps) return { points: [from, to], steps: [0, 1], corridorRanges: [] };
  return {
    points,
    steps,
    corridorRanges: [{ corridorId: getEdgeKey(from.id, to.id), start: 0, end: 1 }],
  };
};

/** The segments a corridor runs over through a junction, from one stop to the other. */
const getJunctionSegments = (
  edges: readonly ZentrumSchematicEdge[],
  from: ZentrumSchematicNode,
  to: ZentrumSchematicNode,
): readonly ZentrumSchematicEdge[] => {
  const touching = (node: ZentrumSchematicNode) =>
    edges.filter((edge) => edge.from.id === node.id || edge.to.id === node.id);
  const far = (edge: ZentrumSchematicEdge, node: ZentrumSchematicNode) =>
    edge.from.id === node.id ? edge.to : edge.from;
  for (const first of touching(from)) {
    const junction = far(first, from);
    if (!junction.isJunction) continue;
    const second = touching(junction).find((edge) => far(edge, junction).id === to.id);
    if (second) return [first, second];
  }
  return [];
};

/** The stops ahead, each measured where its corridor's range on the mark's path ends. */
const measureAheadStops = (
  aheadStops: readonly Omit<ZentrumSchematicAheadStop, "pathProgress">[],
  pathStops: readonly ZentrumSchematicNode[],
  path: ZentrumSchematicVehiclePath,
): readonly ZentrumSchematicAheadStop[] => {
  const isMeasured = path.corridorRanges.length === pathStops.length - 1;
  let next = 0;
  return aheadStops.map((stop) => {
    if (next >= pathStops.length || stop.nodeId !== pathStops[next].id) return stop;
    const index = next;
    next += 1;
    const pathProgress =
      index === 0
        ? 0
        : isMeasured
          ? path.corridorRanges[index - 1].end
          : index === pathStops.length - 1
            ? 1
            : undefined;
    return pathProgress === undefined ? stop : { ...stop, pathProgress };
  });
};

const getPathLength = (points: readonly SchematicPoint[]): number =>
  points.reduce(
    (length, point, index) =>
      index === 0
        ? length
        : length + Math.hypot(point.x - points[index - 1].x, point.y - points[index - 1].y),
    0,
  );

/**
 * Positions for observed vehicles whose current link is drawn; `getDatedJourneyPlacement` owns the timing.
 * Marks ride their line's lane both ways, so meeting trams briefly overlap. Callers ticking every
 * second pass precomputed turnarounds.
 */
export function getZentrumSchematicVehicles(
  reading: ZentrumSchematicReading,
  stopEvents: readonly StopEvent[],
  feedNow: number,
  motions: DatedJourneyMotions,
  turnarounds: TurnaroundIndex = findTurnarounds(stopEvents),
): ZentrumSchematicVehicle[] {
  return getZentrumSchematicPlacedDatedJourneys(
    reading,
    stopEvents,
    feedNow,
    motions,
    turnarounds,
  ).map(
    ({
      stopEvent,
      trackId,
      edge,
      from,
      to,
      progress,
      phase,
      aheadCorridorIds,
      aheadStops,
      markerKey,
      motion,
      placedAfterLinks,
      trajectory,
      via,
      leaving,
      entering,
      crossing,
      crossingAhead,
      crossingBehind,
    }) => {
      const path = getVehiclePath(reading, {
        stopEvent,
        trackId,
        edge,
        from,
        to,
        via,
        leaving,
        entering,
        crossing,
        crossingAhead,
        crossingBehind,
      });
      const placement = getZentrumSchematicVehiclePathPlacement(path, progress);
      return {
        id: getDatedJourneyMarkKey(stopEvent),
        stopEvent,
        markerKey,
        lineId: stopEvent.lineId,
        destination: stopEvent.destinationText,
        from,
        to,
        progress,
        phase,
        aheadCorridorIds,
        aheadStops: measureAheadStops(
          aheadStops,
          from.id === to.id ? [from] : [from, ...via, to],
          path,
        ),
        path,
        motion,
        placedAfterLinks,
        trajectory,
        x: placement.x,
        y: placement.y,
        angle: placement.angle ?? getVehicleHeadingAngle(reading, { stopEvent, leaving, entering }),
      };
    },
  );
}

/** A parked mark faces its way out, or keeps its arriving direction where the way out is undrawn. */
const getVehicleHeadingAngle = (
  reading: ZentrumSchematicReading,
  {
    stopEvent,
    leaving,
    entering,
  }: Pick<ZentrumSchematicPlacedDatedJourney, "stopEvent" | "leaving" | "entering">,
): number => {
  const leavingPath = getDatedJourneyCorridorPath(reading, stopEvent, leaving);
  if (leavingPath) return getZentrumSchematicVehiclePathPlacement(leavingPath, 0).angle ?? 0;
  const enteringPath = getDatedJourneyCorridorPath(reading, stopEvent, entering);
  return enteringPath ? (getZentrumSchematicVehiclePathPlacement(enteringPath, 1).angle ?? 0) : 0;
};

/** A corridor's drawn path, oriented in the dated journey's direction. */
const getDatedJourneyCorridorPath = (
  reading: ZentrumSchematicReading,
  stopEvent: StopEvent,
  corridor: ZentrumSchematicPlacedDatedJourney["leaving"],
): ZentrumSchematicCorridorPath | undefined => {
  if (!corridor) return undefined;
  const path = reading.vehiclePathsByLineId
    .get(stopEvent.lineId)
    ?.get(getEdgeKey(corridor.from.id, corridor.to.id));
  return path && orientZentrumSchematicCorridorPath(path, corridor.from.id);
};
