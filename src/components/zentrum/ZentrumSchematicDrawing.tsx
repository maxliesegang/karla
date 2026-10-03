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

/** One line pattern the drawing paints, with the sign the live network states for it. */
export type ZentrumSchematicDrawnLinePath = ZentrumSchematicDrawnPath & { sign: TransitLine };

/** The key a lit stretch is found by, so its dash can follow its mark's own animation. */
export const getZentrumLitStretchKey = (markerKey: string): string => `stretch:${markerKey}`;

/**
 * The dash offset lighting a `pathLength="1"` stretch from a mark at `progress` to `end`. The dash
 * is one path long with a longer gap, so only the part ahead of the mark is painted.
 */
export const getZentrumLitStretchOffset = (progress: number, end: number): string =>
  `${-Math.min(1, Math.max(0, progress / end))}px`;

/** Whether a stroke recedes: it answers for none of the lines kept at full strength. */
const isDimmed = (
  highlightedLineIds: ReadonlySet<string> | undefined,
  lineIds: readonly string[],
): "true" | undefined =>
  highlightedLineIds !== undefined && !lineIds.some((lineId) => highlightedLineIds.has(lineId))
    ? "true"
    : undefined;

const lineColor = (linePath: ZentrumSchematicDrawnLinePath) =>
  ({ "--zentrum-line-color": linePath.sign.color }) as CSSProperties;

/**
 * Corridors a line is lit along that its own drawn pattern does not run (an S8 routed via the
 * Hauptbahnhof). They are lit in another line's lane, in this line's colour.
 */
const getStrayLitSegments = (
  drawnLinePaths: readonly ZentrumSchematicDrawnLinePath[],
  overlay: ZentrumSchematicOverlay,
): {
  lineId: string;
  linePath: ZentrumSchematicDrawnLinePath;
  segment: ZentrumSchematicLinePathSegment;
}[] => {
  const segmentByEdgeId = new Map<string, ZentrumSchematicLinePathSegment>();
  for (const { segments } of drawnLinePaths) {
    for (const segment of segments) {
      if (!segmentByEdgeId.has(segment.edgeId)) segmentByEdgeId.set(segment.edgeId, segment);
    }
  }
  return [...overlay.edgeIdsByLineId].flatMap(([lineId, edgeIds]) => {
    const own = drawnLinePaths.find((linePath) => linePath.lineIds.includes(lineId));
    if (!own) return [];
    const ownEdgeIds = new Set(own.segments.map(({ edgeId }) => edgeId));
    return [...edgeIds].flatMap((edgeId) => {
      const segment = ownEdgeIds.has(edgeId) ? undefined : segmentByEdgeId.get(edgeId);
      return segment ? [{ lineId, linePath: own, segment }] : [];
    });
  });
};

/**
 * The painted drawing. Without an overlay every line is drawn in its colour; with one, every line
 * is a quiet trace and the overlay is lit over all of them.
 *
 * Three layers changing at three rates: the lanes with the plan, the stop marks with the opened
 * stop, the lit overlay every second. Only the last re-renders each tick.
 */
