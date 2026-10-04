import { type CSSProperties, memo, type RefObject, useMemo } from "react";
import type { DirectTravelTime } from "../../lib/direct-travel-times";
import {
  type GeoBox,
  type MapDrawing,
  type MapZones,
  toOctagon,
  toRoundedPath,
  toRoundedRing,
} from "../../lib/geo-map";
import {
  createExperimentMapLayout,
  EXPERIMENT_MAP_LANE_PITCH,
} from "../../lib/experiment-map-layout";
import type { ZentrumLineSignReader } from "../zentrum/line-sign";

/** Pixels a bend is rounded by. */
const BEND_RADIUS = 7;

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
  quietStopIds,
  zones,
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
  /** Stops drawn small and named only on hover, or once a ride reaches them. */
  quietStopIds?: ReadonlySet<string>;
  zones?: MapZones;
}) {
  const points = network.stops;
  const layout = useMemo(() => createExperimentMapLayout(network), [network]);
  const { linkById, runBearingByStopId } = layout;
  const { labels, placeLabels, litLineIdsByLinkId } = useMemo(
    () =>
      layout.readLabels({ bounds, scale, places, times, feedNow, selectedStopId, quietStopIds }),
    [layout, bounds, scale, places, times, feedNow, selectedStopId, quietStopIds],
  );
  const toPixels = (point: { x: number; y: number }) =>
    scale === undefined
      ? { x: 0, y: 0 }
      : { x: (point.x - bounds.x) * scale, y: (point.y - bounds.y) * scale };

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
      // A bent link shifts whole along its chord's normal, so its legs stay joined.
      const path = [from, ...(link?.bends ?? []), to];
      return lineIds.map((lineId, index) => {
        const offset =
          (index - (lineIds.length - 1) / 2) * EXPERIMENT_MAP_LANE_PITCH * unitsPerPixel;
        return (
          <path
            key={`${linkId}:${lineId}`}
            d={toRoundedPath(
              path.map(({ x, y }) => ({ x: x + normal.x * offset, y: y + normal.y * offset })),
              BEND_RADIUS * unitsPerPixel,
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
            {zones && (
              <g className="experiment-map-zones">
                {zones.radii.map((radius) => (
                  <path
                    key={radius}
                    d={toRoundedRing(toOctagon(zones.center, radius), radius * 0.08)}
                  />
                ))}
              </g>
            )}
            <g className="experiment-map-links">
              {network.links.map((link) => {
                const from = points.get(link.fromId);
                const to = points.get(link.toId);
                if (!from || !to) return null;
                return (
                  <path
                    key={link.id}
                    d={toRoundedPath(
                      [from, ...(link.bends ?? []), to],
                      BEND_RADIUS * unitsPerPixel,
                    )}
                    data-lit={litLineIdsByLinkId?.has(link.id) ?? false}
                    data-weight={Math.min(link.lineIds.length, 4)}
                  />
                );
              })}
            </g>
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
            const point = toPixels(stop);
            const label = labels.get(stop.id);
            const reachedLineId = reachedLineByStopId.get(stop.id);
            const isSelected = stop.id === selectedStopId;
            const isQuiet = quietStopIds?.has(stop.id) ?? false;
            const runBearing = isQuiet ? runBearingByStopId.get(stop.id) : undefined;
            const isLevel =
              runBearing !== undefined && Math.abs(Math.cos((runBearing * Math.PI) / 180)) > 0.7;
            return (
              <button
                key={stop.id}
                type="button"
                className="experiment-map-stop"
                data-selected={isSelected}
                data-reached={reachedLineId !== undefined}
                data-side={label?.side ?? (isQuiet ? (isLevel ? "above" : "right") : undefined)}
                data-at-rest={label?.isAtRest}
                data-quiet={isQuiet}
                data-tick={runBearing !== undefined}
                style={
                  {
                    left: point.x,
                    top: point.y,
                    "--experiment-line-color": reachedLineId
                      ? getSign(reachedLineId).color
                      : undefined,
                    "--experiment-label-gap": label ? `${label.gap}px` : undefined,
                    "--experiment-tick-angle":
                      runBearing === undefined ? undefined : `${runBearing}deg`,
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
                    {label.name}
                    {label.minutes !== undefined && <em>{label.minutes}′</em>}
                  </span>
                )}
                {!label && (
                  <span aria-hidden="true" data-hover="true">
                    {stop.name}
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
