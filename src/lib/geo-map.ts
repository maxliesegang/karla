/**
 * The experiment page's geographic map: stops where the feed locates them, linked in the order the
 * observed runs call them. Straight links between stops, not track.
 */
import type { Departure, TripCall } from "../data/transit-types";
import { type DirectTravelTime, getMinutesUntilArrival } from "./direct-travel-times";
import { toLocalMeters } from "./geo";
import { getBaseName } from "./stop-naming";
import { collapseTurnaroundCalls, getCallKey } from "./trip-calls";

export type GeoPosition = { latitude: number; longitude: number };

export type GeoStop = GeoPosition & {
  id: string;
  name: string;
  placeName?: string;
  /** Lines seen calling, in order of first sighting. */
  lineIds: readonly string[];
};

/** Two stops some run calls one after the other; `fromId` sorts first. */
export type GeoLink = { id: string; fromId: string; toId: string; lineIds: readonly string[] };

export type GeoNetwork = { stops: ReadonlyMap<string, GeoStop>; links: readonly GeoLink[] };

/** What an experiment map draws: stops at map positions, links that may bend once. */
export type MapDrawing = {
  stops: ReadonlyMap<
    string,
    {
      id: string;
      name: string;
      placeName?: string;
      lineIds: readonly string[];
      x: number;
      y: number;
    }
  >;
  links: readonly (GeoLink & { via?: { x: number; y: number } })[];
};

/** The geographic network drawn in kilometres from Marktplatz. */
export const toGeoDrawing = (network: GeoNetwork): MapDrawing => ({
  stops: new Map(
    [...network.stops].map(([id, stop]) => [id, { ...stop, ...projectGeoPosition(stop) }]),
  ),
  links: network.links,
});

/** A stop's id on the map: the local stop, else the operator's stop. */
export const getGeoStopId = (call: TripCall): string =>
  call.localStopId ?? call.providerStopPointId ?? getCallKey(call);

