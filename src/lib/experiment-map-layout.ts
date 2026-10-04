/** Screen-space labels and topology for an experiment map. */
import type { DirectTravelTime } from "./direct-travel-times";
import {
  type GeoBox,
  type GeoLabelCandidate,
  type GeoLabelSide,
  type GeoSegment,
  getGeoDestinationLabels,
  getGeoLabelRect,
  getGeoLinkId,
  type MapDrawing,
  placeGeoLabels,
} from "./geo-map";
import { compareLineIds } from "./line-families";

/** Lit lanes on one link stand this many pixels apart. */
export const EXPERIMENT_MAP_LANE_PITCH = 3.5;
/** Rough glyph width at the label sizes, for collision only. */
const GLYPH_WIDTH = { stop: 6.4, place: 8.2 } as const;
/** Pixels between a point and its name, past what is drawn there. */
const LABEL_GAP = 6;
/** Pixels a through stop needs to its nearest neighbour before it is named at rest. */
const THROUGH_STOP_SPACING = 48;

type StopLabel = {
  name: string;
  minutes?: number;
  side: GeoLabelSide;
  /** Pixels between the point and its name. */
  gap: number;
  /** A name the map shows unasked, quieter than an opened stop's answers. */
  isAtRest: boolean;
};

const estimateWidth = (text: string, glyph: number) => text.length * glyph + 6;

/** Each lit link's lines, from the ways the opened stop's direct rides take. */
const getLitLineIdsByLinkId = (
  times: ReadonlyMap<string, DirectTravelTime>,
): ReadonlyMap<string, readonly string[]> => {
  const byLink = new Map<string, Set<string>>();
  for (const { lineId, stopIds } of times.values()) {
    for (let index = 1; index < stopIds.length; index += 1) {
      const id = getGeoLinkId(stopIds[index - 1], stopIds[index]);
      byLink.set(id, (byLink.get(id) ?? new Set()).add(lineId));
    }
  }
  return new Map([...byLink].map(([id, lineIds]) => [id, [...lineIds].sort(compareLineIds)]));
};

/** Each stop's two neighbours' bearing, in degrees, where it has exactly two. */
const getRunBearingByStopId = (network: MapDrawing): ReadonlyMap<string, number> => {
  const neighbours = new Map<string, { x: number; y: number }[]>();
  for (const { fromId, toId, bends = [] } of network.links) {
    for (const [id, otherId, corner] of [
      [fromId, toId, bends[0]],
      [toId, fromId, bends[bends.length - 1]],
    ] as const) {
      const toward = corner ?? network.stops.get(otherId);
      if (toward) neighbours.set(id, [...(neighbours.get(id) ?? []), toward]);
    }
  }
  const bearings = new Map<string, number>();
  for (const [id, around] of neighbours) {
    if (around.length !== 2) continue;
    const point = network.stops.get(id);
    if (!point) continue;
    const [left, right] = around;
    bearings.set(id, (Math.atan2(right.y - left.y, right.x - left.x) * 180) / Math.PI);
  }
  return bearings;
};

