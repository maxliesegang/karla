/**
 * What is running through the Zentrum, read onto the plan: which corridors today's trips state,
 * which lane each line holds, where platforms stand, and where each vehicle is. A corridor no trip
 * states is not drawn, so a line that stops running leaves the plan by itself.
 */
import type { Departure, TripCall } from "../data/transit-types";
import { collapseTurnaroundCalls, getTripCallInstant } from "./trip-calls";
import { getDistinctTimetableTrips, getRunMarkKey } from "./trips";
import {
  getRunPlacement,
  type RunMotions,
  type RunPlacementMotion,
  type RunPlacementPhase,
  type RunSegmentTrajectory,
} from "./vehicle-positioning";
import { type Located, getDistanceMeters } from "./geo";
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
  findZentrumSchematicNodeId,
  getEdgeKey,
  getTrackIdByLineId,
  getTrackOffset,
  getZentrumSchematicTrackWidth,
  isRailDeparture,
  orientCorridorRun,
  zentrumSchematicNodeById,
} from "./zentrum-schematic-plan";
import {
  type ZentrumSchematicDrawnPath,
  getZentrumSchematicDrawnPaths,
  getZentrumSchematicVehiclePathPlacement,
  getZentrumSchematicVehiclePathsByEdgeId,
  joinZentrumSchematicVehiclePaths,
  orientZentrumSchematicVehiclePath,
  type ZentrumSchematicVehiclePath as ZentrumSchematicVehicleSegmentPath,
} from "./zentrum-schematic-paths";
import { getTrackBandOffsetByEdgeId, getTrackLineIdsByEdgeId } from "./zentrum-schematic-lanes";
import {
  getZentrumSchematicStopMarks,
  type ZentrumSchematicStopMark,
} from "./zentrum-schematic-stops";

export type ZentrumSchematicVehicle = {
  id: string;
  /** The run the mark stands for. */
  departure: Departure;
  markerKey?: string;
  lineId: string;
  destination: string;
  from: ZentrumSchematicNode;
  to: ZentrumSchematicNode;
  progress: number;
  phase?: RunPlacementPhase;
  /** Every drawn corridor from the one the vehicle is on through the end of its run. */
  aheadEdgeIds: readonly string[];
  /** The drawn stops the run still calls at, in order, from the one its link leaves. */
  aheadStops: readonly ZentrumSchematicAheadStop[];
  x: number;
  y: number;
  angle: number;
  /** The stretch of its line's lane the mark follows, turned the way this run travels it. */
  path: ZentrumSchematicVehiclePath;
  /** Only travelled motion is animated as a journey; a placement is painted where it belongs. */
  motion: RunPlacementMotion;
  /** See `RunPlacement.placedAfterLinks`. */
  placedAfterLinks?: number;
  /** The curve the mark is animated along between ticks, where the placement planned one. */
  trajectory?: RunSegmentTrajectory;
};

/** One drawn stop ahead of a vehicle, as its trip states it. */
export type ZentrumSchematicAheadStop = {
  nodeId: string;
  /** The call the run leaves the stop by: the last of a complex's calls. */
  call: TripCall;
  /** When the run is expected to leave the stop. */
  departsAt?: number;
  /** Where the stop stands along the mark's path, if the path runs through it. */
  pathProgress?: number;
};

/**
 * The stretch of lane a mark follows, in the run's direction. A link inside one complex (its two
 * tunnel calls) is a single point, where the mark parks while the vehicle crosses.
 */
export type ZentrumSchematicVehiclePath = {
  /** The first point is where the mark stands at progress 0. */
  points: readonly SchematicPoint[];
  /** Each point's share of the path's length, ascending to 1. */
  steps: readonly number[];
  /** The corridors making up the path, with their ranges of its progress. */
  edgeRanges: readonly ZentrumSchematicVehiclePathEdgeRange[];
};