export const getGeoLinkId = (left: string, right: string): string =>
  left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`;

const callPosition = ({ latitude, longitude }: TripCall): GeoPosition | undefined =>
  latitude === undefined || longitude === undefined ? undefined : { latitude, longitude };

type StopRecord = {
  id: string;
  name: string;
  placeName?: string;
  /** Each stop point's position once, so a busy platform does not pull the average. */
  positions: Map<string, GeoPosition>;
  lineIds: string[];
};

const addOnce = (list: string[], value: string) => {
  if (!list.includes(value)) list.push(value);
};

/**
 * Reads runs into the map, keeping what earlier runs showed for the session, so the map does not
 * shrink as runs end. A call the feed leaves unlocated (a board's own call) is placed by `locate`,
 * or linked across.
 */
export function createGeoNetworkReader(
  locate: (call: TripCall) => GeoPosition | undefined = () => undefined,
): (departures: readonly Departure[]) => GeoNetwork {
  const stops = new Map<string, StopRecord>();
  const links = new Map<string, { id: string; fromId: string; toId: string; lineIds: string[] }>();

  const recordStop = (call: TripCall, lineId: string): string | undefined => {
    const id = getGeoStopId(call);
    const position = callPosition(call) ?? locate(call);
    let stop = stops.get(id);
    if (!stop) {
      if (!position) return undefined;
      stop = { id, name: getBaseName(call.stopName), positions: new Map(), lineIds: [] };
      stops.set(id, stop);
    }
    if (position) stop.positions.set(`${position.latitude},${position.longitude}`, position);
    if (!stop.placeName && call.placeName) stop.placeName = getBaseName(call.placeName);
    addOnce(stop.lineIds, lineId);
    return id;
  };

  return (departures) => {
    for (const departure of departures) {
      let previous: string | undefined;
      for (const call of collapseTurnaroundCalls(departure.tripCalls ?? [])) {
        const id = recordStop(call, departure.lineId);
        if (!id || id === previous) continue;
        if (previous) {
          const linkId = getGeoLinkId(previous, id);
          const [fromId, toId] = previous < id ? [previous, id] : [id, previous];
          const link = links.get(linkId) ?? { id: linkId, fromId, toId, lineIds: [] };
          links.set(linkId, link);
          addOnce(link.lineIds, departure.lineId);
        }
        previous = id;
      }
    }
    return {
      stops: new Map(
        [...stops].map(([id, { positions, lineIds, ...stop }]) => {
          const points = [...positions.values()];
          const average = (read: (point: GeoPosition) => number) =>
            points.reduce((sum, point) => sum + read(point), 0) / points.length;
          return [
            id,
            {
              ...stop,
              latitude: average(({ latitude }) => latitude),
              longitude: average(({ longitude }) => longitude),
              lineIds: [...lineIds],
            },
          ];
        }),
      ),
      links: [...links.values()].map((link) => ({ ...link, lineIds: [...link.lineIds] })),
    };
  };
}

/** Where the map's kilometres are counted from: Marktplatz. */
const GEO_ORIGIN: GeoPosition = { latitude: 49.0093, longitude: 8.4037 };

/** Kilometres east and south of the origin, so the map reads like a page. */
export function projectGeoPosition({ latitude, longitude }: GeoPosition): { x: number; y: number } {
  const { x, y } = toLocalMeters(latitude, longitude, GEO_ORIGIN);
  return { x: x / 1_000, y: -y / 1_000 };
}

export type GeoBox = { x: number; y: number; width: number; height: number };

/** The kilometres the drawn stops span, with a margin; the city centre when nothing is drawn. */
export function getGeoBounds(network: GeoNetwork, margin = 1.5): GeoBox {
  const points = [...network.stops.values()].map(projectGeoPosition);
  if (points.length === 0) return { x: -5, y: -5, width: 10, height: 10 };
  const xs = points.map(({ x }) => x);
  const ys = points.map(({ y }) => y);
  const x = Math.min(...xs) - margin;
  const y = Math.min(...ys) - margin;
  return {
    x,
    y,
    width: Math.max(...xs) + margin - x,
    height: Math.max(...ys) + margin - y,
  };
}

/** A town or district, named as the feed names the place of its stops. */
export type GeoPlace = GeoPosition & { name: string; stopCount: number };

/** Each place at the middle of its stops, the largest first. */
export function getGeoPlaces(network: GeoNetwork): readonly GeoPlace[] {
  const byName = new Map<string, GeoStop[]>();
  for (const stop of network.stops.values()) {
    if (!stop.placeName) continue;
    byName.set(stop.placeName, [...(byName.get(stop.placeName) ?? []), stop]);
  }
  return [...byName]
    .map(([name, stops]) => ({
      name,
      stopCount: stops.length,
      latitude: stops.reduce((sum, stop) => sum + stop.latitude, 0) / stops.length,
      longitude: stops.reduce((sum, stop) => sum + stop.longitude, 0) / stops.length,
    }))
    .sort((left, right) => right.stopCount - left.stopCount || left.name.localeCompare(right.name));
}

/** A reached stop's name and minutes, as the map prints them. */
export type GeoDestinationLabel = { stopId: string; name: string; minutes: number; lineId: string };

/**
 * Reached stops in the order their labels claim room: where each way ends, then the first stop in
 * each other place, then the rest; sooner first within each.
 */
export function getGeoDestinationLabels(
  network: { stops: ReadonlyMap<string, { name: string; placeName?: string }> },
  times: ReadonlyMap<string, DirectTravelTime>,
  feedNow: number,
): readonly GeoDestinationLabel[] {
  const passed = new Set<string>();
  let originId: string | undefined;
  for (const { stopIds } of times.values()) {
    originId = stopIds[0];
    for (const stopId of stopIds.slice(0, -1)) passed.add(stopId);
  }
  const originPlace = originId === undefined ? undefined : network.stops.get(originId)?.placeName;

  const labels = [...times].flatMap(([stopId, time]) => {
    const stop = network.stops.get(stopId);
    if (!stop) return [];
    const minutes = getMinutesUntilArrival(time.arrivesAt, feedNow);
    return [{ stopId, name: stop.name, minutes, lineId: time.lineId, placeName: stop.placeName }];
  });
  const firstInPlace = new Map<string, (typeof labels)[number]>();
  for (const label of labels) {
    if (!label.placeName || label.placeName === originPlace) continue;
    const known = firstInPlace.get(label.placeName);
    if (!known || label.minutes < known.minutes) firstInPlace.set(label.placeName, label);
  }
  const getTier = (label: (typeof labels)[number]): number =>
    !passed.has(label.stopId) ? 0 : firstInPlace.get(label.placeName ?? "") === label ? 1 : 2;
  return labels
    .sort(
      (left, right) =>
        getTier(left) - getTier(right) ||
        left.minutes - right.minutes ||
        left.name.localeCompare(right.name),
    )
    .map(({ stopId, name, minutes, lineId }) => ({ stopId, name, minutes, lineId }));
}

/** Where a label stands from its point; `center` is over it. */
export type GeoLabelSide = "right" | "left" | "above" | "below" | "center";

/** A label to set beside its point, in screen pixels. */
export type GeoLabelCandidate = { id: string; x: number; y: number; width: number; height: number };

/** Room between a point and its label, and around a labelled point. */
const GEO_LABEL_GAP = 6;
/** Closer than this to a labelled point, a second name would read as the same spot. */
const GEO_LABEL_POINT_CLEARANCE = 8;

/** A box on screen, in pixels. */
export type GeoRect = { left: number; top: number; right: number; bottom: number };

const overlaps = (a: GeoRect, b: GeoRect): boolean =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

export const getGeoLabelRect = (
  { x, y, width, height }: GeoLabelCandidate,
  side: GeoLabelSide,
): GeoRect => {
  const left =
    side === "right"
      ? x + GEO_LABEL_GAP
      : side === "left"
        ? x - GEO_LABEL_GAP - width
        : x - width / 2;
  const top =
    side === "above"
      ? y - GEO_LABEL_GAP - height
      : side === "below"
        ? y + GEO_LABEL_GAP
        : y - height / 2;
  return { left, top, right: left + width, bottom: top + height };
};

const GEO_LABEL_SIDES: readonly GeoLabelSide[] = ["right", "left", "above", "below"];

/**
 * Labels in the order given, each on the first free side of its point and clear of `obstacles`;
 * the rest stay unset.
 */
export function placeGeoLabels(
  candidates: readonly GeoLabelCandidate[],
  sides: readonly GeoLabelSide[] = GEO_LABEL_SIDES,
  obstacles: readonly GeoRect[] = [],
): ReadonlyMap<string, GeoLabelSide> {
  const placed = new Map<string, GeoLabelSide>();
  const taken: GeoRect[] = [...obstacles];
  const labelledPoints: { x: number; y: number }[] = [];
  for (const candidate of candidates) {
    const { x, y } = candidate;
    if (
      labelledPoints.some(
        (point) => Math.hypot(point.x - x, point.y - y) < GEO_LABEL_POINT_CLEARANCE,
      )
    ) {
      continue;
    }
    const side = sides.find((option) => {
      const rect = getGeoLabelRect(candidate, option);
      return !taken.some((other) => overlaps(rect, other));
    });
    if (!side) continue;
    placed.set(candidate.id, side);
    taken.push(getGeoLabelRect(candidate, side), {
      left: x - GEO_LABEL_GAP,
      top: y - GEO_LABEL_GAP,
      right: x + GEO_LABEL_GAP,
      bottom: y + GEO_LABEL_GAP,
    });
    labelledPoints.push({ x, y });
  }
  return placed;
}
