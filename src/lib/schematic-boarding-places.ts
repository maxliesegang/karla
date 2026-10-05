/** Platform grouping retains neighboring calls outside the drawn area. */
import type { Departure, TripCall } from "../data/transit-types";
import { type Located, getDistanceMeters, toLocalMeters } from "./geo";
import { kvvPlatformRunByKey } from "../data/generated/kvv-platform-runs";
import {
  type PlatformRun,
  getOctilinearDirections,
  getTravelAxis,
  measurePlatformRun,
} from "./platform-runs";
import {
  PLATFORM_RUN_VECTORS,
  type SchematicPoint,
  type ZentrumSchematicBoardingPlace,
  type ZentrumSchematicNode,
  zentrumSchematicNodeById,
  ZENTRUM_SCHEMATIC_GRID,
} from "./zentrum-schematic-plan";

const MINIMUM_PLACE_SHARE = 0.05;
const PLATFORM_JOIN_RADIUS_METERS = 20;

/** A boarding place stands this far from its stop's main one, whatever the metres. */
const BOARDING_PLACE_STEP = ZENTRUM_SCHEMATIC_GRID * 2;

/** One platform at a stop, as the drawn trips state it. */
type ObservedPlatform = {
  key: string;
  code: string;
  routes: Map<string, number>;
  routePairs: Set<string>;
  /** The stops trips boarding here arrive from and leave for, and how many do each. */
  arms: Map<string, number>;
  callCount: number;
  latitudes: number[];
  longitudes: number[];
  /** The axis from each trip's previous call to its next, east/north at double angle. */
  travel: SchematicPoint;
};

/** The run a place's platforms are known by, else as its platforms and trips show it now. */
const getPlacePlatformRun = (
  platformKeys: readonly string[],
  positions: readonly { latitude: number; longitude: number }[],
  travel: SchematicPoint,
): PlatformRun | undefined =>
  platformKeys.map((key) => kvvPlatformRunByKey.get(key)).find(Boolean) ??
  measurePlatformRun(positions, travel);

const getMedian = (values: readonly number[]): number | undefined => {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Where a platform stands: the median of where the feed placed its calls, unplaced if nowhere. */
const getPlatformPosition = ({ latitudes, longitudes }: ObservedPlatform): Located => ({
  latitude: getMedian(latitudes),
  longitude: getMedian(longitudes),
});

const isArmSubset = (left: ObservedPlatform, right: ObservedPlatform): boolean =>
  [...left.routes.keys()].every((nodeId) => right.routes.has(nodeId));

/** Platforms share a place through proximity or observed through routes. */
const groupPlatformsIntoPlaces = (
  platforms: readonly ObservedPlatform[],
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
      if (
        getDistance(left, right) <= PLATFORM_JOIN_RADIUS_METERS ||
        [...platforms[left].routePairs].some((pair) => platforms[right].routePairs.has(pair))
      ) {
        join(left, right);
      }
    }
  }
  // Partial sequences join the nearest platform covering their observed neighbors.
  for (const [index, platform] of platforms.entries()) {
    if (platform.routePairs.size > 0) continue;
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

  const placeByRoot = new Map<
    number,
    {
      armTripCounts: Map<string, number>;
      tripCount: number;
      platformCodes: string[];
      platformKeys: string[];
      latitudes: number[];
      longitudes: number[];
      travel: SchematicPoint;
    }
  >();
  for (const [index, platform] of platforms.entries()) {
    const place: NonNullable<ReturnType<typeof placeByRoot.get>> = placeByRoot.get(find(index)) ?? {
      armTripCounts: new Map(),
      tripCount: 0,
      platformCodes: [],
      platformKeys: [],
      latitudes: [],
      longitudes: [],
      travel: { x: 0, y: 0 },
    };
    placeByRoot.set(find(index), place);
    place.tripCount += platform.callCount;
    place.platformCodes.push(platform.code);
    place.platformKeys.push(platform.key);
    const position = getPlatformPosition(platform);
    if (position.latitude !== undefined) place.latitudes.push(position.latitude);
    if (position.longitude !== undefined) place.longitudes.push(position.longitude);
    place.travel.x += platform.travel.x;
    place.travel.y += platform.travel.y;
    for (const [nodeId, count] of platform.arms) {
      place.armTripCounts.set(nodeId, (place.armTripCounts.get(nodeId) ?? 0) + count);
    }
  }
  return [...placeByRoot.values()]
    .map(({ latitudes, longitudes, travel, ...place }) => ({
      ...place,
      platformCodes: [...new Set(place.platformCodes)].sort(),
      platformKeys: place.platformKeys.sort(),
      latitude: getMedian(latitudes),
      longitude: getMedian(longitudes),
      platformRun: getPlacePlatformRun(
        place.platformKeys,
        latitudes.map((latitude, index) => ({ latitude, longitude: longitudes[index] })),
        travel,
      ),
    }))
    .sort(
      (left, right) =>
        right.tripCount - left.tripCount ||
        left.platformKeys.join().localeCompare(right.platformKeys.join()),
    );
};

