/**
 * The region plan's nodes, derived from the observed network: in the home place only junctions and
 * ends; every other place once per branch. Solved into an octilinear drawing offline
 * (`npm run solve:region`).
 */
import {
  type GeoLink,
  type GeoNetwork,
  type GeoStop,
  getGeoLinkId,
  type MapZones,
} from "./geo-map";

/** The place whose stops the plan reduces to junctions and ends. */
export const REGION_HOME_PLACE_NAME = "Karlsruhe";

export type RegionNode = {
  /** The stop the node is drawn for, and the id it opens by. */
  id: string;
  label: string;
  placeName?: string;
  /** Every stop the node stands for, its own included. */
  stopIds: readonly string[];
  lineIds: readonly string[];
};

export type RegionEdge = { fromId: string; toId: string; lineIds: readonly string[] };

export type RegionPlanNodes = { nodes: readonly RegionNode[]; edges: readonly RegionEdge[] };

/** How a region plan shrinks with distance from Marktplatz. */
export type RegionScaleName = "fisheye" | "zones" | "arms";

/** The solved drawing, in grid units, as `npm run solve:region` writes it. */
export type RegionPlan = {
  grid: number;
  viewBox: { x: number; y: number; width: number; height: number };
  /** The east–west axis through the Zentrum, west to east. */
  axis: readonly string[];
  /** Where each zone ends; only a zoned plan has them. */
  zones?: MapZones;
  nodes: readonly (RegionNode & { x: number; y: number; labelSide?: string })[];
  /** `bends` are the corners an edge turns at, in order from its `fromId`. */
  edges: readonly (RegionEdge & { bends?: readonly { x: number; y: number }[] })[];
};

const sameSet = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value) => right.includes(value));

/** The node a stop is drawn as, if any; a passed stop of the home place has none. */
export const findRegionNodeId = (plan: RegionPlanNodes, stopId: string): string | undefined =>
  plan.nodes.find(({ stopIds }) => stopIds.includes(stopId))?.id;

/** Stops this close, of one place and one name before any "/", are one station. */
const STATION_RADIUS_METRES = 500;

const stationName = (name: string): string => name.split("/")[0].trim();

const metresBetween = (left: GeoStop, right: GeoStop): number =>
  Math.hypot(
    (left.latitude - right.latitude) * 111_000,
    (left.longitude - right.longitude) * 111_000 * Math.cos((left.latitude * Math.PI) / 180),
  );

/**
 * One station's stops as one, kept as the stop most lines call; a loop between them disappears.
 * `aliases` lists the stops each kept stop absorbed.
 */
export function mergeStations(network: GeoNetwork): {
  network: GeoNetwork;
  aliases: ReadonlyMap<string, readonly string[]>;
} {
  const stops = [...network.stops.values()].sort(
    (left, right) => right.lineIds.length - left.lineIds.length || left.id.localeCompare(right.id),
  );
  const keptIdOf = new Map<string, string>();
  for (const [index, stop] of stops.entries()) {
    const kept = stops
      .slice(0, index)
      .find(
        (other) =>
          keptIdOf.get(other.id) === other.id &&
          other.placeName === stop.placeName &&
          stationName(other.name) === stationName(stop.name) &&
          metresBetween(other, stop) < STATION_RADIUS_METRES,
      );
    keptIdOf.set(stop.id, kept?.id ?? stop.id);
  }

  const merged = new Map<string, GeoStop>();
  const aliases = new Map<string, string[]>();
  for (const stop of stops) {
    const keptId = keptIdOf.get(stop.id) ?? stop.id;
    const kept = merged.get(keptId);
    if (!kept) {
      merged.set(keptId, stop);
      continue;
    }
    merged.set(keptId, { ...kept, lineIds: [...new Set([...kept.lineIds, ...stop.lineIds])] });
    aliases.set(keptId, [...(aliases.get(keptId) ?? []), stop.id]);
  }
  const links = new Map<string, GeoLink>();
  for (const link of network.links) {
    const fromId = keptIdOf.get(link.fromId) ?? link.fromId;
    const toId = keptIdOf.get(link.toId) ?? link.toId;
    if (fromId === toId) continue;
    const id = getGeoLinkId(fromId, toId);
    const known = links.get(id);
    links.set(id, {
      id,
      fromId: fromId < toId ? fromId : toId,
      toId: fromId < toId ? toId : fromId,
      lineIds: [...new Set([...(known?.lineIds ?? []), ...link.lineIds])],
    });
  }
  return { network: { stops: merged, links: [...links.values()] }, aliases };
}

/**
 * A stop is a junction where the lines on its links differ or it has other than two neighbours:
 * lines meet, part, start or end there.
 */
