/**
 * What is running through the Zentrum, read onto the plan it is drawn on.
 *
 * The reading, not the drawing: which corridors of the authored plan (`zentrum-schematic-plan.ts`)
 * today's trips actually state, which lines hold which lane along them
 * (`zentrum-schematic-lanes.ts`), where a stop's platforms stand, and where each observed vehicle
 * is between two of them. Nothing here is a claim about the network — a corridor no trip states is
 * not drawn, and a line that stops running leaves the plan by itself. How that reading is painted
 * is the other two modules' question: the strokes (`zentrum-schematic-paths.ts`) and the stops'
 * rules (`zentrum-schematic-stops.ts`).
 */
import type { Departure } from "../data/transit-types";
import { collapseTurnaroundCalls } from "./trip-calls";
import { getDistinctTimetableTrips, getRunMarkKey } from "./trips";
import {
  getRunPlacement,
  type RunMotions,
  type RunPlacementMotion,
  type RunPlacementPhase,
  type RunSegmentTrajectory,
} from "./vehicle-positioning";
import { findTurnarounds } from "./line-turnarounds";
import {
  type SchematicPoint,
  type ZentrumSchematicBoardingPlace,
  type ZentrumSchematicEdge,
  type ZentrumSchematicLanedEdge,
  type ZentrumSchematicLinePath,
  type ZentrumSchematicNode,
  type ZentrumSchematicObservedEdge,
  findZentrumSchematicNodeId,
  getEdgeKey,
  getTrackIdByLineId,
  getTrackOffset,
  getZentrumSchematicTrackWidth,
  orientCorridorRun,
  zentrumSchematicNodeById,
} from "./zentrum-schematic-plan";
import {
  getZentrumSchematicVehiclePathPlacement,
  getZentrumSchematicVehiclePathsByEdgeId,
  joinZentrumSchematicVehiclePaths,
  reverseZentrumSchematicVehiclePath,
  type ZentrumSchematicVehiclePath as ZentrumSchematicVehicleSegmentPath,
} from "./zentrum-schematic-paths";
import { getTrackBandOffsetByEdgeId, getTrackLineIdsByEdgeId } from "./zentrum-schematic-lanes";

export type ZentrumSchematicVehicle = {
  id: string;
  markerKey?: string;
  lineId: string;
  destination: string;
  from: ZentrumSchematicNode;
  to: ZentrumSchematicNode;
  progress: number;
  phase?: RunPlacementPhase;
  /** Every drawn corridor from the one the vehicle is on through the end of its run. */
  aheadEdgeIds: readonly string[];
  x: number;
  y: number;
  angle: number;
  /**
   * The drawn stretch the mark follows, already turned the way this run travels it: the line's lane
   * for the corridor, bent the way the stroke is. The mark's whole position is stated along this,
   * so it hands over between corridors exactly where its line's stroke does.
   */
  path: ZentrumSchematicVehiclePath;
  /**
   * How the mark got here: only travelled motion may be animated as a journey, a placement is
   * painted where it belongs (`vehicle-positioning.ts`).
   */
  motion: RunPlacementMotion;
  /**
   * How far a placement put the mark from where it was drawn, in links of the trip's own calls —
   * what lets the mark be corrected over rather than snapped. See `RunPlacement.placedAfterLinks`.
   */
  placedAfterLinks?: number;
  /**
   * The link's motion as one appointment with its next stop, where the placement planned one: the
   * curve a drawing animates the mark along between its one-second ticks.
   */
  trajectory?: RunSegmentTrajectory;
};

/**
 * The stretch of drawn lane one vehicle's mark follows, in the direction the run travels it.
 *
 * A degenerate link — both ends one stop, as the two tunnel calls of a complex are — is a path of
 * one point: the mark parks there while its vehicle is inside the complex, rather than leaving the
 * plan for the length of the crossing.
 */