/** Caches topology once per drawing; labels are placed at the requested scale. */
export function createExperimentMapLayout(network: MapDrawing) {
  const points = network.stops;
  const linkCountAt = new Map<string, number>();
  /** Map units to the nearest stop a link reaches. */
  const nearestAt = new Map<string, number>();
  for (const link of network.links) {
    const from = points.get(link.fromId);
    const to = points.get(link.toId);
    const length = from && to ? Math.hypot(to.x - from.x, to.y - from.y) : Infinity;
    for (const stopId of [link.fromId, link.toId]) {
      linkCountAt.set(stopId, (linkCountAt.get(stopId) ?? 0) + 1);
      nearestAt.set(stopId, Math.min(nearestAt.get(stopId) ?? Infinity, length));
    }
  }
  const isLandmark = (stopId: string) => linkCountAt.get(stopId) !== 2;
  const ranked = [...network.stops.values()].sort(
    (left, right) =>
      Number(isLandmark(right.id)) - Number(isLandmark(left.id)) ||
      right.lineIds.length - left.lineIds.length ||
      left.name.localeCompare(right.name),
  );
  const linkById = new Map(network.links.map((link) => [link.id, link]));
  const runBearingByStopId = getRunBearingByStopId(network);

  function readLabels({
    bounds,
    scale,
    places,
    times,
    feedNow,
    selectedStopId,
    quietStopIds,
  }: {
    bounds: GeoBox;
    scale: number | undefined;
    places: readonly { name: string; x: number; y: number }[];
    times?: ReadonlyMap<string, DirectTravelTime>;
    feedNow: number;
    selectedStopId?: string;
    quietStopIds?: ReadonlySet<string>;
  }) {
    const litLineIdsByLinkId = times ? getLitLineIdsByLinkId(times) : undefined;
    const destinationLabels = times ? getGeoDestinationLabels(network, times, feedNow) : [];
    const labels = new Map<string, StopLabel>();
    if (scale === undefined) return { labels, placeLabels: [], litLineIdsByLinkId };
    const placeCandidates = places.map((place) => ({
      id: place.name,
      x: (place.x - bounds.x) * scale,
      y: (place.y - bounds.y) * scale,
      width: estimateWidth(place.name, GLYPH_WIDTH.place),
      height: 18,
    }));
    const placed = placeGeoLabels(placeCandidates, { sides: ["center"] });
    const placeLabels = placeCandidates.filter(({ id }) => placed.has(id));
    const pixelsOf = (point: { x: number; y: number }) => ({
      x: (point.x - bounds.x) * scale,
      y: (point.y - bounds.y) * scale,
    });
    const at = (stopId: string) => {
      const point = points.get(stopId);
      return point ? pixelsOf(point) : undefined;
    };
    // Names keep off what a reader follows: every corridor at rest, the lit lines once a stop is open.
    const lanesOf = (linkId: string) =>
      litLineIdsByLinkId ? (litLineIdsByLinkId.get(linkId)?.length ?? 0) : 1;
    const halfWidthOf = (lanes: number) => (lanes * EXPERIMENT_MAP_LANE_PITCH) / 2 + 1;
    const widestAt = new Map<string, number>();
    for (const link of network.links) {
      for (const stopId of [link.fromId, link.toId]) {
        widestAt.set(stopId, Math.max(widestAt.get(stopId) ?? 0, lanesOf(link.id)));
      }
    }
    const texts = new Map<string, Omit<StopLabel, "side">>();
    const candidates: GeoLabelCandidate[] = [];
    const add = (stopId: string, name: string, minutes?: number, isAtRest = false) => {
      const point = at(stopId);
      if (!point || texts.has(stopId)) return;
      const gap = Math.max(LABEL_GAP, halfWidthOf(widestAt.get(stopId) ?? 0) + 2);
      texts.set(stopId, { name, minutes, gap, isAtRest });
      const text = minutes === undefined ? name : `${name} ${minutes}′`;
      candidates.push({
        id: stopId,
        ...point,
        width: estimateWidth(text, GLYPH_WIDTH.stop),
        height: 16,
        gap,
      });
    };
    const selected = selectedStopId ? network.stops.get(selectedStopId) : undefined;
    if (selected) {
      add(selected.id, selected.name);
      for (const label of destinationLabels) add(label.stopId, label.name, label.minutes);
    } else {
      for (const stop of ranked) {
        if (quietStopIds?.has(stop.id)) continue;
        const spacing = (nearestAt.get(stop.id) ?? Infinity) * scale;
        if (isLandmark(stop.id) || spacing >= THROUGH_STOP_SPACING) {
          add(stop.id, stop.name, undefined, true);
        }
      }
    }
    const lines: GeoSegment[] = network.links.flatMap((link) => {
      const from = at(link.fromId);
      const to = at(link.toId);
      const lanes = lanesOf(link.id);
      if (!from || !to || lanes === 0) return [];
      const path = [from, ...(link.bends ?? []).map(pixelsOf), to];
      return path
        .slice(1)
        .map((point, index) => ({ from: path[index], to: point, halfWidth: halfWidthOf(lanes) }));
    });
    const dots = [...points.values()].map(pixelsOf);
    const frame = { left: 0, top: 0, right: bounds.width * scale, bottom: bounds.height * scale };
    const placeRects = placeLabels.map((place) => getGeoLabelRect(place, "center"));
    for (const [id, side] of placeGeoLabels(candidates, {
      obstacles: placeRects,
      dots,
      lines,
      frame,
    })) {
      const text = texts.get(id);
      if (text) labels.set(id, { ...text, side });
    }
    return { labels, placeLabels, litLineIdsByLinkId };
  }

  return { linkById, runBearingByStopId, readLabels };
}
