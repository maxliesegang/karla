import { type CSSProperties, memo, type RefObject, useMemo } from "react";
import type { DirectTravelTime } from "../../lib/direct-travel-times";
import {
  type GeoBox,
  type GeoLabelCandidate,
  type GeoLabelSide,
  getGeoDestinationLabels,
  getGeoLabelRect,
  getGeoLinkId,
  type MapDrawing,
  placeGeoLabels,
} from "../../lib/geo-map";
import { compareLineIds } from "../../lib/line-families";
import { LineBadge } from "../LineBadge";
import type { ZentrumLineSignReader } from "../zentrum/line-sign";

/** Lit lanes on one link stand this many pixels apart. */
const LANE_PITCH = 3.5;
/** Rough glyph width at the label sizes, for collision only. */
const GLYPH_WIDTH = { stop: 6.4, place: 8.2 } as const;
/** An `xs` line badge and its gap. */
const BADGE_WIDTH = 30;

type StopLabel = {
  name: string;
  minutes?: number;
  endingLineIds: readonly string[];
  side: GeoLabelSide;
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

/** The lines each stop is the last of: a line ends where only one of its links touches the stop. */
const getEndingLineIdsByStopId = (
  links: MapDrawing["links"],
): ReadonlyMap<string, readonly string[]> => {
  const touches = new Map<string, number>();
  for (const { fromId, toId, lineIds } of links) {
    for (const stopId of [fromId, toId]) {
      for (const lineId of lineIds) {
        const key = `${stopId}\u0000${lineId}`;
        touches.set(key, (touches.get(key) ?? 0) + 1);
      }
    }
  }
  const byStop = new Map<string, string[]>();
  for (const [key, count] of touches) {
    if (count !== 1) continue;
    const [stopId, lineId] = key.split("\u0000");
    byStop.set(stopId, [...(byStop.get(stopId) ?? []), lineId]);
  }
  for (const lineIds of byStop.values()) lineIds.sort(compareLineIds);
  return byStop;
};

const toPolylinePoints = (points: readonly { x: number; y: number }[]): string =>
  points.map(({ x, y }) => `${x},${y}`).join(" ");

/**
 * An experiment map at one scale: links and stops in an SVG in map units, names and minutes as HTML
 * at pixel positions so they keep their size at every zoom.
 */
export const ExperimentMapCanvas = memo(function ExperimentMapCanvas({
  drawing: network,
  places,
  bounds,
  scale,
  times,
  feedNow,
  selectedStopId,
  getSign,
  onSelectStop,
  scrollRef,
  onScroll,
  linesAtRest = false,
}: {
  drawing: MapDrawing;
  /** Background names, at map positions. */
  places: readonly { name: string; x: number; y: number }[];
  bounds: GeoBox;
  /** Pixels per map unit; nothing is drawn before it is measured. */
  scale: number | undefined;
  /** The opened stop's direct rides. */
  times?: ReadonlyMap<string, DirectTravelTime>;
  feedNow: number;
  selectedStopId?: string;
  getSign: ZentrumLineSignReader;
  onSelectStop: (stopId: string | undefined) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  /** Every line drawn in its colour before a stop is opened, with badges where it ends. */
  linesAtRest?: boolean;
}) {
  const points = network.stops;
  const linkById = useMemo(() => new Map(network.links.map((link) => [link.id, link])), [network]);
  const litLineIdsByLinkId = useMemo(
    () => (times ? getLitLineIdsByLinkId(times) : undefined),
    [times],
  );
  const restingLineIdsByLinkId = useMemo(
    () =>
      linesAtRest
        ? new Map(network.links.map((link) => [link.id, [...link.lineIds].sort(compareLineIds)]))
        : undefined,
    [network, linesAtRest],
  );
  const endingLineIdsByStopId = useMemo(
    () => (linesAtRest ? getEndingLineIdsByStopId(network.links) : new Map<string, string[]>()),
    [network, linesAtRest],
  );
  const destinationLabels = useMemo(
    () => (times ? getGeoDestinationLabels(network, times, feedNow) : []),
    [network, times, feedNow],
  );

  const toPixels = (point: { x: number; y: number }) =>
    scale === undefined
      ? { x: 0, y: 0 }
      : { x: (point.x - bounds.x) * scale, y: (point.y - bounds.y) * scale };

  const placeLabels = useMemo(() => {
    if (scale === undefined) return [];
    const candidates = places.map((place) => {
      return {
        id: place.name,
        x: (place.x - bounds.x) * scale,
        y: (place.y - bounds.y) * scale,
        width: estimateWidth(place.name, GLYPH_WIDTH.place),
        height: 18,
      };
    });
    const placed = placeGeoLabels(candidates, ["center"]);
    return candidates.filter(({ id }) => placed.has(id));
  }, [scale, bounds, places]);

  const labels = useMemo(() => {
    const result = new Map<string, StopLabel>();
    if (scale === undefined) return result;
    const at = (stopId: string) => {
      const point = points.get(stopId);
      return point
        ? { x: (point.x - bounds.x) * scale, y: (point.y - bounds.y) * scale }
        : undefined;
    };
    const texts = new Map<string, Omit<StopLabel, "side">>();
    const candidates: GeoLabelCandidate[] = [];
    const add = (stopId: string, name: string, minutes?: number) => {
      const point = at(stopId);
      if (!point || texts.has(stopId)) return;
      const endingLineIds = minutes === undefined ? (endingLineIdsByStopId.get(stopId) ?? []) : [];
      texts.set(stopId, { name, minutes, endingLineIds });
      const text = minutes === undefined ? name : `${name} ${minutes}′`;
      candidates.push({
        id: stopId,
        ...point,
        width: estimateWidth(text, GLYPH_WIDTH.stop) + endingLineIds.length * BADGE_WIDTH,
        height: endingLineIds.length > 0 ? 20 : 16,
      });
    };
    const selected = selectedStopId ? network.stops.get(selectedStopId) : undefined;
    if (selected) {
      add(selected.id, selected.name);
      for (const label of destinationLabels) add(label.stopId, label.name, label.minutes);
    } else {
      // Ends first, so every line keeps its badge; then the busiest stops.
      const rank = (stop: { id: string; lineIds: readonly string[] }) =>
        (endingLineIdsByStopId.has(stop.id) ? 100 : 0) + stop.lineIds.length;
      const busiestFirst = [...network.stops.values()].sort(
        (left, right) => rank(right) - rank(left) || left.name.localeCompare(right.name),
      );
      for (const stop of busiestFirst) add(stop.id, stop.name);
    }
    const placeRects = placeLabels.map((place) => getGeoLabelRect(place, "center"));
    for (const [id, side] of placeGeoLabels(candidates, undefined, placeRects)) {
      const text = texts.get(id);
      if (text) result.set(id, { ...text, side });
    }
    return result;
  }, [
    scale,
    bounds,
    points,
    network,
    selectedStopId,
    destinationLabels,
    placeLabels,
    endingLineIdsByStopId,
  ]);

  const reachedLineByStopId = new Map(
    [...(times ?? [])].map(([stopId, { lineId }]) => [stopId, lineId]),
  );
  const width = scale === undefined ? undefined : Math.ceil(bounds.width * scale);
  const height = scale === undefined ? undefined : Math.ceil(bounds.height * scale);
  const unitsPerPixel = scale === undefined ? 0 : 1 / scale;

  /** Each link's lines as lanes side by side, in one order on every link. */
  const renderLanes = (lineIdsByLinkId: ReadonlyMap<string, readonly string[]>) =>
    [...lineIdsByLinkId].flatMap(([linkId, lineIds]) => {
      const link = linkById.get(linkId);
      const from = link && points.get(link.fromId);
      const to = link && points.get(link.toId);
      if (!from || !to) return [];
      const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
      // One normal for both directions, so a line keeps its side from link to link.
      let normal = { x: -(to.y - from.y) / length, y: (to.x - from.x) / length };
      if (normal.x < 0 || (normal.x === 0 && normal.y < 0)) {
        normal = { x: -normal.x, y: -normal.y };
      }
      // A bent link shifts whole along its chord's normal, so its two legs stay joined.
      const path = link?.via ? [from, link.via, to] : [from, to];
      return lineIds.map((lineId, index) => {
        const offset = (index - (lineIds.length - 1) / 2) * LANE_PITCH * unitsPerPixel;
        return (
          <polyline
            key={`${linkId}:${lineId}`}
            points={toPolylinePoints(
              path.map(({ x, y }) => ({ x: x + normal.x * offset, y: y + normal.y * offset })),
            )}
            stroke={getSign(lineId).color}
          />
        );
      });
    });

  return (
    <div
      className="zentrum-schematic-scroll experiment-map-scroll"
      ref={scrollRef}
      onScroll={onScroll}
    >
      {scale !== undefined && (
        <div
          className="experiment-map-canvas"
          data-has-selection={selectedStopId !== undefined}
          style={{ width, height }}
        >
          <svg
            viewBox={`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`}
            width={width}
            height={height}
            aria-hidden="true"
          >
            {!linesAtRest && (
              <g className="experiment-map-links">
                {network.links.map((link) => {
                  const from = points.get(link.fromId);
                  const to = points.get(link.toId);
                  if (!from || !to) return null;
                  return (
                    <polyline
                      key={link.id}
                      points={toPolylinePoints(link.via ? [from, link.via, to] : [from, to])}
                      data-lit={litLineIdsByLinkId?.has(link.id) ?? false}
                      data-weight={Math.min(link.lineIds.length, 4)}
                    />
                  );
                })}
              </g>
            )}
            {restingLineIdsByLinkId && (
              <g className="experiment-map-lines" data-dimmed={litLineIdsByLinkId !== undefined}>
                {renderLanes(restingLineIdsByLinkId)}
              </g>
            )}
            {litLineIdsByLinkId && (
              <g className="experiment-map-lit">{renderLanes(litLineIdsByLinkId)}</g>
            )}
          </svg>
          {placeLabels.map(({ id, x, y }) => (
            <span key={id} className="experiment-map-place" style={{ left: x, top: y }}>
              {id}
            </span>
          ))}
          {[...network.stops.values()].map((stop) => {
            const point = toPixels(points.get(stop.id) ?? { x: 0, y: 0 });
            const label = labels.get(stop.id);
            const reachedLineId = reachedLineByStopId.get(stop.id);
            const isSelected = stop.id === selectedStopId;
            return (
              <button
                key={stop.id}
                type="button"
                className="experiment-map-stop"
                data-selected={isSelected}
                data-reached={reachedLineId !== undefined}
                data-side={label?.side}
                style={
                  {
                    left: point.x,
                    top: point.y,
                    "--experiment-line-color": reachedLineId
                      ? getSign(reachedLineId).color
                      : undefined,
                  } as CSSProperties
                }
                aria-label={
                  label?.minutes === undefined
                    ? stop.name
                    : `${stop.name}, in ${label.minutes} Minuten`
                }
                aria-pressed={isSelected}
                onClick={() => onSelectStop(isSelected ? undefined : stop.id)}
              >
                {label && (
                  <span aria-hidden="true">
                    {label.endingLineIds.map((lineId) => (
                      <LineBadge key={lineId} line={getSign(lineId)} size="xs" />
                    ))}
                    {label.name}
                    {label.minutes !== undefined && <em>{label.minutes}′</em>}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
});