export type ZentrumSchematicVehiclePathEdgeRange = {
  edgeId: string;
  start: number;
  end: number;
};

/** The plan as laid out for what runs over it: everything that holds whatever the lane width. */
export type ZentrumSchematicLayout = {
  /** Identifies the layout: two layouts with one key place the same lanes. */
  layoutKey: string;
  edges: readonly ZentrumSchematicEdge[];
  linePaths: readonly ZentrumSchematicLinePath[];
  /** Every drawn line, in legend order. */
  lineIds: readonly string[];
  lineIdsByNodeId: ReadonlyMap<string, readonly string[]>;
  /** The stops with more than one place to stand, and those places. */
  boardingPlacesByNodeId: ReadonlyMap<string, readonly ZentrumSchematicBoardingPlace[]>;
};

/** The layout drawn at one lane width, with every geometry that follows from that. */
export type ZentrumSchematicReading = ZentrumSchematicLayout & {
  /** The lane width, which is also the lane pitch, so neighbouring lanes meet exactly. */
  trackWidth: number;
  /** The strokes the drawing paints. */
  drawnPaths: readonly ZentrumSchematicDrawnPath[];
  /** The stretch a mark follows, by line and corridor, so placing a vehicle is a lookup. */
  vehiclePathsByLineId: ReadonlyMap<
    string,
    ReadonlyMap<string, ZentrumSchematicVehicleSegmentPath>
  >;
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
 * The share of a stop's calls a platform needs before it is drawn as a place. Rarely used ones are
 * diversions or layovers (Marktplatz `5(U)`: nine calls against a thousand).
 */
const ZENTRUM_SCHEMATIC_BOARDING_PLACE_MINIMUM_SHARE = 0.05;

/**
 * How near two platforms stand to be one place whatever runs through them: the two islands of the
 * Hauptbahnhof's forecourt each serve the S-Bahn and the trams, and are one stop to a rider. Places
 * a rider walks between stand fifty metres and more apart.
 */
const ZENTRUM_SCHEMATIC_BOARDING_PLACE_RADIUS_METERS = 20;

/** One platform at a stop, as the drawn trips state it. */
type ZentrumSchematicPlatform = {
  /** The stops trips boarding here arrive from and leave for, and how many do each. */
  arms: Map<string, number>;
  callCount: number;
  latitudes: number[];
  longitudes: number[];
};

const getMedian = (values: readonly number[]): number | undefined =>
  values.length === 0
    ? undefined
    : [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];

/** Where a platform stands: the median of where the feed placed its calls, unplaced if nowhere. */
const getPlatformPosition = ({ latitudes, longitudes }: ZentrumSchematicPlatform): Located => ({
  latitude: getMedian(latitudes),
  longitude: getMedian(longitudes),
});

const isArmSubset = (left: ZentrumSchematicPlatform, right: ZentrumSchematicPlatform): boolean =>
  [...left.arms.keys()].every((nodeId) => right.arms.has(nodeId));

/**
 * A stop's platforms grouped into places: platforms standing together, or one serving only
 * corridors another serves (Europaplatz's Kaiserstraße platforms join its tunnel; the Karlstraße
 * ones serve the south branch and stay apart). Contested platforms go to the nearer place.
 */
const groupPlatformsIntoPlaces = (
  platforms: readonly ZentrumSchematicPlatform[],
): readonly ZentrumSchematicBoardingPlace[] => {
  const parents = platforms.map((_, index) => index);
  const find = (index: number): number =>
    parents[index] === index ? index : (parents[index] = find(parents[index]));
  const join = (left: number, right: number) => {
    parents[find(left)] = find(right);
  };
  const positions = platforms.map(getPlatformPosition);
  const getDistance = (left: number, right: number): number => {
    const { latitude, longitude } = positions[left];
    return latitude === undefined || longitude === undefined
      ? Number.POSITIVE_INFINITY
      : getDistanceMeters(latitude, longitude, positions[right]);
  };
  for (let left = 0; left < platforms.length; left += 1) {
    for (let right = left + 1; right < platforms.length; right += 1) {
      if (getDistance(left, right) <= ZENTRUM_SCHEMATIC_BOARDING_PLACE_RADIUS_METERS) {
        join(left, right);
      }
    }
  }
  // Platforms serving the same corridors are one place; one serving fewer joins the nearest that
  // serves them all.
  for (const [index, platform] of platforms.entries()) {
    const holders = platforms.flatMap((other, otherIndex) =>
      otherIndex !== index && isArmSubset(platform, other) ? [otherIndex] : [],
    );
    const supersets = holders.filter((holder) => !isArmSubset(platforms[holder], platform));
    for (const holder of holders) if (!supersets.includes(holder)) join(index, holder);
    if (supersets.length === 0) continue;
    const nearest = [...supersets].sort(
      (left, right) =>
        getDistance(index, left) - getDistance(index, right) ||
        platforms[right].callCount - platforms[left].callCount,
    )[0];
    join(index, nearest);
  }

  const placeByRoot = new Map<number, { armTripCounts: Map<string, number>; tripCount: number }>();
  for (const [index, platform] of platforms.entries()) {
    const place = placeByRoot.get(find(index)) ?? { armTripCounts: new Map(), tripCount: 0 };
    placeByRoot.set(find(index), place);
    place.tripCount += platform.callCount;
    for (const [nodeId, count] of platform.arms) {
      place.armTripCounts.set(nodeId, (place.armTripCounts.get(nodeId) ?? 0) + count);
    }
  }
  return [...placeByRoot.values()].sort((left, right) => right.tripCount - left.tripCount);
};

/**
 * The places to stand at stops that have more than one, read from the platforms the drawn trips
 * call at. A stop whose platforms are all one place comes back with nothing.
 */
const getZentrumSchematicBoardingPlaces = (
  departures: readonly Departure[],
): ReadonlyMap<string, readonly ZentrumSchematicBoardingPlace[]> => {
  const platformsByNodeId = new Map<string, Map<string, ZentrumSchematicPlatform>>();
  for (const departure of departures) {
    const calls = departure.tripCalls ?? [];
    const nodeIds = calls.map((call) => findZentrumSchematicNodeId(call));
    for (const [index, call] of calls.entries()) {
      const nodeId = nodeIds[index];
      if (!nodeId || !call.platformCode) continue;
      const platforms = platformsByNodeId.get(nodeId) ?? new Map();
      platformsByNodeId.set(nodeId, platforms);
      // A level and a code: the tunnel's `1(U)` and the street's `1` are two platforms.
      const key = `${call.providerStopPointId ?? ""}|${call.platformCode}`;
      const platform: ZentrumSchematicPlatform = platforms.get(key) ?? {
        arms: new Map(),
        callCount: 0,
        latitudes: [],
        longitudes: [],
      };
      platforms.set(key, platform);
      platform.callCount += 1;
      if (call.latitude !== undefined && call.longitude !== undefined) {
        platform.latitudes.push(call.latitude);
        platform.longitudes.push(call.longitude);
      }
      // Adjacent calls only: a trip leaving the plan and returning must not invent a corridor.
      for (const armNodeId of [nodeIds[index - 1], nodeIds[index + 1]]) {
        if (!armNodeId || armNodeId === nodeId) continue;
        platform.arms.set(armNodeId, (platform.arms.get(armNodeId) ?? 0) + 1);
      }
    }
  }

  return new Map(
    [...platformsByNodeId].flatMap(([nodeId, platforms]) => {
      const callCount = [...platforms.values()].reduce((sum, one) => sum + one.callCount, 0);
      const drawn = [...platforms.values()].filter(
        (platform) =>
          platform.arms.size > 0 &&
          platform.callCount >= callCount * ZENTRUM_SCHEMATIC_BOARDING_PLACE_MINIMUM_SHARE,
      );
      const places = groupPlatformsIntoPlaces(drawn);
      return places.length >= 2 ? [[nodeId, places] as const] : [];
    }),
  );
};

/** What the drawn runs state about the plan, before any of it is laid out. */
type ZentrumSchematicObservation = {
  /** Every corridor a drawn run states, in id order so the same corridors always read alike. */
  edges: readonly ZentrumSchematicObservedEdge[];
  linePaths: readonly ZentrumSchematicLinePath[];
  lineIdsByNodeId: ReadonlyMap<string, readonly string[]>;
  boardingPlacesByNodeId: ReadonlyMap<string, readonly ZentrumSchematicBoardingPlace[]>;
};

/**
 * The paths the drawn runs state through the plan. Calls count only in adjacent pairs, so a trip
 * leaving and returning invents no shortcut, and an unknown call breaks the path.
 */
const observeZentrumSchematic = (
  drawnVehicles: readonly Departure[],
): ZentrumSchematicObservation => {
  const lineIdsByEdgeKey = new Map<string, Set<string>>();
  const pathsByLineId = new Map<
    string,
    Map<string, { nodes: readonly ZentrumSchematicNode[]; tripCount: number }>
  >();

  const drawnDepartures = getDistinctTimetableTrips(drawnVehicles).filter(
    (departure) => departure.status !== "cancelled" && isRailDeparture(departure),
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
  const edges: ZentrumSchematicObservedEdge[] = [...lineIdsByEdgeKey.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .flatMap(([key, lineIds]) => {
      const [fromId, toId] = key.split("\u0000");
      const from = zentrumSchematicNodeById.get(fromId);
      const to = zentrumSchematicNodeById.get(toId);
      if (!from || !to) return [];
      const sortedLineIds = [...lineIds].sort(compareLineIdsNaturally);
      for (const node of [from, to]) {
        const nodeLineIds = lineIdsByNodeId.get(node.id) ?? new Set<string>();
        for (const lineId of sortedLineIds) nodeLineIds.add(lineId);
        lineIdsByNodeId.set(node.id, nodeLineIds);
      }
      return [{ id: key, from, to, lineIds: sortedLineIds }];
    });

  // Each line is drawn by the path most distinct trips take, not every short working. Ties go to
  // the longer path, then the key, so refresh order cannot make the drawing flicker.
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
        compareLineIdsNaturally(left.lineId, right.lineId) || left.id.localeCompare(right.id),
    );

  const trackIdByLineId = getTrackIdByLineId(drawnPaths.map(({ lineId }) => lineId));
  return {
    edges,
    linePaths: drawnPaths.map((linePath) => ({
      ...linePath,
      trackId: trackIdByLineId.get(linePath.lineId) ?? linePath.lineId,
    })),
    lineIdsByNodeId: new Map(
      [...lineIdsByNodeId].map(([nodeId, lineIds]) => [
        nodeId,
        [...lineIds].sort(compareLineIdsNaturally),
      ]),
    ),
    boardingPlacesByNodeId: getZentrumSchematicBoardingPlaces(drawnDepartures),
  };
};

/** The lanes laid out for what was observed: the plan's one expensive step. */
const layOutZentrumSchematic = (
  {
    edges: observedEdges,
    linePaths,
    lineIdsByNodeId,
    boardingPlacesByNodeId,
  }: ZentrumSchematicObservation,
  layoutKey: string,
): ZentrumSchematicLayout => {
  const trackLineIdsByEdgeId = getTrackLineIdsByEdgeId(observedEdges, linePaths);
  const lanes: readonly ZentrumSchematicLanedEdge[] = observedEdges.map((edge) => ({
    ...edge,
    trackLineIds: trackLineIdsByEdgeId.get(edge.id) ?? [],
  }));
  const trackBandOffsetByEdgeId = getTrackBandOffsetByEdgeId(lanes, linePaths);
  const edges: readonly ZentrumSchematicEdge[] = lanes.map((edge) => ({
    ...edge,
    trackBandOffset: trackBandOffsetByEdgeId.get(edge.id) ?? 0,
  }));
  return {
    layoutKey,
    edges,
    linePaths,
    lineIds: [...new Set(edges.flatMap((edge) => edge.lineIds))].sort(compareLineIds),
    lineIdsByNodeId,
    boardingPlacesByNodeId,
  };
};

/** Everything the layout depends on: the corridors and the drawn patterns. */
const getZentrumSchematicLayoutKey = ({ edges, linePaths }: ZentrumSchematicObservation): string =>
  [
    ...edges.map(({ id, lineIds }) => `${id}\u0001${lineIds.join(",")}`),
    ...linePaths.map(({ id, trackId }) => `${id}\u0001${trackId}`),
  ].join("\u0002");

/** One reading, for a caller that keeps none between refreshes. */
export function buildZentrumSchematicReading(
  drawnVehicles: readonly Departure[],
  planWidth?: number,
): ZentrumSchematicReading {
  return createZentrumSchematicDrawer()(createZentrumSchematicReader()(drawnVehicles), planWidth);
}

/**
 * A reader that lays the plan out again only when corridors or drawn patterns changed, since the
 * layout costs tens of milliseconds and runs change every few seconds. Boarding places can change
 * alone; the lanes are kept then.
 */
export function createZentrumSchematicReader(): (
  drawnVehicles: readonly Departure[],
) => ZentrumSchematicLayout {
  let last: { placesKey: string; layout: ZentrumSchematicLayout } | undefined;
  return (drawnVehicles) => {
    const observation = observeZentrumSchematic(drawnVehicles);
    const layoutKey = getZentrumSchematicLayoutKey(observation);
    const placesKey = getBoardingPlacesKey(observation.boardingPlacesByNodeId);
    const isSameLayout = last?.layout.layoutKey === layoutKey;
    if (last && isSameLayout && last.placesKey === placesKey) return last.layout;
    const layout =
      last && isSameLayout
        ? { ...last.layout, boardingPlacesByNodeId: observation.boardingPlacesByNodeId }
        : layOutZentrumSchematic(observation, layoutKey);
    last = { placesKey, layout };
    return layout;
  };
}

/**
 * A drawer that lays a layout's lanes at the plan's on-screen width, so a resize redraws geometry
 * without re-solving lanes. The same width returns the same reading.
 */
export function createZentrumSchematicDrawer(): (
  layout: ZentrumSchematicLayout,
  planWidth: number | undefined,
) => ZentrumSchematicReading {
  let last: ZentrumSchematicReading | undefined;
  let lastLayout: ZentrumSchematicLayout | undefined;
  return (layout, planWidth) => {
    const trackWidth = getZentrumSchematicTrackWidth(layout.edges, planWidth);
    if (last && lastLayout === layout && last.trackWidth === trackWidth) return last;
    const { edges, linePaths } = layout;
    const stopMarks = getZentrumSchematicStopMarks(
      edges,
      linePaths,
      trackWidth,
      layout.boardingPlacesByNodeId,
    );
    // From the final edges, so marks ride the painted geometry and halt at the capsules.
    const stopLinesByNodeId = new Map(stopMarks.map(({ nodeId, capsules }) => [nodeId, capsules]));
    const vehiclePathsByLineId = new Map(
      linePaths.map((linePath) => [
        linePath.lineId,
        getZentrumSchematicVehiclePathsByEdgeId(linePath, edges, trackWidth, stopLinesByNodeId),
      ]),
    );
    last = {
      ...layout,
      trackWidth,
      drawnPaths: getZentrumSchematicDrawnPaths(linePaths, edges, trackWidth, vehiclePathsByLineId),
      vehiclePathsByLineId,
      stopMarks,
    };
    lastLayout = layout;
    return last;
  };
}

const getBoardingPlacesKey = (
  placesByNodeId: ReadonlyMap<string, readonly ZentrumSchematicBoardingPlace[]>,
): string =>
  [...placesByNodeId]
    .map(
      ([nodeId, places]) =>
        `${nodeId}:${places
          .map(({ armTripCounts, tripCount }) => `${tripCount}=${[...armTripCounts].join(",")}`)
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
  const laneIndex = edge.trackLineIds.indexOf(trackId);
  if (laneIndex < 0) return { x: 0, y: 0 };
  const offset = getTrackOffset(edge, laneIndex, trackWidth);
  const run = orientCorridorRun(edge);
  return { x: -run.y * offset, y: run.x * offset };
};

/** One observed vehicle placed on the plan, and the run it still has ahead of it. */
type ZentrumSchematicPlacedRun = {
  departure: Departure;
  /** The lane the line is drawn in. */
  trackId: string | undefined;
  /** The corridor the vehicle is on, if the reading holds one. */
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
  /** The drawn stops from the one the link leaves, not yet measured along the path. */
  aheadStops: readonly Omit<ZentrumSchematicAheadStop, "pathProgress">[];
  /**
   * Drawn stops between the link's ends that the feed left untimed. The path runs through them on
   * the line's lane rather than straight across.
   */
  via: readonly ZentrumSchematicNode[];
  /** For a link inside a complex: the corridor the trip leaves it by, where the mark parks. */
  leaving?: { from: ZentrumSchematicNode; to: ZentrumSchematicNode };
};

const getZentrumSchematicPlacedRuns = (
  reading: ZentrumSchematicReading,
  departures: readonly Departure[],
  feedNow: number,
  motions: RunMotions,
  turnarounds: TurnaroundIndex,
): readonly ZentrumSchematicPlacedRun[] => {
  const edgeByKey = new Map(reading.edges.map((edge) => [edge.id, edge]));
  const trackIdByLineId = new Map(
    reading.linePaths.map(({ lineId, trackId }) => [lineId, trackId]),
  );
  const turningKeyByMarkKey = new Map<string, string>();
  for (const [arrivalKey, departureKey] of turnarounds.turningDepartureKeyByArrivalKey) {
    turningKeyByMarkKey.set(arrivalKey, departureKey);
    turningKeyByMarkKey.set(departureKey, departureKey);
  }

  const placedRuns: ZentrumSchematicPlacedRun[] = [];
  for (const departure of departures) {
    if (!isRailDeparture(departure)) continue;
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
    const { index, from, to, via } = selectedLink;
    const aheadEdgeIds: string[] = [];
    const aheadStops: Omit<ZentrumSchematicAheadStop, "pathProgress">[] = [];
    let leaving: { from: ZentrumSchematicNode; to: ZentrumSchematicNode } | undefined;
    if (placement.phase !== "afterEnd") {
      for (let ahead = index; ahead < calls.length - 1; ahead += 1) {
        const aheadFrom = nodeOf(calls[ahead]);
        const aheadTo = nodeOf(calls[ahead + 1]);
        if (!aheadFrom || !aheadTo || aheadFrom.id === aheadTo.id) continue;
        aheadEdgeIds.push(getEdgeKey(aheadFrom.id, aheadTo.id));
      }
      for (let ahead = index; ahead < calls.length; ahead += 1) {
        const node = nodeOf(calls[ahead]);
        if (!node) continue;
        const departsAt = getTripCallInstant(calls[ahead]);
        // The calls of one complex are one stop to a rider, left when its last call is.
        const last = aheadStops.at(-1);
        if (last?.nodeId === node.id) {
          last.call = calls[ahead];
          last.departsAt = departsAt ?? last.departsAt;
        } else aheadStops.push({ nodeId: node.id, call: calls[ahead], departsAt });
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
      aheadStops,
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

/** The path a mark follows over its link: its line's drawn stretches, in trip order. */
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
  // Inside a complex the mark parks where its vehicle will emerge, else on the stop.
  if (from.id === to.id) {
    const leavingPath = getLeavingPath(reading, departure, leaving);
    return { points: [leavingPath?.points[0] ?? from], steps: [0], edgeRanges: [] };
  }
  const stops = [from, ...via, to];
  const pieces: { edgeId: string; path: ZentrumSchematicVehicleSegmentPath }[] = [];
  for (let index = 0; index < stops.length - 1; index += 1) {
    const piece = paths?.get(getEdgeKey(stops[index].id, stops[index + 1].id));
    if (!piece) break;
    pieces.push({
      edgeId: getEdgeKey(stops[index].id, stops[index + 1].id),
      path: orientZentrumSchematicVehiclePath(piece, stops[index].id),
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
  // A corridor the line's drawn pattern does not hold: a straight along the corridor's lane.
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

/** The stops ahead, each measured where its corridor's range on the mark's path ends. */
const measureAheadStops = (
  aheadStops: readonly Omit<ZentrumSchematicAheadStop, "pathProgress">[],
  pathStops: readonly ZentrumSchematicNode[],
  path: ZentrumSchematicVehiclePath,
): readonly ZentrumSchematicAheadStop[] => {
  const isMeasured = path.edgeRanges.length === pathStops.length - 1;
  let next = 0;
  return aheadStops.map((stop) => {
    if (next >= pathStops.length || stop.nodeId !== pathStops[next].id) return stop;
    const index = next;
    next += 1;
    const pathProgress =
      index === 0
        ? 0
        : isMeasured
          ? path.edgeRanges[index - 1].end
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
 * Positions for observed vehicles whose current link is drawn; `getRunPlacement` owns the timing.
 * Marks ride their line's lane both ways, so meeting trams briefly overlap. Callers ticking every
 * second pass precomputed turnarounds.
 */
export function getZentrumSchematicVehicles(
  reading: ZentrumSchematicReading,
  departures: readonly Departure[],
  feedNow: number,
  motions: RunMotions,
  turnarounds: TurnaroundIndex = findTurnarounds(departures),
): ZentrumSchematicVehicle[] {
  return getZentrumSchematicPlacedRuns(reading, departures, feedNow, motions, turnarounds).map(
    ({
      departure,
      trackId,
      edge,
      from,
      to,
      progress,
      phase,
      aheadEdgeIds,
      aheadStops,
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
        departure,
        markerKey,
        lineId: departure.lineId,
        destination: departure.destination,
        from,
        to,
        progress,
        phase,
        aheadEdgeIds,
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
        angle: placement.angle ?? getVehicleHeadingAngle(reading, { departure, leaving }),
      };
    },
  );
}

/** Which way a mark parked inside a complex points: along the corridor it will leave by. */
const getVehicleHeadingAngle = (
  reading: ZentrumSchematicReading,
  { departure, leaving }: Pick<ZentrumSchematicPlacedRun, "departure" | "leaving">,
): number => {
  const leavingPath = getLeavingPath(reading, departure, leaving);
  return leavingPath ? (getZentrumSchematicVehiclePathPlacement(leavingPath, 0).angle ?? 0) : 0;
};

/** The line's drawn path out of a stop complex, the way the run will leave by it. */
const getLeavingPath = (
  reading: ZentrumSchematicReading,
  departure: Departure,
  leaving: ZentrumSchematicPlacedRun["leaving"],
): ZentrumSchematicVehicleSegmentPath | undefined => {
  if (!leaving) return undefined;
  const path = reading.vehiclePathsByLineId
    .get(departure.lineId)
    ?.get(getEdgeKey(leaving.from.id, leaving.to.id));
  return path && orientZentrumSchematicVehiclePath(path, leaving.from.id);
};