/** Read boarding places from platform coordinates and complete neighboring calls. */
export const getSchematicBoardingPlaces = (
  departures: readonly Departure[],
  nodes: ReadonlyMap<string, ZentrumSchematicNode>,
): ReadonlyMap<string, readonly ZentrumSchematicBoardingPlace[]> => {
  const platformsByNodeId = new Map<string, Map<string, ObservedPlatform>>();
  for (const departure of departures) {
    const calls = departure.tripCalls ?? [];
    const nodeIds = calls.map((call) =>
      call.localStopId && nodes.has(call.localStopId) ? call.localStopId : undefined,
    );
    for (const [index, call] of calls.entries()) {
      const nodeId = nodeIds[index];
      if (!nodeId || !call.platformCode) continue;
      const platforms = platformsByNodeId.get(nodeId) ?? new Map();
      platformsByNodeId.set(nodeId, platforms);
      // A level and a code: the tunnel's `1(U)` and the street's `1` are two platforms.
      const key = `${call.providerStopPointId ?? ""}|${call.platformCode}`;
      const platform: ObservedPlatform = platforms.get(key) ?? {
        key,
        code: call.platformCode,
        routes: new Map(),
        routePairs: new Set(),
        arms: new Map(),
        callCount: 0,
        latitudes: [],
        longitudes: [],
        travel: { x: 0, y: 0 },
      };
      platforms.set(key, platform);
      platform.callCount += 1;
      if (call.latitude !== undefined && call.longitude !== undefined) {
        platform.latitudes.push(call.latitude);
        platform.longitudes.push(call.longitude);
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
        platform.travel.x += axis.x;
        platform.travel.y += axis.y;
      }
      const neighbors = [previous, next]
        .map((neighbor) => neighbor?.localStopId ?? neighbor?.providerStopPointId)
        .filter((id): id is string => Boolean(id) && id !== call.localStopId);
      if (neighbors.length === 2 && neighbors[0] !== neighbors[1])
        platform.routePairs.add([...neighbors].sort().join("|"));
      for (const neighbor of [calls[index - 1], calls[index + 1]]) {
        const route = neighbor?.localStopId ?? neighbor?.providerStopPointId;
        if (!route || route === call.localStopId) continue;
        platform.routes.set(route, (platform.routes.get(route) ?? 0) + 1);
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
      const drawn = [...platforms.values()].filter((platform) => platform.arms.size > 0);
      const places = groupPlatformsIntoPlaces(drawn).filter(
        (place) =>
          (place.latitude !== undefined && place.longitude !== undefined) ||
          place.tripCount >= callCount * MINIMUM_PLACE_SHARE,
      );
      return places.length ? [[nodeId, places] as const] : [];
    }),
  );
};

/**
 * How well a place's platforms run along each corridor the authored plan draws to its arms, 0 to 1.
 */