export type ZentrumSchematicVehiclePath = {
  /** The path as points, path-ordered: the first is where the mark stands at progress 0. */
  points: readonly SchematicPoint[];
  /** How far along the path each point stands, ascending and ending at 1 where it has a length. */
  steps: readonly number[];
  /** The drawn corridors making up the path, with their ranges in the path's progress. */
  edgeRanges: readonly ZentrumSchematicVehiclePathEdgeRange[];
};

export type ZentrumSchematicVehiclePathEdgeRange = {
  edgeId: string;
  start: number;
  end: number;
};

export type ZentrumSchematicReading = {
  edges: readonly ZentrumSchematicEdge[];
  linePaths: readonly ZentrumSchematicLinePath[];
  lineIdsByNodeId: ReadonlyMap<string, readonly string[]>;
  /**
   * How wide a lane is drawn in this reading, and how far apart neighbouring lanes are laid: the
   * one measurement the drawing and the stroke that paints it both have to be told, so that lanes
   * sharing a corridor meet exactly.
   */
  trackWidth: number;
  /** The stops the reading can name more than one place to stand at, and what those places are. */
  boardingPlacesByNodeId: ReadonlyMap<string, readonly ZentrumSchematicBoardingPlace[]>;
  /**
   * The drawn stretch a mark follows, by line and by the corridor it is read on. Read once with the
   * reading, which is the only time the lanes move; placing a vehicle against it is a lookup.
   */
  vehiclePathsByLineId: ReadonlyMap<
    string,
    ReadonlyMap<string, ZentrumSchematicVehicleSegmentPath>
  >;
};

const getPathKey = (nodes: readonly ZentrumSchematicNode[]): string => {
  const forward = nodes.map(({ id }) => id).join("\u0000");
  const reverse = nodes
    .map(({ id }) => id)
    .reverse()
    .join("\u0000");
  return forward < reverse ? forward : reverse;
};

const getDepartureSchematicPaths = (departure: Departure): ZentrumSchematicNode[][] => {
  const paths: ZentrumSchematicNode[][] = [];
  let path: ZentrumSchematicNode[] = [];
  const finishPath = () => {
    if (path.length >= 2) paths.push(path);
    path = [];
  };

  for (const call of departure.tripCalls ?? []) {
    const node = zentrumSchematicNodeById.get(findZentrumSchematicNodeId(call) ?? "");
    if (!node) {
      finishPath();
      continue;
    }
    if (path.at(-1)?.id !== node.id) path.push(node);
  }
  finishPath();
  return paths;
};

/**
 * The share of a stop's calls a platform has to carry before the plan draws a place for it.
 *
 * A platform used a handful of times in a board window is a diversion, a replacement working or a
 * layover, and drawing a mark for it would put a place to stand where no rider waits. Marktplatz's
 * `5(U)` is the case in hand: nine calls against a thousand.
 */
const ZENTRUM_SCHEMATIC_BOARDING_PLACE_MINIMUM_SHARE = 0.05;

/**
 * The most places one stop is drawn with.
 *
 * Three is what the Zentrum's largest complex actually is — Europaplatz's tunnel and its two
 * surface platforms — and it is also as many marks as a reader can tell apart at one crossing.
 */
const ZENTRUM_SCHEMATIC_MAXIMUM_BOARDING_PLACES = 3;

/**
 * The places to stand at each stop the reading can name more than one of.
 *
 * Platforms are gathered by the corridors their trips run: the same set of corridors is the same
 * place, a different set is a different one. A stop whose platforms all run the same corridors --
 * which is every ordinary through stop, its two platforms being the two directions of one street --
 * comes back with nothing, and is drawn as the single bar across its band that it is.
 */
