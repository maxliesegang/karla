/** Bay grouping retains neighboring calls outside the drawn area. */
import type { StopEvent, Call } from "../data/transit-types";
import { type Located, getDistanceMeters, toLocalMeters } from "./geo";
import { network } from "../networks/network";
import { type BayRun, getOctilinearDirections, getTravelAxis, measureBayRun } from "./bay-runs";
import {
  BAY_RUN_VECTORS,
  type SchematicPoint,
  type ZentrumSchematicBoardingPlace,
  type ZentrumSchematicNode,
  zentrumSchematicNodeById,
  ZENTRUM_SCHEMATIC_GRID,
} from "./zentrum-schematic-plan";

const MINIMUM_PLACE_SHARE = 0.05;
const BAY_JOIN_RADIUS_METERS = 20;

/** A boarding place stands this far from its stop's main one, whatever the metres. */
const BOARDING_PLACE_STEP = ZENTRUM_SCHEMATIC_GRID * 2;

/** One bay at a stop, as the drawn journeys state it. */
type ObservedBay = {
  key: string;
  code: string;
  routes: Map<string, number>;
  routePairs: Set<string>;
  /** The stops journeys boarding here arrive from and leave for, and how many do each. */
  arms: Map<string, number>;
  callCount: number;
  latitudes: number[];
  longitudes: number[];
  /** The axis from each journey's previous call to its next, east/north at double angle. */
  travel: SchematicPoint;
};

/** The run a place's bays are known by, else as its bays and journeys show it now. */
const getPlaceBayRun = (
  bayKeys: readonly string[],
  positions: readonly { latitude: number; longitude: number }[],
  travel: SchematicPoint,
): BayRun | undefined =>
  bayKeys.map((key) => network.bayRunByKey.get(key)).find(Boolean) ??
  measureBayRun(positions, travel);

