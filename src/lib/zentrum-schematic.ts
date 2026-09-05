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
import type { Departure, DepartureBoard } from "../data/transit-types";
import { collapseTurnaroundCalls } from "./trip-calls";
import { getDistinctTimetableTrips, getVehicleTripKey } from "./trips";
import {
  getTripPlacement,
  type TripPlacementMotion,
  type TripSegmentTrajectory,
} from "./vehicle-positioning";
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
import { getTrackBandOffsetByEdgeId, getTrackLineIdsByEdgeId } from "./zentrum-schematic-lanes";

export type ZentrumSchematicVehicle = {
  id: string;
  lineId: string;
  destination: string;
  from: ZentrumSchematicNode;
  to: ZentrumSchematicNode;
  progress: number;
  x: number;
  y: number;
  angle: number;
  /**
   * How the mark got here: only travelled motion may be animated as a journey, a placement is
   * painted where it belongs (`vehicle-positioning.ts`).
   */
  motion: TripPlacementMotion;
  /**
   * How far a placement put the mark from where it was drawn, in links of the trip's own calls —
   * what lets the mark be corrected over rather than snapped. See `TripPlacement.placedAfterLinks`.
   */
  placedAfterLinks?: number;
  /**
   * The link's motion as one appointment with its next stop, where the placement planned one: the
   * curve a drawing animates the mark along between its one-second ticks.
   */
  trajectory?: TripSegmentTrajectory;
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
 * The paths current trips actually state through the authored drawing surface.
 *
 * Calls are considered only in adjacent pairs. A trip leaving the schematic and later returning
 * therefore cannot invent a straight shortcut across it, and an unknown part of a complex breaks
 * the path instead of being guessed into the nearest node.
 */
export function buildZentrumSchematicReading(
  boards: readonly DepartureBoard[],
): ZentrumSchematicReading {
  const lineIdsByEdgeKey = new Map<string, Set<string>>();
  const pathsByLineId = new Map<
    string,
    Map<string, { nodes: readonly ZentrumSchematicNode[]; tripCount: number }>
  >();

  // The same trips the corridors are read from state where their riders board, so the places to
  // stand are read here rather than from a second pass over the boards.
  const drawnDepartures = getDistinctTimetableTrips(boards).filter(
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

  return {
    edges: lanes.map((edge) => ({
      ...edge,
      trackBandOffset: trackBandOffsetByEdgeId.get(edge.id) ?? 0,
    })),
    linePaths,
    trackWidth,
    boardingPlacesByNodeId: getZentrumSchematicBoardingPlaces(drawnDepartures),
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
type ZentrumSchematicPlacedTrip = {
  departure: Departure;
  /** The lane the line is drawn in, where the vehicle's mark rides. */
  trackId: string | undefined;
  /** The corridor the vehicle is currently on, where the reading holds one. */
  edge: ZentrumSchematicEdge | undefined;
  from: ZentrumSchematicNode;
  to: ZentrumSchematicNode;
  progress: number;
  motion: TripPlacementMotion;
  placedAfterLinks?: number;
  trajectory?: TripSegmentTrajectory;
  /** The corridors from the one the vehicle is on to the end of its run through the plan. */
  aheadEdgeIds: readonly string[];
};

const getZentrumSchematicPlacedTrips = (
  reading: ZentrumSchematicReading,
  departures: readonly Departure[],
  feedNow: number,
): readonly ZentrumSchematicPlacedTrip[] => {
  const edgeByKey = new Map(reading.edges.map((edge) => [edge.id, edge]));
  const trackIdByLineId = getTrackIdByLineId(reading.linePaths.map(({ lineId }) => lineId));
  return departures.flatMap((departure) => {
    if (departure.transportMode !== "tram" && departure.transportMode !== "lightRail") return [];
    const placement = getTripPlacement(departure, feedNow);
    if (!placement || placement.phase !== "running") return [];

    const calls = collapseTurnaroundCalls(departure.tripCalls ?? []);
    for (let index = 0; index < calls.length - 1; index += 1) {
      const fromCall = calls[index];
      const toCall = calls[index + 1];
      if (
        fromCall.localStopId !== placement.fromStopId ||
        toCall.localStopId !== placement.toStopId
      ) {
        continue;
      }
      const from = zentrumSchematicNodeById.get(findZentrumSchematicNodeId(fromCall) ?? "");
      const to = zentrumSchematicNodeById.get(findZentrumSchematicNodeId(toCall) ?? "");
      if (!from || !to || from.id === to.id) continue;
      const aheadEdgeIds: string[] = [];
      for (let ahead = index; ahead < calls.length - 1; ahead += 1) {
        const aheadFrom = zentrumSchematicNodeById.get(
          findZentrumSchematicNodeId(calls[ahead]) ?? "",
        );
        const aheadTo = zentrumSchematicNodeById.get(
          findZentrumSchematicNodeId(calls[ahead + 1]) ?? "",
        );
        if (!aheadFrom || !aheadTo || aheadFrom.id === aheadTo.id) continue;
        aheadEdgeIds.push(getEdgeKey(aheadFrom.id, aheadTo.id));
      }
      return [
        {
          departure,
          trackId: trackIdByLineId.get(departure.lineId),
          edge: edgeByKey.get(getEdgeKey(from.id, to.id)),
          from,
          to,
          progress: placement.progress,
          motion: placement.motion,
          placedAfterLinks: placement.placedAfterLinks,
          trajectory: placement.trajectory,
          aheadEdgeIds,
        },
      ];
    }
    return [];
  });
};

/**
 * Estimated positions for observed vehicles whose current adjacent calls exist on the schematic.
 *
 * `getTripPlacement` owns the timing and smoothing rules. Resolving its local-stop link back onto
 * the original adjacent calls is important here: both Marktplatz tunnels share one local stop id,
 * while their provider call identities state which physical connection the vehicle traverses.
 *
 * A mark rides the lane its line is drawn in -- the path of its line, so a vehicle stands where its
 * colour runs -- rather than a side of the corridor of its own. Both of a line's directions hold
 * the one lane, so trams meeting cover one another for the passing moment; the mark underneath is
 * reached through the one above, which moves on. `trackWidth` is the reading's own: left undefined,
 * as the plan's reading does, every mark rides the middle of the corridor, which is where that
 * reading draws its one line.
 */
export function getZentrumSchematicVehicles(
  reading: ZentrumSchematicReading,
  departures: readonly Departure[],
  feedNow: number,
  trackWidth: number | undefined,
): ZentrumSchematicVehicle[] {
  return getZentrumSchematicPlacedTrips(reading, departures, feedNow).map(
    ({ departure, trackId, edge, from, to, progress, motion, placedAfterLinks, trajectory }) => {
      const lane = getVehicleLaneOffset(edge, trackId, trackWidth);
      const x = from.x + (to.x - from.x) * progress + lane.x;
      const y = from.y + (to.y - from.y) * progress + lane.y;
      return {
        id: getVehicleTripKey(departure),
        lineId: departure.lineId,
        destination: departure.destination,
        from,
        to,
        progress,
        motion,
        placedAfterLinks,
        trajectory,
        x,
        y,
        angle: (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI,
      };
    },
  );
}

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
): ReadonlyMap<string, ReadonlySet<string>> {
  const aheadEdgeIdsByTrackId = new Map<string, Set<string>>();
  for (const { trackId, aheadEdgeIds } of getZentrumSchematicPlacedTrips(
    reading,
    departures,
    feedNow,
  )) {
    if (!trackId) continue;
    const lanes = aheadEdgeIdsByTrackId.get(trackId) ?? new Set<string>();
    for (const edgeId of aheadEdgeIds) lanes.add(edgeId);
    aheadEdgeIdsByTrackId.set(trackId, lanes);
  }
  return aheadEdgeIdsByTrackId;
}