const getZentrumSchematicBoardingPlaces = (
  departures: readonly Departure[],
): ReadonlyMap<string, readonly ZentrumSchematicBoardingPlace[]> => {
  const platformsByNodeId = new Map<
    string,
    Map<string, { arms: Map<string, number>; callCount: number }>
  >();
  for (const departure of departures) {
    const calls = departure.tripCalls ?? [];
    const nodeIds = calls.map((call) => findZentrumSchematicNodeId(call));
    for (const [index, call] of calls.entries()) {
      const nodeId = nodeIds[index];
      if (!nodeId || !call.platformCode) continue;
      const platforms = platformsByNodeId.get(nodeId) ?? new Map();
      platformsByNodeId.set(nodeId, platforms);
      const platform = platforms.get(call.platformCode) ?? { arms: new Map(), callCount: 0 };
      platforms.set(call.platformCode, platform);
      platform.callCount += 1;
      // Only the calls either side of this one, for the reason the corridors themselves are read
      // that way: a trip that leaves the plan and comes back must not invent a corridor across it.
      for (const armNodeId of [nodeIds[index - 1], nodeIds[index + 1]]) {
        if (!armNodeId || armNodeId === nodeId) continue;
        platform.arms.set(armNodeId, (platform.arms.get(armNodeId) ?? 0) + 1);
      }
    }
  }

  return new Map(
    [...platformsByNodeId].flatMap(([nodeId, platforms]) => {
      const callCount = [...platforms.values()].reduce((sum, one) => sum + one.callCount, 0);
      const placeByArmKey = new Map<
        string,
        { armTripCounts: Map<string, number>; tripCount: number }
      >();
      for (const platform of platforms.values()) {
        const isDrawn =
          platform.arms.size > 0 &&
          platform.callCount >= callCount * ZENTRUM_SCHEMATIC_BOARDING_PLACE_MINIMUM_SHARE;
        if (!isDrawn) continue;
        const armKey = [...platform.arms.keys()].sort().join(" ");
        const place = placeByArmKey.get(armKey) ?? { armTripCounts: new Map(), tripCount: 0 };
        placeByArmKey.set(armKey, place);
        place.tripCount += platform.callCount;
        for (const [armNodeId, count] of platform.arms) {
          place.armTripCounts.set(armNodeId, (place.armTripCounts.get(armNodeId) ?? 0) + count);
        }
      }
      const places = [...placeByArmKey.values()]
        .sort((left, right) => right.tripCount - left.tripCount)
        .slice(0, ZENTRUM_SCHEMATIC_MAXIMUM_BOARDING_PLACES);
      return places.length >= 2 ? [[nodeId, places] as const] : [];
    }),
  );
};

/**
 * The paths the drawn runs actually state through the authored drawing surface.
 *
 * The drawn runs are the ones the plan places: board rows and retained readings alike, whichever
 * board last named them. Calls are considered only in adjacent pairs. A trip leaving the schematic
 * and later returning therefore cannot invent a straight shortcut across it, and an unknown part of
 * a complex breaks the path instead of being guessed into the nearest node.
 */
