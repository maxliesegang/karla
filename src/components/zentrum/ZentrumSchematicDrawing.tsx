import { type CSSProperties, memo } from "react";
import type { TransitLine } from "../../data/transit-types";
import { ZENTRUM_SCHEMATIC_VIEWBOX } from "../../lib/zentrum-schematic-plan";
import {
  type ZentrumSchematicDrawnPath,
  type ZentrumSchematicLinePathSegment,
  getZentrumSchematicVehiclePathData,
} from "../../lib/zentrum-schematic-paths";
import type { ZentrumSchematicOverlay } from "../../lib/zentrum-schematic-overlays";
import {
  ZENTRUM_SCHEMATIC_STOP_CAPSULE_FILL,
  ZENTRUM_SCHEMATIC_STOP_CAPSULE_WIDTH,
  type ZentrumSchematicStopMark,
} from "../../lib/zentrum-schematic-stops";

/** One line pattern the drawing paints, with the sign it is painted in. */
export type ZentrumSchematicDrawnLinePath = ZentrumSchematicDrawnPath & {
  /** The sign the pattern is painted in, as the live network states the line. */
  sign: TransitLine;
  /** The pattern split at the stops, one stretch per corridor, which an overlay lights by. */
  segments: readonly ZentrumSchematicLinePathSegment[];
};

/** The key a lit stretch is found by, so its dash can follow its mark's own animation. */
export const getZentrumLitStretchKey = (markerKey: string): string => `stretch:${markerKey}`;

/**
 * The dash offset that lights a stretch of `pathLength="1"` from a mark at `progress` to `end`.
 *
 * The stretch is drawn as the mark's path up to `end`, so the mark's progress is read as a share
 * of that; the dash is one path long, and the gap after it longer than the path, so nothing but
 * the part ahead of the mark is ever painted.
 */
export const getZentrumLitStretchOffset = (progress: number, end: number): string =>
  `${-Math.min(1, Math.max(0, progress / end))}px`;

/**
 * The corridors a line is lit along that its own drawn pattern does not run.
 *
 * A line is drawn by its most common pattern, and a trip can take another way: the S8 that runs by
 * the Hauptbahnhof rather than straight to the Albtalbahnhof reaches the Hauptbahnhof first, and its
 * way there runs where no S8 lane is drawn. It is lit in the lane of a line the plan does draw
 * there, in the colour of the line that runs it -- while a reading is lit every lane is a quiet
 * trace, so the colour says only which line, which is what it is asked to say.
 */
const getStrayLitSegments = (
  drawnLinePaths: readonly ZentrumSchematicDrawnLinePath[],
  overlay: ZentrumSchematicOverlay,
): {
  lineId: string;
  linePath: ZentrumSchematicDrawnLinePath;
  segment: ZentrumSchematicLinePathSegment;
}[] =>
  [...overlay.edgeIdsByLineId].flatMap(([lineId, edgeIds]) => {
    const own = drawnLinePaths.find((linePath) => linePath.lineIds.includes(lineId));
    if (!own) return [];
    const ownEdgeIds = new Set(own.segments.map(({ edgeId }) => edgeId));
    return [...edgeIds].flatMap((edgeId) => {
      if (ownEdgeIds.has(edgeId)) return [];
      const segment = drawnLinePaths
        .flatMap(({ segments }) => segments)
        .find((candidate) => candidate.edgeId === edgeId);
      return segment ? [{ lineId, linePath: own, segment }] : [];
    });
  });

/**
 * The painted drawing: the corridors, the lanes on them, and the rules the stops are marked with.
 *
 * Without an overlay every line is drawn whole in its sign colour. With one, every line is a quiet
 * route trace, and the overlay's corridors and stretches are lit over it -- all the traces first,
 * so no line's trace is ever laid over another line's colour on a lane they share. The marks that
 * move ride the canvas above; the stretches that follow them are kept here, and moved by the
 * marks' own animations.
 */
