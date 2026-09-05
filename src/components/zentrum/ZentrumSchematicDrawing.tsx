import { type CSSProperties, memo } from "react";
import type { TransitLine } from "../../data/transit-types";
import {
  ZENTRUM_SCHEMATIC_VIEWBOX,
  type ZentrumSchematicEdge,
} from "../../lib/zentrum-schematic-plan";
import {
  type ZentrumSchematicDrawnPath,
  getZentrumSchematicLinePathSegments,
} from "../../lib/zentrum-schematic-paths";
import { type ZentrumSchematicStopMark } from "../../lib/zentrum-schematic-stops";

/** One line pattern the drawing paints, with the sign it is painted in. */
export type ZentrumDrawnLinePath = ZentrumSchematicDrawnPath & {
  /** The sign the pattern is painted in, as the live network states the line. */
  sign: TransitLine;
};

/**
 * The painted drawing: the corridors, the lanes on them, and the rules the stops are marked with.
 *
 * Everything here is a reading of the schematic, not of the second -- the marks that move ride the
 * canvas above it. Memoized, so the one-second vehicle clock re-renders those marks and the caption
 * and leaves the drawing standing until the reading itself changes.
 */
export const ZentrumSchematicDrawing = memo(function ZentrumSchematicDrawing({
  edges,
  drawnLinePaths,
  stopMarks,
  selectedLineId,
  aheadEdgeIdsByTrackId,
  trackWidth,
}: {
  edges: readonly ZentrumSchematicEdge[];
  drawnLinePaths: readonly ZentrumDrawnLinePath[];
  stopMarks: readonly ZentrumSchematicStopMark[];
  /** The line being followed, which is painted at full strength while the rest of the band recedes. */
  selectedLineId?: string;
  /**
   * The corridors the followed line's vehicles are still to run: a stretch no vehicle of it is
   * making for is drawn in the drawing's own grey instead of its sign colour. Absent -- and every
   * stretch keeps its colour -- wherever no line is being followed.
   */
  aheadEdgeIdsByTrackId?: ReadonlyMap<string, ReadonlySet<string>>;
  /** The one width the lanes are laid out on, which is also the width they are painted at. */
  trackWidth: number;
}) {
  // The lanes are laid exactly one lane's width apart, so the stroke that paints them has to be
  // that same width for the colours to meet. The layout is where that width is decided; the
  // stylesheet is told it here rather than keeping a second copy of it that could drift.
  const trackStyle = { "--zentrum-schematic-track-width": trackWidth } as CSSProperties;
  return (
    <svg
      viewBox={`${ZENTRUM_SCHEMATIC_VIEWBOX.x} ${ZENTRUM_SCHEMATIC_VIEWBOX.y} ${ZENTRUM_SCHEMATIC_VIEWBOX.width} ${ZENTRUM_SCHEMATIC_VIEWBOX.height}`}
      style={trackStyle}
      aria-hidden="true"
      focusable="false"
    >
      {edges.map((edge) => (
        <line
          key={edge.id}
          className="zentrum-schematic-corridor"
          x1={edge.from.x}
          y1={edge.from.y}
          x2={edge.to.x}
          y2={edge.to.y}
        />
      ))}
      {drawnLinePaths.map((linePath) => (
        <path
          key={`casing:${linePath.id}`}
          className="zentrum-schematic-network-track-casing"
          d={linePath.data}
        />
      ))}
      {/* The rule between the lanes: the same paths one pass over the casing and under every
          colour, laid at the lane width the colours are painted short of, so it surfaces as a fine
          seam between touching lanes -- and as a rim around the band's outside. The grey stretches
          paint their lanes at the full width and bury their own rule again. */}
      {drawnLinePaths.map((linePath) => (
        <path
          key={`seam:${linePath.id}`}
          className="zentrum-schematic-network-track-seam"
          d={linePath.data}
        />
      ))}
      {drawnLinePaths.flatMap((linePath) => {
        // A line nobody is following is drawn whole. The one being followed is lit stretch by
        // stretch -- in front of its vehicles -- and leaves the rest of its lane to the drawing's
        // own grey. Keyed by the lane, so a branch lights the lane it is drawn sharing with its
        // trunk.
        const isFollowed =
          selectedLineId !== undefined && linePath.lineIds.includes(selectedLineId);
        const isDimmed = selectedLineId !== undefined && !isFollowed;
        const lightsAhead = isFollowed && aheadEdgeIdsByTrackId !== undefined;
        const aheadEdgeIds = aheadEdgeIdsByTrackId?.get(linePath.trackId);
        const segments = lightsAhead
          ? getZentrumSchematicLinePathSegments(linePath, edges, trackWidth)
          : [{ edgeId: linePath.id, data: linePath.data }];
        return segments.map((segment) => {
          const hasVehicles = lightsAhead ? (aheadEdgeIds?.has(segment.edgeId) ?? false) : true;
          return (
            <path
              key={`${linePath.id}:${segment.edgeId}`}
              className="zentrum-schematic-network-track-color"
              d={segment.data}
              stroke={hasVehicles ? linePath.sign.color : undefined}
              data-has-vehicles={lightsAhead ? (hasVehicles ? "true" : "false") : undefined}
              data-dimmed={isDimmed ? "true" : undefined}
            />
          );
        });
      })}
      {/* The stops, last and over everything: a fine rule laid across the lines calling there.
          Twice, as the lanes themselves are painted -- a casing of the page's own colour so the
          rule reads over eight colours as clearly as over one, and the rule itself on top of it. */}
      {stopMarks.map((mark) => (
        <path
          key={`casing:${mark.nodeId}`}
          className="zentrum-schematic-stop-mark-casing"
          d={mark.data}
        />
      ))}
      {stopMarks.map((mark) => (
        <path key={mark.nodeId} className="zentrum-schematic-stop-mark" d={mark.data} />
      ))}
    </svg>
  );
});