export function buildZentrumSchematicReading(
  drawnVehicles: readonly Departure[],
): ZentrumSchematicReading {
  const lineIdsByEdgeKey = new Map<string, Set<string>>();
  const pathsByLineId = new Map<
    string,
    Map<string, { nodes: readonly ZentrumSchematicNode[]; tripCount: number }>
  >();

  // The same trips the corridors are read from state where their riders board, so the places to
  // stand are read here rather than from a second pass over the boards.
  const drawnDepartures = getDistinctTimetableTrips(drawnVehicles).filter(
    (departure) =>
      departure.status !== "cancelled" &&
      (departure.transportMode === "tram" || departure.transportMode === "lightRail"),
  );

  for (const departure of drawnDepartures) {
    for (const path of getDepartureSchematicPaths(departure)) {
      const paths = pathsByLineId.get(departure.lineId) ?? new Map();
      const pathKey = getPathKey(path);
      const observed = paths.get(pathKey);
      paths.set(pathKey, {
        nodes: observed?.nodes ?? path,
        tripCount: (observed?.tripCount ?? 0) + 1,
      });
      pathsByLineId.set(departure.lineId, paths);
      for (let index = 1; index < path.length; index += 1) {
        const key = getEdgeKey(path[index - 1].id, path[index].id);
        const lineIds = lineIdsByEdgeKey.get(key) ?? new Set<string>();
        lineIds.add(departure.lineId);
        lineIdsByEdgeKey.set(key, lineIds);
      }
    }
  }

  const lineIdsByNodeId = new Map<string, Set<string>>();
  const observedEdges: ZentrumSchematicObservedEdge[] = [...lineIdsByEdgeKey.entries()].flatMap(
    ([key, lineIds]) => {
      const [fromId, toId] = key.split("\u0000");
      const from = zentrumSchematicNodeById.get(fromId);
      const to = zentrumSchematicNodeById.get(toId);
      if (!from || !to) return [];
      const sortedLineIds = [...lineIds].sort((left, right) =>
        left.localeCompare(right, "de", { numeric: true }),
      );
      for (const node of [from, to]) {
        const nodeLineIds = lineIdsByNodeId.get(node.id) ?? new Set<string>();
        for (const lineId of sortedLineIds) nodeLineIds.add(lineId);
        lineIdsByNodeId.set(node.id, nodeLineIds);
      }
      return [{ id: key, from, to, lineIds: sortedLineIds }];
    },
  );

  // The line view is a legible overview, not a catalogue of every short working and diversion in
  // the current board window. Draw the path used by the greatest number of distinct timetable
  // trips. The same run seen at several observation posts was deduplicated above, so proximity to
  // the Zentrum's more densely sampled stops cannot make one path look more common than it is.
  // A tie goes to the path that explains more of the line, then to its stable key; refresh order
  // therefore cannot make the drawing flicker between equally represented alternatives.
  const drawnPaths = [...pathsByLineId]
    .flatMap(([lineId, paths]) => {
      const mostUsed = [...paths.entries()].sort(
        ([leftKey, left], [rightKey, right]) =>
          right.tripCount - left.tripCount ||
          right.nodes.length - left.nodes.length ||
          leftKey.localeCompare(rightKey),
      )[0];
      if (!mostUsed) return [];
      const [pathKey, { nodes }] = mostUsed;
      return [{ id: `${lineId}:${pathKey}`, lineId, nodes }];
    })
    .sort(
      (left, right) =>
        left.lineId.localeCompare(right.lineId, "de", { numeric: true }) ||
        left.id.localeCompare(right.id),
    );

  const trackIdByLineId = getTrackIdByLineId(drawnPaths.map(({ lineId }) => lineId));
  const linePaths = drawnPaths.map((linePath) => ({
    ...linePath,
    trackId: trackIdByLineId.get(linePath.lineId) ?? linePath.lineId,
  }));

  const trackLineIdsByEdgeId = getTrackLineIdsByEdgeId(observedEdges, linePaths);
  const lanes: readonly ZentrumSchematicLanedEdge[] = observedEdges.map((edge) => ({
    ...edge,
    trackLineIds: trackLineIdsByEdgeId.get(edge.id) ?? [],
  }));
  const trackWidth = getZentrumSchematicTrackWidth(lanes);
  const trackBandOffsetByEdgeId = getTrackBandOffsetByEdgeId(lanes, linePaths, trackWidth);
  const edges: readonly ZentrumSchematicEdge[] = lanes.map((edge) => ({
    ...edge,
    trackBandOffset: trackBandOffsetByEdgeId.get(edge.id) ?? 0,
  }));

  return {
    edges,
    linePaths,
    trackWidth,
    boardingPlacesByNodeId: getZentrumSchematicBoardingPlaces(drawnDepartures),
    // Read from the edges as they are drawn, band offset included: the paths a mark follows are
    // the same geometry the stroke paints.
    vehiclePathsByLineId: new Map(
      linePaths.map((linePath) => [
        linePath.lineId,
        getZentrumSchematicVehiclePathsByEdgeId(linePath, edges, trackWidth),
      ]),
    ),
    lineIdsByNodeId: new Map(
      [...lineIdsByNodeId].map(([nodeId, lineIds]) => [
        nodeId,
        [...lineIds].sort((left, right) => left.localeCompare(right, "de", { numeric: true })),
      ]),
    ),
  };
}

