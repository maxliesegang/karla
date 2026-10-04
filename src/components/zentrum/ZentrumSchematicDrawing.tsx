import { type CSSProperties, type SVGProps, memo } from "react";
import type { TransitLine } from "../../data/transit-types";
import { ZENTRUM_SCHEMATIC_VIEWBOX } from "../../lib/zentrum-schematic-plan";
import {
  type ZentrumSchematicDrawnPath,
  type ZentrumSchematicLinePathSegment,
  getZentrumSchematicVehiclePathData,
} from "../../lib/zentrum-schematic-paths";
import type { ZentrumPlanOptions } from "../../lib/zentrum-plan-options";
import type { ZentrumSchematicOverlay } from "../../lib/zentrum-schematic-overlays";
import {
  ZENTRUM_SCHEMATIC_STOP_CAPSULE_FILL,
  ZENTRUM_SCHEMATIC_STOP_CAPSULE_WIDTH,
  ZENTRUM_SCHEMATIC_STOP_LINK_PITCH,
  ZENTRUM_SCHEMATIC_STOP_LINK_WIDTH,
  type ZentrumSchematicStopMark,
  getZentrumSchematicStrokeData,
} from "../../lib/zentrum-schematic-stops";

/** One line pattern the drawing paints, with the sign the live network states for it. */
export type ZentrumSchematicDrawnLinePath = ZentrumSchematicDrawnPath & { sign: TransitLine };

/** A lit stretch's key, so its dash can follow its mark's animation. */
export const getZentrumLitStretchKey = (markerKey: string): string => `stretch:${markerKey}`;

/** The dash offset lighting a `pathLength="1"` stretch from `progress` to `end`. */
export const getZentrumLitStretchOffset = (progress: number, end: number): string =>
  `${-Math.min(1, Math.max(0, progress / end))}px`;

/** Whether a stroke recedes: none of its lines is kept at full strength. */
const getDimmedAttribute = (
  highlightedLineIds: ReadonlySet<string> | undefined,
  lineIds: readonly string[],
): "true" | undefined =>
  highlightedLineIds !== undefined && !lineIds.some((lineId) => highlightedLineIds.has(lineId))
    ? "true"
    : undefined;

const getLineColorStyle = (linePath: ZentrumSchematicDrawnLinePath) =>
  ({ "--zentrum-line-color": linePath.sign.color }) as CSSProperties;

/** A track stroke with a surface-colored gap at crossings; dimmed tracks leave no gap. */
function ZentrumTrackStroke({
  isStretch,
  ...stroke
}: Omit<SVGProps<SVGPathElement>, "className"> & {
  "data-dimmed"?: "true";
  /** A stretch lit to its mark, dashed by its group's animated offset. */
  isStretch?: boolean;
}) {
  const dash = isStretch
    ? ({ pathLength: 1, strokeDasharray: "1 2", "data-stretch": "true" } as const)
    : undefined;
  return (
    <>
      {!stroke["data-dimmed"] && (
        <path className="zentrum-schematic-network-track-gap" d={stroke.d} {...dash} />
      )}
      <path className="zentrum-schematic-network-track-color" {...stroke} {...dash} />
    </>
  );
}

/**
 * Corridors a line is lit along that its drawn pattern does not run (an S8 via the Hauptbahnhof),
 * lit in another line's lane in this line's colour.
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
 * The painted drawing: every line in colour, or quiet traces with an overlay lit over them. Three
 * layers at three rates (lanes, stop marks, overlay); only the overlay re-renders each tick.
 */