export function ZentrumSchematicDrawing({
  drawnLinePaths,
  stopMarks,
  highlightedLineIds,
  selectedStopId,
  overlay,
  trackWidth,
}: {
  drawnLinePaths: readonly ZentrumSchematicDrawnLinePath[];
  stopMarks: readonly ZentrumSchematicStopMark[];
  /** The lines kept at full strength: the one followed, or those calling at the opened stop. */
  highlightedLineIds?: ReadonlySet<string>;
  /** The opened stop, whose capsules are filled. */
  selectedStopId?: string;
  /** What is lit over the route traces, or nothing to draw every line whole. */
  overlay?: ZentrumSchematicOverlay;
  /** The lane width, which is also the lane pitch. */
  trackWidth: number;
}) {
  // The stroke width must equal the lane pitch for colours to meet; the drawer decides it and
  // tells the stylesheet, as it does the capsule's.
  const trackStyle = {
    "--zentrum-schematic-track-width": trackWidth,
    "--zentrum-stop-capsule-width": trackWidth * ZENTRUM_SCHEMATIC_STOP_CAPSULE_WIDTH,
    "--zentrum-stop-capsule-fill":
      trackWidth * ZENTRUM_SCHEMATIC_STOP_CAPSULE_WIDTH * ZENTRUM_SCHEMATIC_STOP_CAPSULE_FILL,
  } as CSSProperties;
  return (
    <svg
      viewBox={`${ZENTRUM_SCHEMATIC_VIEWBOX.x} ${ZENTRUM_SCHEMATIC_VIEWBOX.y} ${ZENTRUM_SCHEMATIC_VIEWBOX.width} ${ZENTRUM_SCHEMATIC_VIEWBOX.height}`}
      style={trackStyle}
      aria-hidden="true"
      focusable="false"
    >
      <ZentrumSchematicTracks
        drawnLinePaths={drawnLinePaths}
        highlightedLineIds={highlightedLineIds}
        isTraced={overlay !== undefined}
      />
      {overlay && (
        <ZentrumSchematicLitLayer
          drawnLinePaths={drawnLinePaths}
          highlightedLineIds={highlightedLineIds}
          overlay={overlay}
        />
      )}
      <ZentrumSchematicStopMarks stopMarks={stopMarks} selectedStopId={selectedStopId} />
    </svg>
  );
}

/** Every line drawn whole -- in its colour, or as a quiet trace under a lit reading. */
const ZentrumSchematicTracks = memo(function ZentrumSchematicTracks({
  drawnLinePaths,
  highlightedLineIds,
  isTraced,
}: {
  drawnLinePaths: readonly ZentrumSchematicDrawnLinePath[];
  highlightedLineIds?: ReadonlySet<string>;
  isTraced: boolean;
}) {
  return (
    <g>
      {drawnLinePaths.map((linePath) => (
        <path
          key={`casing:${linePath.id}`}
          className="zentrum-schematic-network-track-casing"
          d={linePath.data}
        />
      ))}
      {/* The seam between touching lanes, and the rim around a band. */}
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
          stroke={isTraced ? undefined : linePath.sign.color}
          style={lineColor(linePath)}
          data-trace={isTraced ? "true" : undefined}
          data-dimmed={isDimmed(highlightedLineIds, linePath.lineIds)}
        />
      ))}
    </g>
  );
});

/** The overlay's corridors lit whole, and its stretches lit from a mark onwards. */
function ZentrumSchematicLitLayer({
  drawnLinePaths,
  highlightedLineIds,
  overlay,
}: {
  drawnLinePaths: readonly ZentrumSchematicDrawnLinePath[];
  highlightedLineIds?: ReadonlySet<string>;
  overlay: ZentrumSchematicOverlay;
}) {
  return (
    <g>
      {drawnLinePaths.flatMap((linePath) => {
        // A trunk and its branches share one path, lit wherever any of them is.
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
                data-dimmed={isDimmed(highlightedLineIds, linePath.lineIds)}
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
                data-dimmed={isDimmed(highlightedLineIds, [vehicle.lineId])}
              />,
            ];
          }),
        ];
      })}
      {getStrayLitSegments(drawnLinePaths, overlay).map(({ lineId, linePath, segment }) => (
        <path
          key={`stray:${lineId}:${segment.edgeId}`}
          className="zentrum-schematic-network-track-color"
          d={segment.data}
          stroke={linePath.sign.color}
          style={lineColor(linePath)}
          data-dimmed={isDimmed(highlightedLineIds, [lineId])}
        />
      ))}
    </g>
  );
}

/**
 * The stop capsules, over everything: all outlines first, then all bodies, so crossing rules merge
 * into one shape.
 */
const ZentrumSchematicStopMarks = memo(function ZentrumSchematicStopMarks({
  stopMarks,
  selectedStopId,
}: {
  stopMarks: readonly ZentrumSchematicStopMark[];
  selectedStopId?: string;
}) {
  return (
    <g>
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
    </g>
  );
});