/**
 * How far off the straight between two stops the line's own lane sits, as a vector.
 *
 * The same lane measurement the drawn path is painted from: a signed distance from the corridor's
 * middle along the corridor's oriented normal, so a mark lands on the stroke its line runs in. A
 * corridor the reading no longer holds, a line it names no lane for, and the plan's centre-line
 * reading all leave the mark on the middle itself.
 */
const getVehicleLaneOffset = (
  edge: ZentrumSchematicEdge | undefined,
  trackId: string | undefined,
  trackWidth: number | undefined,
): SchematicPoint => {
  if (!edge || trackWidth === undefined || trackId === undefined) return { x: 0, y: 0 };
  const laneIndex = edge.trackLineIds.indexOf(trackId);
  if (laneIndex < 0) return { x: 0, y: 0 };
  const offset = getTrackOffset(edge, laneIndex, trackWidth);
  const run = orientCorridorRun(edge);
  return { x: -run.y * offset, y: run.x * offset };
};

/**
 * One observed vehicle placed on the schematic, and the run it still has ahead of it.
 *
 * The placement is the first adjacent call pair the feed's own timing puts the vehicle between
 * whose two stops the plan draws; `aheadEdgeIds` is every corridor from the one the vehicle is on
 * to the end of its run through the plan, as its trip states them -- adjacent Zentrum calls only,
 * by the same adjacency rule the drawn paths keep.
 */
type ZentrumSchematicPlacedRun = {
  departure: Departure;
  /** The lane the line is drawn in, where the vehicle's mark follows. */
  trackId: string | undefined;
  /** The corridor the vehicle is currently on, where the reading holds one. */
  edge: ZentrumSchematicEdge | undefined;
  from: ZentrumSchematicNode;
  to: ZentrumSchematicNode;
  progress: number;
  phase: RunPlacementPhase;
  markerKey: string;
  motion: RunPlacementMotion;
  placedAfterLinks?: number;
  trajectory?: RunSegmentTrajectory;
  /** The corridors from the one the vehicle is on to the end of its run through the plan. */
  aheadEdgeIds: readonly string[];
  /**
   * The stops the plan draws between the link's two ends, which the mark's path passes through.
   * The feed times a link between two calls and can leave a call between them untimed; the trip
   * still names the stop, and the vehicle path follows the line's drawn lane through it rather than a
   * straight across it.
   */
  via: readonly ZentrumSchematicNode[];
  /**
   * The corridor the trip leaves the vehicle's stop complex by, where its link is inside one: the
   * two tunnel calls of a complex are one link the plan draws no corridor for, and the mark is
   * parked where the leaving corridor's lane begins while its vehicle crosses.
   */
  leaving?: { from: ZentrumSchematicNode; to: ZentrumSchematicNode };
};