const getPlatformRunFits = (
  place: ZentrumSchematicBoardingPlace,
  stop: ZentrumSchematicNode,
  nodes: ReadonlyMap<string, ZentrumSchematicNode>,
): readonly number[] => {
  if (!place.platformRun) return [];
  const run = PLATFORM_RUN_VECTORS[place.platformRun];
  return [...place.armTripCounts.keys()].flatMap((armId) => {
    const arm = nodes.get(armId);
    const length = arm && Math.hypot(arm.x - stop.x, arm.y - stop.y) * Math.hypot(run.x, run.y);
    return arm && length
      ? [Math.abs(run.x * (arm.x - stop.x) + run.y * (arm.y - stop.y)) / length]
      : [];
  });
};

type Segment = readonly [SchematicPoint, SchematicPoint];

/** The straight stretches between authored stops that trips run directly between. */
const getAuthoredCorridors = (
  departures: readonly Departure[],
  nodes: ReadonlyMap<string, ZentrumSchematicNode>,
): readonly Segment[] => {
  const byKey = new Map<string, Segment>();
  for (const { tripCalls = [] } of departures) {
    for (let index = 1; index < tripCalls.length; index += 1) {
      const from = nodes.get(tripCalls[index - 1].localStopId ?? "");
      const to = nodes.get(tripCalls[index].localStopId ?? "");
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
  departures: readonly Departure[],
  authoredNodes: ReadonlyMap<string, ZentrumSchematicNode> = zentrumSchematicNodeById,
) {
  const placesByStopId = getSchematicBoardingPlaces(departures, authoredNodes);
  const corridors = getAuthoredCorridors(departures, authoredNodes);
  const nodesById = new Map(authoredNodes);
  const nodeIdByPlatform = new Map<string, string>();
  const placesByNodeId = new Map([...placesByStopId].filter(([, places]) => places.length >= 2));
  for (const [stopId, places] of placesByStopId) {
    const base = nodesById.get(stopId);
    if (!base || places.length < 2) continue;
    const fitsByPlace = new Map(
      places.map((place) => [place, getPlatformRunFits(place, base, authoredNodes)]),
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
        (a.platformKeys ?? []).join().localeCompare((b.platformKeys ?? []).join()),
    );
    const main = orderedPlaces[0];
    if (
      main.latitude === undefined ||
      main.longitude === undefined ||
      places.some((place) => place.latitude === undefined || place.longitude === undefined)
    )
      continue;
    // A place with a corridor along its platforms crosses the others at the stop; one without
    // stands apart, where its line can run along it.
    const apart = orderedPlaces
      .slice(1)
      .filter(
        (place) => place.platformRun && !fitsByPlace.get(place)!.some((fit) => fit > 1 - 1e-9),
      );
    if (apart.length === 0) continue;
    const together = places.filter((place) => !apart.includes(place));
    nodesById.set(stopId, {
      ...base,
      platformRun: base.platformRun ?? (together.length === 1 ? main.platformRun : undefined),
    });
    placesByNodeId.set(stopId, together);
    const origin = { latitude: main.latitude, longitude: main.longitude };
    for (const place of apart) {
      const id = `${stopId}@${place.platformKeys?.[0]}`;
      const offset = toLocalMeters(place.latitude!, place.longitude!, origin);
      nodesById.set(id, {
        ...base,
        id,
        stopId,
        ...findOpenPoint(base, offset, [...nodesById.values()], corridors),
        platformRun: place.platformRun,
      });
      placesByNodeId.set(id, [place]);
      for (const key of place.platformKeys ?? []) nodeIdByPlatform.set(`${stopId}|${key}`, id);
    }
  }
  const resolveNodeId = (call: TripCall) => {
    const stopId =
      call.localStopId && authoredNodes.has(call.localStopId) ? call.localStopId : undefined;
    return stopId
      ? (nodeIdByPlatform.get(
          `${stopId}|${call.providerStopPointId ?? ""}|${call.platformCode ?? ""}`,
        ) ?? stopId)
      : undefined;
  };
  return { nodesById, placesByStopId, boardingPlacesByNodeId: placesByNodeId, resolveNodeId };
}