const getMedian = (values: readonly number[]): number | undefined => {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Where a bay stands: the median of where the feed placed its calls, unplaced if nowhere. */
const getBayPosition = ({ latitudes, longitudes }: ObservedBay): Located => ({
  latitude: getMedian(latitudes),
  longitude: getMedian(longitudes),
});

const isArmSubset = (left: ObservedBay, right: ObservedBay): boolean =>
  [...left.routes.keys()].every((nodeId) => right.routes.has(nodeId));

/** Bays share a place through proximity or observed through routes. */
const groupBaysIntoPlaces = (
  bays: readonly ObservedBay[],
): readonly ZentrumSchematicBoardingPlace[] => {
  const parents = bays.map((_, index) => index);
  const find = (index: number): number =>
    parents[index] === index ? index : (parents[index] = find(parents[index]));
  const join = (left: number, right: number) => {
    parents[find(left)] = find(right);
  };
  const positions = bays.map(getBayPosition);
  const getDistance = (left: number, right: number): number => {
    const { latitude, longitude } = positions[left];
    return latitude === undefined || longitude === undefined
      ? Number.POSITIVE_INFINITY
      : getDistanceMeters(latitude, longitude, positions[right]);
  };
  for (let left = 0; left < bays.length; left += 1) {
    for (let right = left + 1; right < bays.length; right += 1) {
      if (
        getDistance(left, right) <= BAY_JOIN_RADIUS_METERS ||
        [...bays[left].routePairs].some((pair) => bays[right].routePairs.has(pair))
      ) {
        join(left, right);
      }
    }
  }
  // Partial sequences join the nearest bay covering their observed neighbors.
  for (const [index, bay] of bays.entries()) {
    if (bay.routePairs.size > 0) continue;
    const holders = bays.flatMap((other, otherIndex) =>
      otherIndex !== index && isArmSubset(bay, other) ? [otherIndex] : [],
    );
    const supersets = holders.filter((holder) => !isArmSubset(bays[holder], bay));
    for (const holder of holders) if (!supersets.includes(holder)) join(index, holder);
    if (supersets.length === 0) continue;
    const nearest = [...supersets].sort(
      (left, right) =>
        getDistance(index, left) - getDistance(index, right) ||
        bays[right].callCount - bays[left].callCount,
    )[0];
    join(index, nearest);
  }

  const placeByRoot = new Map<
    number,
    {
      armJourneyCounts: Map<string, number>;
      journeyCount: number;
      bays: string[];
      bayKeys: string[];
      latitudes: number[];
      longitudes: number[];
      travel: SchematicPoint;
    }
  >();
  for (const [index, bay] of bays.entries()) {
    const place: NonNullable<ReturnType<typeof placeByRoot.get>> = placeByRoot.get(find(index)) ?? {
      armJourneyCounts: new Map(),
      journeyCount: 0,
      bays: [],
      bayKeys: [],
      latitudes: [],
      longitudes: [],
      travel: { x: 0, y: 0 },
    };
    placeByRoot.set(find(index), place);
    place.journeyCount += bay.callCount;
    place.bays.push(bay.code);
    place.bayKeys.push(bay.key);
    const position = getBayPosition(bay);
    if (position.latitude !== undefined) place.latitudes.push(position.latitude);
    if (position.longitude !== undefined) place.longitudes.push(position.longitude);
    place.travel.x += bay.travel.x;
    place.travel.y += bay.travel.y;
    for (const [nodeId, count] of bay.arms) {
      place.armJourneyCounts.set(nodeId, (place.armJourneyCounts.get(nodeId) ?? 0) + count);
    }
  }
  return [...placeByRoot.values()]
    .map(({ latitudes, longitudes, travel, ...place }) => ({
      ...place,
      bays: [...new Set(place.bays)].sort(),
      bayKeys: place.bayKeys.sort(),
      latitude: getMedian(latitudes),
      longitude: getMedian(longitudes),
      bayRun: getPlaceBayRun(
        place.bayKeys,
        latitudes.map((latitude, index) => ({ latitude, longitude: longitudes[index] })),
        travel,
      ),
    }))
    .sort(
      (left, right) =>
        right.journeyCount - left.journeyCount ||
        left.bayKeys.join().localeCompare(right.bayKeys.join()),
    );
};

/** Read boarding places from bay coordinates and complete neighboring calls. */
export const getSchematicBoardingPlaces = (
  stopEvents: readonly StopEvent[],
  nodes: ReadonlyMap<string, ZentrumSchematicNode>,
): ReadonlyMap<string, readonly ZentrumSchematicBoardingPlace[]> => {
  const baysByNodeId = new Map<string, Map<string, ObservedBay>>();
  for (const stopEvent of stopEvents) {
    const calls = stopEvent.calls ?? [];
    const nodeIds = calls.map((call) =>
      call.localStopId && nodes.has(call.localStopId) ? call.localStopId : undefined,
    );
    for (const [index, call] of calls.entries()) {
      const nodeId = nodeIds[index];
      if (!nodeId || !call.bay) continue;
      const bays = baysByNodeId.get(nodeId) ?? new Map();
      baysByNodeId.set(nodeId, bays);
      // A level and a code: the tunnel's `1(U)` and the street's `1` are two bays.
      const key = `${call.providerStopPointId ?? ""}|${call.bay}`;
      const bay: ObservedBay = bays.get(key) ?? {
        key,
        code: call.bay,
        routes: new Map(),
        routePairs: new Set(),
        arms: new Map(),
        callCount: 0,
        latitudes: [],
        longitudes: [],
        travel: { x: 0, y: 0 },
      };
      bays.set(key, bay);
      bay.callCount += 1;
      if (call.latitude !== undefined && call.longitude !== undefined) {
        bay.latitudes.push(call.latitude);
        bay.longitudes.push(call.longitude);
      }
      const [previous, next] = [calls[index - 1], calls[index + 1]];
      if (
        previous?.latitude !== undefined &&
        previous.longitude !== undefined &&
        next?.latitude !== undefined &&
        next.longitude !== undefined
      ) {
        const axis = getTravelAxis(
          { latitude: previous.latitude, longitude: previous.longitude },
          { latitude: next.latitude, longitude: next.longitude },
        );
        bay.travel.x += axis.x;
        bay.travel.y += axis.y;
      }
      const neighbors = [previous, next]
        .map((neighbor) => neighbor?.localStopId ?? neighbor?.providerStopPointId)
        .filter((id): id is string => Boolean(id) && id !== call.localStopId);
      if (neighbors.length === 2 && neighbors[0] !== neighbors[1])
        bay.routePairs.add([...neighbors].sort().join("|"));
      for (const neighbor of [calls[index - 1], calls[index + 1]]) {
        const route = neighbor?.localStopId ?? neighbor?.providerStopPointId;
        if (!route || route === call.localStopId) continue;
        bay.routes.set(route, (bay.routes.get(route) ?? 0) + 1);
      }
      // Adjacent calls only: a journey leaving the plan and returning must not invent a corridor.
      for (const armNodeId of [nodeIds[index - 1], nodeIds[index + 1]]) {
        if (!armNodeId || armNodeId === nodeId) continue;
        bay.arms.set(armNodeId, (bay.arms.get(armNodeId) ?? 0) + 1);
      }
    }
  }

  return new Map(
    [...baysByNodeId].flatMap(([nodeId, bays]) => {
      const callCount = [...bays.values()].reduce((sum, one) => sum + one.callCount, 0);
      const drawn = [...bays.values()].filter((bay) => bay.arms.size > 0);
      const places = groupBaysIntoPlaces(drawn).filter(
        (place) =>
          (place.latitude !== undefined && place.longitude !== undefined) ||
          place.journeyCount >= callCount * MINIMUM_PLACE_SHARE,
      );
      return places.length ? [[nodeId, places] as const] : [];
    }),
  );
};

/**
 * How well a place's bays run along each corridor the authored plan draws to its arms, 0 to 1.
 */
const getBayRunFits = (
  place: ZentrumSchematicBoardingPlace,
  stop: ZentrumSchematicNode,
  nodes: ReadonlyMap<string, ZentrumSchematicNode>,
): readonly number[] => {
  if (!place.bayRun) return [];
  const run = BAY_RUN_VECTORS[place.bayRun];
  return [...place.armJourneyCounts.keys()].flatMap((armId) => {
    const arm = nodes.get(armId);
    const length = arm && Math.hypot(arm.x - stop.x, arm.y - stop.y) * Math.hypot(run.x, run.y);
    return arm && length
      ? [Math.abs(run.x * (arm.x - stop.x) + run.y * (arm.y - stop.y)) / length]
      : [];
  });
};

type Segment = readonly [SchematicPoint, SchematicPoint];

/** The straight stretches between authored stops that journeys run directly between. */
const getAuthoredCorridors = (
  stopEvents: readonly StopEvent[],
  nodes: ReadonlyMap<string, ZentrumSchematicNode>,
): readonly Segment[] => {
  const byKey = new Map<string, Segment>();
  for (const { calls = [] } of stopEvents) {
    for (let index = 1; index < calls.length; index += 1) {
      const from = nodes.get(calls[index - 1].localStopId ?? "");
      const to = nodes.get(calls[index].localStopId ?? "");
      if (!from || !to || from === to) continue;
      byKey.set([from.id, to.id].sort().join("|"), [from, to]);
    }
  }
  return [...byKey.values()];
};

const getDistanceToSegment = (point: SchematicPoint, [from, to]: Segment): number => {
  const run = { x: to.x - from.x, y: to.y - from.y };
  const length = run.x * run.x + run.y * run.y;
  const along = length
    ? Math.max(0, Math.min(1, ((point.x - from.x) * run.x + (point.y - from.y) * run.y) / length))
    : 0;
  return Math.hypot(point.x - from.x - along * run.x, point.y - from.y - along * run.y);
};

/**
 * Where a boarding place stands: one step from its stop's main place, in the octilinear direction
 * nearest the real one that keeps clear of stops and corridors.
 */
const findOpenPoint = (
  main: SchematicPoint,
  offsetMeters: SchematicPoint,
  nodes: readonly SchematicPoint[],
  corridors: readonly Segment[],
): SchematicPoint => {
  const candidates = getOctilinearDirections(offsetMeters.x, -offsetMeters.y).map((direction) => ({
    x: main.x + direction.x * BOARDING_PLACE_STEP,
    y: main.y + direction.y * BOARDING_PLACE_STEP,
  }));
  return (
    candidates.find(
      (point) =>
        nodes.every(
          (node) => Math.hypot(node.x - point.x, node.y - point.y) >= BOARDING_PLACE_STEP,
        ) &&
        corridors.every(
          (corridor) => getDistanceToSegment(point, corridor) >= ZENTRUM_SCHEMATIC_GRID,
        ),
    ) ?? candidates[0]
  );
};

export function createSchematicBoardingReading(
  stopEvents: readonly StopEvent[],
  authoredNodes: ReadonlyMap<string, ZentrumSchematicNode> = zentrumSchematicNodeById,
) {
  const placesByStopId = getSchematicBoardingPlaces(stopEvents, authoredNodes);
  const corridors = getAuthoredCorridors(stopEvents, authoredNodes);
  const nodesById = new Map(authoredNodes);
  const nodeIdByBay = new Map<string, string>();
  const placesByNodeId = new Map([...placesByStopId].filter(([, places]) => places.length >= 2));
  for (const [stopId, places] of placesByStopId) {
    const base = nodesById.get(stopId);
    if (!base || places.length < 2) continue;
    const fitsByPlace = new Map(
      places.map((place) => [place, getBayRunFits(place, base, authoredNodes)]),
    );
    const getFit = (place: ZentrumSchematicBoardingPlace) => {
      const fits = fitsByPlace.get(place)!;
      return fits.length ? fits.reduce((sum, fit) => sum + fit, 0) / fits.length : 0;
    };
    const getDistance = (place: ZentrumSchematicBoardingPlace) =>
      base.geographicPosition
        ? getDistanceMeters(
            base.geographicPosition.latitude,
            base.geographicPosition.longitude,
            place,
          )
        : 0;
    const orderedPlaces = [...places].sort(
      (a, b) =>
        getFit(b) - getFit(a) ||
        getDistance(a) - getDistance(b) ||
        (a.bayKeys ?? []).join().localeCompare((b.bayKeys ?? []).join()),
    );
    const main = orderedPlaces[0];
    if (
      main.latitude === undefined ||
      main.longitude === undefined ||
      places.some((place) => place.latitude === undefined || place.longitude === undefined)
    )
      continue;
    // A place with a corridor along its bays crosses the others at the stop; one without
    // stands apart, where its line can run along it.
    const apart = orderedPlaces
      .slice(1)
      .filter((place) => place.bayRun && !fitsByPlace.get(place)!.some((fit) => fit > 1 - 1e-9));
    if (apart.length === 0) continue;
    const together = places.filter((place) => !apart.includes(place));
    nodesById.set(stopId, {
      ...base,
      bayRun: base.bayRun ?? (together.length === 1 ? main.bayRun : undefined),
    });
    placesByNodeId.set(stopId, together);
    const origin = { latitude: main.latitude, longitude: main.longitude };
    for (const place of apart) {
      const id = `${stopId}@${place.bayKeys?.[0]}`;
      const offset = toLocalMeters(place.latitude!, place.longitude!, origin);
      nodesById.set(id, {
        ...base,
        id,
        stopId,
        ...findOpenPoint(base, offset, [...nodesById.values()], corridors),
        bayRun: place.bayRun,
      });
      placesByNodeId.set(id, [place]);
      for (const key of place.bayKeys ?? []) nodeIdByBay.set(`${stopId}|${key}`, id);
    }
  }
  const resolveNodeId = (call: Call) => {
    const stopId =
      call.localStopId && authoredNodes.has(call.localStopId) ? call.localStopId : undefined;
    return stopId
      ? (nodeIdByBay.get(`${stopId}|${call.providerStopPointId ?? ""}|${call.bay ?? ""}`) ?? stopId)
      : undefined;
  };
  return { nodesById, placesByStopId, boardingPlacesByNodeId: placesByNodeId, resolveNodeId };
}