const getZentrumSchematicPlacedRuns = (
  reading: ZentrumSchematicReading,
  departures: readonly Departure[],
  feedNow: number,
  motions: RunMotions,
): readonly ZentrumSchematicPlacedRun[] => {
  const edgeByKey = new Map(reading.edges.map((edge) => [edge.id, edge]));
  const trackIdByLineId = getTrackIdByLineId(reading.linePaths.map(({ lineId }) => lineId));
  const turnarounds = findTurnarounds(departures);
  const turningKeyByMarkKey = new Map<string, string>();
  for (const [arrivalKey, departureKey] of turnarounds.turningDepartureKeyByArrivalKey) {
    turningKeyByMarkKey.set(arrivalKey, departureKey);
    turningKeyByMarkKey.set(departureKey, departureKey);
  }

  const placedRuns: ZentrumSchematicPlacedRun[] = [];
  for (const departure of departures) {
    if (departure.transportMode !== "tram" && departure.transportMode !== "lightRail") continue;
    const standFrom = turnarounds.standFromByDepartureKey.get(getRunMarkKey(departure));
    const placement = getRunPlacement(motions, departure, feedNow, standFrom);
    if (!placement) continue;

    const calls = collapseTurnaroundCalls(departure.tripCalls ?? []);
    const nodeOf = (call: (typeof calls)[number]): ZentrumSchematicNode | undefined =>
      zentrumSchematicNodeById.get(findZentrumSchematicNodeId(call) ?? "");
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
      // The link's two ends are adjacent in the calls the placement read, but the calls between
      // them can state places of their own. The far end is the first place after it that the plan
      // draws *and* the link names; the places the plan draws before it -- calls the feed left
      // untimed -- are passed through on the vehicle path rather than spanned in a straight, and calls the
      // plan draws nothing for say nothing about the corridor at all.
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
      // A route may visit one local stop more than once. The placement states the two stop ids,
      // not the occurrence, so the closest matching pair is the least speculative occurrence and
      // keeps a mark from being sent back around the route when it is already on its later pass.
      if (
        selectedLink === undefined ||
        toIndex - index < selectedLink.toIndex - selectedLink.index
      ) {
        selectedLink = { index, toIndex, from, to, via };
      }
    }
    if (!selectedLink) continue;
    const { index, from, to, via } = selectedLink;
    const aheadEdgeIds: string[] = [];
    let leaving: { from: ZentrumSchematicNode; to: ZentrumSchematicNode } | undefined;
    if (placement.phase !== "afterEnd") {
      for (let ahead = index; ahead < calls.length - 1; ahead += 1) {
        const aheadFrom = nodeOf(calls[ahead]);
        const aheadTo = nodeOf(calls[ahead + 1]);
        if (!aheadFrom || !aheadTo || aheadFrom.id === aheadTo.id) continue;
        aheadEdgeIds.push(getEdgeKey(aheadFrom.id, aheadTo.id));
      }
    }
    if (from.id === to.id) {
      for (let ahead = index + 1; ahead < calls.length - 1; ahead += 1) {
        const aheadFrom = nodeOf(calls[ahead]);
        const aheadTo = nodeOf(calls[ahead + 1]);
        if (!aheadFrom || aheadFrom.id !== from.id || !aheadTo || aheadTo.id === from.id) continue;
        leaving = { from: aheadFrom, to: aheadTo };
        break;
      }
    }
    const markerKey = turningKeyByMarkKey.get(getRunMarkKey(departure)) ?? getRunMarkKey(departure);
    placedRuns.push({
      departure,
      trackId: trackIdByLineId.get(departure.lineId),
      edge: from.id === to.id ? undefined : edgeByKey.get(getEdgeKey(from.id, to.id)),
      from,
      to,
      progress: placement.progress,
      phase: placement.phase,
      markerKey,
      motion: placement.motion,
      placedAfterLinks: placement.placedAfterLinks,
      trajectory: placement.trajectory,
      aheadEdgeIds,
      via,
      ...(leaving ? { leaving } : {}),
    });
  }

  const placedKeys = new Set(placedRuns.map(({ departure }) => getRunMarkKey(departure)));
  const afterTurnarounds = placedRuns.filter(({ departure, phase }) => {
    const turningKey = turnarounds.turningDepartureKeyByArrivalKey.get(getRunMarkKey(departure));
    return !(phase === "afterEnd" && turningKey !== undefined && placedKeys.has(turningKey));
  });
  const endedNodeIds = new Set(
    afterTurnarounds.flatMap(({ phase, to }) => (phase === "afterEnd" ? [to.id] : [])),
  );
  return afterTurnarounds.filter((placement) => {
    if (placement.phase !== "beforeStart") return true;
    if (endedNodeIds.has(placement.from.id)) return false;
    return true;
  });
};