export const ZentrumSchematicDrawing = memo(function ZentrumSchematicDrawing({
  drawnLinePaths,
  stopMarks,
  highlightedLineIds,
  selectedStopId,
  overlay,
  trackWidth,
}: {
  drawnLinePaths: readonly ZentrumSchematicDrawnLinePath[];
  stopMarks: readonly ZentrumSchematicStopMark[];
  /** The lines kept at full strength while one is followed. */
  highlightedLineIds?: ReadonlySet<string>;
  /** The stop the plan is read from, whose capsules are filled: the plan's "you are here". */
  selectedStopId?: string;
  /** What is lit over the route traces, or nothing to draw every line whole. */
  overlay?: ZentrumSchematicOverlay;
  /** The one width the lanes are laid out on, which is also the width they are painted at. */
  trackWidth: number;
}) {
  // The lanes are laid exactly one lane's width apart, so the stroke that paints them has to be
  // that same width for the colours to meet. The layout is where that width is decided; the
  // stylesheet is told it here rather than keeping a second copy of it that could drift.
  // The capsule is measured in lanes by the layout that spaces names off it, and told here likewise.
  const trackStyle = {
    "--zentrum-schematic-track-width": trackWidth,
    "--zentrum-stop-capsule-width": trackWidth * ZENTRUM_SCHEMATIC_STOP_CAPSULE_WIDTH,
    "--zentrum-stop-capsule-fill":
      trackWidth * ZENTRUM_SCHEMATIC_STOP_CAPSULE_WIDTH * ZENTRUM_SCHEMATIC_STOP_CAPSULE_FILL,
  } as CSSProperties;
  const isDimmed = (lineIds: readonly string[]) =>
    highlightedLineIds !== undefined && !lineIds.some((lineId) => highlightedLineIds.has(lineId))
      ? "true"
      : undefined;
  const lineColor = (linePath: ZentrumSchematicDrawnLinePath) =>
    ({ "--zentrum-line-color": linePath.sign.color }) as CSSProperties;
  return (
    <svg
      viewBox={`${ZENTRUM_SCHEMATIC_VIEWBOX.x} ${ZENTRUM_SCHEMATIC_VIEWBOX.y} ${ZENTRUM_SCHEMATIC_VIEWBOX.width} ${ZENTRUM_SCHEMATIC_VIEWBOX.height}`}
      style={trackStyle}
      aria-hidden="true"
      focusable="false"
    >
      {drawnLinePaths.map((linePath) => (
        <path
          key={`casing:${linePath.id}`}
          className="zentrum-schematic-network-track-casing"
          d={linePath.data}
        />
      ))}
      {/* The rule between the lanes: the same paths one pass over the casing and under every
          colour, laid at the lane width the colours are painted short of, so it surfaces as a fine
          seam between touching lanes -- and as a rim around the band's outside. */}
      {drawnLinePaths.map((linePath) => (
        <path
          key={`seam:${linePath.id}`}
          className="zentrum-schematic-network-track-seam"
          d={linePath.data}
        />
      ))}
      {drawnLinePaths.map((linePath) => (
        <path
          key={`base:${linePath.id}`}
          className="zentrum-schematic-network-track-color"
          d={linePath.data}
          stroke={overlay ? undefined : linePath.sign.color}
          style={lineColor(linePath)}
          data-trace={overlay ? "true" : undefined}
          data-dimmed={isDimmed(linePath.lineIds)}
        />
      ))}
      {overlay &&
        drawnLinePaths.flatMap((linePath) => {
          // A trunk and its branches are one drawn path, so the path is lit wherever any of its
          // lines is.
          const litEdgeIds = new Set(
            linePath.lineIds.flatMap((lineId) => [...(overlay.edgeIdsByLineId.get(lineId) ?? [])]),
          );
          const segmentEdgeIds = new Set(linePath.segments.map(({ edgeId }) => edgeId));
          return [
            ...linePath.segments
              .filter((segment) => litEdgeIds.has(segment.edgeId))
              .map((segment) => (
                <path
                  key={`lit:${linePath.id}:${segment.edgeId}`}
                  className="zentrum-schematic-network-track-color"
                  d={segment.data}
                  stroke={linePath.sign.color}
                  style={lineColor(linePath)}
                  data-dimmed={isDimmed(linePath.lineIds)}
                />
              )),
            ...overlay.stretches.flatMap(({ vehicle, end }) => {
              // A mark off its line's drawn pattern follows a lane the drawing does not paint.
              if (
                !linePath.lineIds.includes(vehicle.lineId) ||
                !vehicle.path.edgeRanges.some(({ edgeId }) => segmentEdgeIds.has(edgeId))
              ) {
                return [];
              }
              const data = getZentrumSchematicVehiclePathData(vehicle.path, 0, end);
              if (!data) return [];
              const key = getZentrumLitStretchKey(vehicle.markerKey ?? vehicle.id);
              return [
                <path
                  key={key}
                  data-marker-key={key}
                  className="zentrum-schematic-network-track-color"
                  d={data}
                  pathLength={1}
                  strokeDasharray="1 2"
                  stroke={linePath.sign.color}
                  style={{
                    ...lineColor(linePath),
                    strokeDashoffset: getZentrumLitStretchOffset(vehicle.progress, end),
                  }}
                  data-stretch="true"
                  data-dimmed={isDimmed([vehicle.lineId])}
                />,
              ];
            }),
          ];
        })}
      {overlay &&
        getStrayLitSegments(drawnLinePaths, overlay).map(({ lineId, linePath, segment }) => (
          <path
            key={`stray:${lineId}:${segment.edgeId}`}
            className="zentrum-schematic-network-track-color"
            d={segment.data}
            stroke={linePath.sign.color}
            style={lineColor(linePath)}
            data-dimmed={isDimmed([lineId])}
          />
        ))}
      {/* The stops, last and over everything: a capsule laid across the lines calling there.
          Twice -- every outline first, then every body -- so rules that cross at a stop merge into
          one shape instead of each outline cutting through the other's body. */}
      {stopMarks.map((mark) => (
        <path
          key={`casing:${mark.nodeId}`}
          className="zentrum-schematic-stop-mark-casing"
          d={mark.data}
        />
      ))}
      {stopMarks.map((mark) => (
        <path
          key={mark.nodeId}
          className="zentrum-schematic-stop-mark"
          d={mark.data}
          data-selected={mark.nodeId === selectedStopId ? "true" : undefined}
        />
      ))}
    </svg>
  );
});