export function ZentrumSchematicDrawing({
  drawnLinePaths,
  stopMarks,
  highlightedLineIds,
  selectedStopId,
  overlay,
  unlitLineStyle = "trace",
  trackWidth,
}: {
  drawnLinePaths: readonly ZentrumSchematicDrawnLinePath[];
  stopMarks: readonly ZentrumSchematicStopMark[];
  /** The lines kept at full strength. */
  highlightedLineIds?: ReadonlySet<string>;
  /** The opened stop, whose capsules are filled. */
  selectedStopId?: string;
  /** What is lit over the traces; nothing draws every line whole. */
  overlay?: ZentrumSchematicOverlay;
  /** How highlighted lines are drawn where the overlay does not light them. */
  unlitLineStyle?: ZentrumPlanOptions["unlitLineStyle"];
  /** The lane width, which is also the lane pitch. */
  trackWidth: number;
}) {
  // Stroke width must equal lane pitch for colours to meet. Lengths are px (user units in the SVG):
  // Firefox drops a unitless calc() as a stroke width.
  const lanes = (count: number) => `${trackWidth * count}px`;
  const trackStyle = {
    "--zentrum-schematic-track-width": lanes(1),
    "--zentrum-stop-capsule-width": lanes(ZENTRUM_SCHEMATIC_STOP_CAPSULE_WIDTH),
    "--zentrum-stop-capsule-fill": lanes(
      ZENTRUM_SCHEMATIC_STOP_CAPSULE_WIDTH * ZENTRUM_SCHEMATIC_STOP_CAPSULE_FILL,
    ),
    "--zentrum-stop-link-width": lanes(ZENTRUM_SCHEMATIC_STOP_LINK_WIDTH),
    "--zentrum-stop-link-pitch": lanes(ZENTRUM_SCHEMATIC_STOP_LINK_PITCH),
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
        hasOverlay={overlay !== undefined}
        unlitLineStyle={unlitLineStyle}
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

/** Every line drawn whole, in colour or as a quiet trace. */
const ZentrumSchematicTracks = memo(function ZentrumSchematicTracks({
  drawnLinePaths,
  highlightedLineIds,
  hasOverlay,
  unlitLineStyle,
}: {
  drawnLinePaths: readonly ZentrumSchematicDrawnLinePath[];
  highlightedLineIds?: ReadonlySet<string>;
  hasOverlay: boolean;
  unlitLineStyle: ZentrumPlanOptions["unlitLineStyle"];
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
      {drawnLinePaths.map((linePath) => {
        const dimmedAttribute = getDimmedAttribute(highlightedLineIds, linePath.lineIds);
        const usesUnlitLineStyle = hasOverlay && unlitLineStyle !== "trace" && !dimmedAttribute;
        const isGrayTrace = hasOverlay && !usesUnlitLineStyle;
        return (
          <ZentrumTrackStroke
            key={`base:${linePath.id}`}
            d={linePath.data}
            stroke={isGrayTrace ? undefined : linePath.sign.color}
            style={getLineColorStyle(linePath)}
            data-trace={isGrayTrace ? "true" : undefined}
            data-unlit-style={usesUnlitLineStyle ? unlitLineStyle : undefined}
            data-dimmed={dimmedAttribute}
          />
        );
      })}
    </g>
  );
});

/** The overlay: corridors lit whole and stretches lit from marks onwards. */
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
              <ZentrumTrackStroke
                key={`lit:${linePath.id}:${segment.edgeId}`}
                d={segment.data}
                stroke={linePath.sign.color}
                style={getLineColorStyle(linePath)}
                data-dimmed={getDimmedAttribute(highlightedLineIds, linePath.lineIds)}
              />
            )),
          ...overlay.stretches.flatMap(({ vehicle, end }) => {
            // A mark off its line's drawn pattern follows an unpainted lane.
            if (
              !linePath.lineIds.includes(vehicle.lineId) ||
              !vehicle.path.edgeRanges.some(({ edgeId }) => segmentEdgeIds.has(edgeId))
            ) {
              return [];
            }
            const data = getZentrumSchematicVehiclePathData(vehicle.path, 0, end);
            if (!data) return [];
            const key = getZentrumLitStretchKey(vehicle.markerKey ?? vehicle.id);
            // The offset is set on the group, which the gap and the colour both inherit.
            return [
              <g
                key={key}
                data-marker-key={key}
                style={{ strokeDashoffset: getZentrumLitStretchOffset(vehicle.progress, end) }}
              >
                <ZentrumTrackStroke
                  d={data}
                  isStretch
                  stroke={linePath.sign.color}
                  style={getLineColorStyle(linePath)}
                  data-dimmed={getDimmedAttribute(highlightedLineIds, [vehicle.lineId])}
                />
              </g>,
            ];
          }),
        ];
      })}
      {getStrayLitSegments(drawnLinePaths, overlay).map(({ lineId, linePath, segment }) => (
        <ZentrumTrackStroke
          key={`stray:${lineId}:${segment.edgeId}`}
          d={segment.data}
          stroke={linePath.sign.color}
          style={getLineColorStyle(linePath)}
          data-dimmed={getDimmedAttribute(highlightedLineIds, [lineId])}
        />
      ))}
    </g>
  );
}

/**
 * The stop capsules over everything: outlines then bodies, so capsules at one stop merge. Dotted
 * links lie under them.
 */
const ZentrumSchematicStopMarks = memo(function ZentrumSchematicStopMarks({
  stopMarks,
  selectedStopId,
}: {
  stopMarks: readonly ZentrumSchematicStopMark[];
  selectedStopId?: string;
}) {
  const marks = stopMarks.map((mark) => ({
    nodeId: mark.nodeId,
    capsules: getZentrumSchematicStrokeData(mark.capsules),
    links: getZentrumSchematicStrokeData(mark.links),
    isSelected: mark.nodeId === selectedStopId ? "true" : undefined,
  }));
  return (
    <g>
      {marks.map(({ nodeId, links }) =>
        links ? (
          <path key={`link:${nodeId}`} className="zentrum-schematic-stop-link" d={links} />
        ) : null,
      )}
      {marks.map(({ nodeId, capsules }) => (
        <path
          key={`casing:${nodeId}`}
          className="zentrum-schematic-stop-mark-casing"
          d={capsules}
        />
      ))}
      {marks.map(({ nodeId, capsules, isSelected }) => (
        <path
          key={nodeId}
          className="zentrum-schematic-stop-mark"
          d={capsules}
          data-selected={isSelected}
        />
      ))}
    </g>
  );
});