export function deriveRegionPlan(observed: GeoNetwork, homePlaceName: string): RegionPlanNodes {
  const { network, aliases } = mergeStations(observed);
  const neighbours = new Map<string, { id: string; lineIds: readonly string[] }[]>();
  for (const link of network.links) {
    for (const [from, to] of [
      [link.fromId, link.toId],
      [link.toId, link.fromId],
    ]) {
      neighbours.set(from, [...(neighbours.get(from) ?? []), { id: to, lineIds: link.lineIds }]);
    }
  }
  const isJunction = (stopId: string): boolean => {
    const around = neighbours.get(stopId) ?? [];
    return around.length !== 2 || !sameSet(around[0].lineIds, around[1].lineIds);
  };

  // Each run of the network between two junctions, walked once.
  const chains: { stopIds: string[]; lineIds: readonly string[] }[] = [];
  const walked = new Set<string>();
  for (const start of network.stops.keys()) {
    if (!isJunction(start)) continue;
    for (const first of neighbours.get(start) ?? []) {
      const stopIds = [start, first.id];
      while (!isJunction(stopIds[stopIds.length - 1])) {
        const [current, previous] = [stopIds[stopIds.length - 1], stopIds[stopIds.length - 2]];
        const next = neighbours.get(current)?.find(({ id }) => id !== previous);
        if (!next || stopIds.includes(next.id)) break;
        stopIds.push(next.id);
      }
      const key = [stopIds[0], stopIds[1], stopIds[stopIds.length - 1]].join(" ");
      const reverse = [stopIds[stopIds.length - 1], stopIds[stopIds.length - 2], stopIds[0]].join(
        " ",
      );
      if (walked.has(key) || walked.has(reverse)) continue;
      walked.add(key);
      chains.push({ stopIds, lineIds: first.lineIds });
    }
  }

  const stopOf = (stopId: string): GeoStop | undefined => network.stops.get(stopId);
  const placeOf = (stopId: string): string | undefined => stopOf(stopId)?.placeName;
  const nodes = new Map<string, { id: string; placeName?: string; stopIds: string[] }>();
  const addNode = (id: string, stopIds: readonly string[]) => {
    const node = nodes.get(id) ?? { id, placeName: placeOf(id), stopIds: [] };
    for (const stopId of stopIds.flatMap((id) => [id, ...(aliases.get(id) ?? [])])) {
      if (!node.stopIds.includes(stopId)) node.stopIds.push(stopId);
    }
    nodes.set(id, node);
  };
  const edges = new Map<string, RegionEdge>();
  const addEdge = (fromId: string, toId: string, lineIds: readonly string[]) => {
    if (fromId === toId) return;
    const [left, right] = fromId < toId ? [fromId, toId] : [toId, fromId];
    const known = edges.get(`${left} ${right}`)?.lineIds ?? [];
    edges.set(`${left} ${right}`, {
      fromId: left,
      toId: right,
      lineIds: [...new Set([...known, ...lineIds])],
    });
  };

  for (const { stopIds, lineIds } of chains) {
    const first = stopIds[0];
    const last = stopIds[stopIds.length - 1];
    addNode(first, [first]);
    addNode(last, [last]);
    const interior = stopIds.slice(1, -1);
    let previousNode = first;
    let index = 0;
    while (index < interior.length) {
      const place = placeOf(interior[index]);
      let end = index;
      while (end + 1 < interior.length && placeOf(interior[end + 1]) === place) end += 1;
      const run = interior.slice(index, end + 1);
      if (place && place !== homePlaceName) {
        if (place === placeOf(first) && (place !== placeOf(last) || index < interior.length / 2)) {
          addNode(first, run);
        } else if (place === placeOf(last)) {
          addNode(last, run);
        } else {
          const representative = run[Math.floor((run.length - 1) / 2)];
          addNode(representative, run);
          addEdge(previousNode, representative, lineIds);
          previousNode = representative;
        }
      }
      index = end + 1;
    }
    addEdge(previousNode, last, lineIds);
  }

  const nodeCountByPlace = new Map<string, number>();
  for (const { placeName } of nodes.values()) {
    if (placeName) nodeCountByPlace.set(placeName, (nodeCountByPlace.get(placeName) ?? 0) + 1);
  }
  const lineIdsByNode = new Map<string, Set<string>>();
  for (const edge of edges.values()) {
    for (const id of [edge.fromId, edge.toId]) {
      const lines = lineIdsByNode.get(id) ?? new Set<string>();
      for (const lineId of edge.lineIds) lines.add(lineId);
      lineIdsByNode.set(id, lines);
    }
  }
  const nameOf = ({ id, placeName }: { id: string; placeName?: string }, byStop: boolean) => {
    const isPlaceNode = placeName !== undefined && placeName !== homePlaceName;
    const isOnlyNode = nodeCountByPlace.get(placeName ?? "") === 1;
    // A run of a place is named by the place; a junction there only if it is the place's one node.
    const standsForPlace = isPlaceNode && !byStop && (isOnlyNode || !isJunction(id));
    const stopName = stopOf(id)?.name ?? id;
    if (standsForPlace) return placeName;
    return isPlaceNode && !stopName.includes(placeName) ? `${placeName} ${stopName}` : stopName;
  };
  const labelCount = new Map<string, number>();
  for (const node of nodes.values()) {
    const label = nameOf(node, false);
    labelCount.set(label, (labelCount.get(label) ?? 0) + 1);
  }
  return {
    nodes: [...nodes.values()].map((node) => {
      const { id, placeName, stopIds } = node;
      // Two branches through one place are told apart by their stops.
      const label = nameOf(node, (labelCount.get(nameOf(node, false)) ?? 0) > 1);
      return {
        id,
        label,
        ...(placeName ? { placeName } : {}),
        stopIds,
        lineIds: [...(lineIdsByNode.get(id) ?? [])],
      };
    }),
    edges: [...edges.values()],
  };
}