/**
 * The path a mark follows for one corridor of its line: its line's drawn stretch, trip-ordered.
 *
 * The stretch is the same geometry the stroke paints for that corridor, so the mark hands over
 * between corridors exactly where the stroke does. A corridor the line's drawn pattern does not
 * hold has no bend to follow; the mark follows the corridor's own lane in a straight, the way it
 * always has.
 */
const getVehiclePath = (
  reading: ZentrumSchematicReading,
  {
    departure,
    trackId,
    edge,
    from,
    to,
    via,
    leaving,
  }: Pick<
    ZentrumSchematicPlacedRun,
    "departure" | "trackId" | "edge" | "from" | "to" | "via" | "leaving"
  >,
): ZentrumSchematicVehiclePath => {
  const paths = reading.vehiclePathsByLineId.get(departure.lineId);
  // A link inside one stop -- the two tunnel calls of a complex -- is no corridor to follow. The
  // mark parks where the corridor leaving the complex begins its lane, so it stands exactly where
  // its vehicle will emerge, and falls back on the stop itself where the plan draws no leaving.
  if (from.id === to.id) {
    if (!leaving) return { points: [from], steps: [0], edgeRanges: [] };
    const leavingPath = paths?.get(getEdgeKey(leaving.from.id, leaving.to.id));
    const oriented = leavingPath
      ? leavingPath.fromNodeId === leaving.from.id
        ? leavingPath
        : reverseZentrumSchematicVehiclePath(leavingPath)
      : undefined;
    return { points: [oriented?.points[0] ?? from], steps: [0], edgeRanges: [] };
  }
  // Every drawn place between the link's ends is ridden through, on the line's own lane: the
  // pieces are the stroke's, so the path turns where the stroke turns, however many stops the
  // feed left untimed between the two it timed.
  const stops = [from, ...via, to];
  const pieces: { edgeId: string; path: ZentrumSchematicVehicleSegmentPath }[] = [];
  for (let index = 0; index < stops.length - 1; index += 1) {
    const piece = paths?.get(getEdgeKey(stops[index].id, stops[index + 1].id));
    if (!piece) break;
    pieces.push({
      edgeId: getEdgeKey(stops[index].id, stops[index + 1].id),
      path:
        piece.fromNodeId === stops[index].id ? piece : reverseZentrumSchematicVehiclePath(piece),
    });
  }
  const joined =
    pieces.length === stops.length - 1
      ? joinZentrumSchematicVehiclePaths(pieces.map(({ path }) => path))
      : undefined;
  if (joined) {
    const totalLength = pieces.reduce((sum, { path }) => sum + getPathLength(path.points), 0);
    let startLength = 0;
    const edgeRanges = pieces.map(({ edgeId, path }) => {
      const endLength = startLength + getPathLength(path.points);
      const range = {
        edgeId,
        start: totalLength > 0 ? startLength / totalLength : 0,
        end: totalLength > 0 ? endLength / totalLength : 0,
      };
      startLength = endLength;
      return range;
    });
    return { ...joined, edgeRanges };
  }
  // A corridor the line's drawn pattern does not hold has no bend to follow; the mark follows the
  // corridor's own lane in a straight, the way it always has.
  const lane = getVehicleLaneOffset(edge, trackId, reading.trackWidth);
  return {
    points: [
      { x: from.x + lane.x, y: from.y + lane.y },
      { x: to.x + lane.x, y: to.y + lane.y },
    ],
    steps: [0, 1],
    edgeRanges: edge ? [{ edgeId: edge.id, start: 0, end: 1 }] : [],
  };
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
 * Estimated positions for observed vehicles whose current link exists on the schematic.
 *
 * `getRunPlacement` owns the timing and smoothing rules. Resolving its local-stop link back onto
 * the original calls is important here: both Marktplatz tunnels share one local stop id, while
 * their provider call identities state which physical connection the vehicle traverses.
 *
 * A mark follows the lane its line is drawn in -- the drawn stretch of its line, so a vehicle stands
 * where its colour runs and turns where its colour turns -- rather than a side of the corridor of
 * its own. Both of a line's directions hold the one lane, so trams meeting cover one another for
 * the passing moment; the mark underneath is reached through the one above, which moves on.
 */
export function getZentrumSchematicVehicles(
  reading: ZentrumSchematicReading,
  departures: readonly Departure[],
  feedNow: number,
  motions: RunMotions,
): ZentrumSchematicVehicle[] {
  return getZentrumSchematicPlacedRuns(reading, departures, feedNow, motions).map(
    ({
      departure,
      trackId,
      edge,
      from,
      to,
      progress,
      phase,
      aheadEdgeIds,
      markerKey,
      motion,
      placedAfterLinks,
      trajectory,
      via,
      leaving,
    }) => {
      const path = getVehiclePath(reading, {
        departure,
        trackId,
        edge,
        from,
        to,
        via,
        leaving,
      });
      const placement = getZentrumSchematicVehiclePathPlacement(path, progress);
      return {
        id: getRunMarkKey(departure),
        markerKey,
        lineId: departure.lineId,
        destination: departure.destination,
        from,
        to,
        progress,
        phase,
        aheadEdgeIds,
        path,
        motion,
        placedAfterLinks,
        trajectory,
        x: placement.x,
        y: placement.y,
        angle: placement.angle ?? getVehicleHeadingAngle(reading, { departure, leaving }),
      };
    },
  );
}

/**
 * Which way a parked mark is pointed.
 *
 * The heading fallback only ever answers for a mark whose path states no length -- a mark parked
 * inside a stop complex, the plan drawing no corridor there. It faces the corridor its vehicle
 * will leave by, the way it is going, read off the path that begins where it stands; where not
 * even that is drawn, nothing is stated and the mark simply points along the plan's reading.
 */
const getVehicleHeadingAngle = (
  reading: ZentrumSchematicReading,
  { departure, leaving }: Pick<ZentrumSchematicPlacedRun, "departure" | "leaving">,
): number => {
  if (!leaving) return 0;
  const leavingPath = reading.vehiclePathsByLineId
    .get(departure.lineId)
    ?.get(getEdgeKey(leaving.from.id, leaving.to.id));
  const oriented = leavingPath
    ? leavingPath.fromNodeId === leaving.from.id
      ? leavingPath
      : reverseZentrumSchematicVehiclePath(leavingPath)
    : undefined;
  return (
    getZentrumSchematicVehiclePathPlacement(oriented ?? { points: [], steps: [] }, 0).angle ?? 0
  );
};

/**
 * The corridors each drawn lane's vehicles are still to run.
 *
 * Keyed by the lane, the observed corridors at least one placed vehicle of that lane still has
 * ahead of it: the one it is on now and every corridor its run comes to afterwards. A corridor no
 * vehicle is making for is named by no lane here, and the vehicle map leaves it unlit -- what the
 * map colours is the service still to come, in front of the vehicles, not the network they came
 * from. A vehicle the plan cannot place places nothing: its line keeps the corridors it was seen
 * running, and nothing is lit that no mark on the map is running towards.
 */
export function getZentrumSchematicAheadEdgeIds(
  reading: ZentrumSchematicReading,
  departures: readonly Departure[],
  feedNow: number,
  motions: RunMotions,
): ReadonlyMap<string, ReadonlySet<string>> {
  const aheadEdgeIdsByTrackId = new Map<string, Set<string>>();
  for (const { trackId, aheadEdgeIds } of getZentrumSchematicPlacedRuns(
    reading,
    departures,
    feedNow,
    motions,
  )) {
    if (!trackId) continue;
    const lanes = aheadEdgeIdsByTrackId.get(trackId) ?? new Set<string>();
    for (const edgeId of aheadEdgeIds) lanes.add(edgeId);
    aheadEdgeIdsByTrackId.set(trackId, lanes);
  }
  return aheadEdgeIdsByTrackId;
}
