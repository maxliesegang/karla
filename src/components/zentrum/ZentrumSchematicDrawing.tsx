import { type CSSProperties, memo } from "react";
import type { TransitLine } from "../../data/transit-types";
import {
  ZENTRUM_SCHEMATIC_VIEWBOX,
  type ZentrumSchematicEdge,
} from "../../lib/zentrum-schematic-plan";
import {
  type ZentrumSchematicDrawnPath,
  getZentrumSchematicLinePathSegments,
  getZentrumSchematicVehiclePathData,
} from "../../lib/zentrum-schematic-paths";
import type { ZentrumSchematicVehicle } from "../../lib/zentrum-schematic";
import { type ZentrumSchematicStopMark } from "../../lib/zentrum-schematic-stops";

/** One line pattern the drawing paints, with the sign it is painted in. */
export type ZentrumSchematicDrawnLinePath = ZentrumSchematicDrawnPath & {
  /** The sign the pattern is painted in, as the live network states the line. */
  sign: TransitLine;
};

/**
 * The painted drawing: the corridors, the lanes on them, and the rules the stops are marked with.
 *
 * Everything here is a reading of the schematic and its vehicle positions -- the marks that move
 * ride the canvas above it, while the selected line's or enabled all-lines colour boundaries follow
 * them. Memoized, so unchanged geometry and stop marks remain shared between those position updates.
 */
export const ZentrumSchematicDrawing = memo(function ZentrumSchematicDrawing({
  edges,
  drawnLinePaths,
  stopMarks,
  highlightedLineIds,
  vehicles,
  showVehicleProgress,
  trackWidth,
}: {
  edges: readonly ZentrumSchematicEdge[];
  drawnLinePaths: readonly ZentrumSchematicDrawnLinePath[];
  stopMarks: readonly ZentrumSchematicStopMark[];
  /** The lines kept at full strength by either a followed line or a selected station. */
  highlightedLineIds?: ReadonlySet<string>;
  /** The marks whose position determines where a live overlay starts and ends. */
  vehicles: readonly ZentrumSchematicVehicle[];
  /** Whether the map should show the live-reach overlay over the general route traces. */
  showVehicleProgress: boolean;
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
      {drawnLinePaths.flatMap((linePath) => {
        // Without progress colouring a line is drawn whole in its sign colour. With it, every
        // line starts as a quiet route trace, then a solid colour overlay shows the part still
        // reachable by a vehicle. The overlays are keyed by the lane, so a branch lights the lane
        // it shares with its trunk.
        const isHighlighted = highlightedLineIds
          ? linePath.lineIds.some((lineId) => highlightedLineIds.has(lineId))
          : false;
        const isDimmed = highlightedLineIds !== undefined && !isHighlighted;
        const lineVehicles = showVehicleProgress
          ? vehicles.filter(
              (vehicle) =>
                linePath.lineIds.includes(vehicle.lineId) &&
                (highlightedLineIds === undefined || highlightedLineIds.has(vehicle.lineId)),
            )
          : [];
        const hasPositionReading = showVehicleProgress && lineVehicles.length > 0;
        const segments = showVehicleProgress
          ? getZentrumSchematicLinePathSegments(linePath, edges, trackWidth)
          : [{ edgeId: linePath.id, data: linePath.data }];
        const currentEdgeIds = new Set(
          lineVehicles.flatMap((vehicle) => vehicle.path.edgeRanges.map(({ edgeId }) => edgeId)),
        );
        const aheadEdgeIds = new Set(lineVehicles.flatMap((vehicle) => vehicle.aheadEdgeIds));
        const aheadSegments = hasPositionReading
          ? segments.filter(
              (segment) => aheadEdgeIds.has(segment.edgeId) && !currentEdgeIds.has(segment.edgeId),
            )
          : [];
        const vehicleSuffixes = hasPositionReading
          ? lineVehicles.flatMap((vehicle) => {
              const pathIsOnLine = vehicle.path.edgeRanges.some(({ edgeId }) =>
                segments.some((segment) => segment.edgeId === edgeId),
              );
              if (!pathIsOnLine) return [];
              const data = getZentrumSchematicVehiclePathData(vehicle.path, vehicle.progress);
              return data ? [{ vehicle, data }] : [];
            })
          : [];
        return [
          <path
            key={`base:${linePath.id}`}
            className="zentrum-schematic-network-track-color"
            d={linePath.data}
            stroke={showVehicleProgress ? undefined : linePath.sign.color}
            style={{ "--zentrum-line-color": linePath.sign.color } as CSSProperties}
            data-has-vehicles={showVehicleProgress ? "false" : undefined}
            data-dimmed={isDimmed ? "true" : undefined}
          />,
          ...aheadSegments.map((segment) => (
            <path
              key={`ahead:${linePath.id}:${segment.edgeId}`}
              className="zentrum-schematic-network-track-color"
              d={segment.data}
              stroke={linePath.sign.color}
              style={{ "--zentrum-line-color": linePath.sign.color } as CSSProperties}
              data-has-vehicles="true"
              data-dimmed={isDimmed ? "true" : undefined}
            />
          )),
          ...vehicleSuffixes.map(({ vehicle, data }) => (
            <path
              key={`vehicle-ahead:${linePath.id}:${vehicle.id}`}
              className="zentrum-schematic-network-track-color"
              d={data}
              stroke={linePath.sign.color}
              style={{ "--zentrum-line-color": linePath.sign.color } as CSSProperties}
              data-has-vehicles="true"
              data-dimmed={isDimmed ? "true" : undefined}
            />
          )),
        ];
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
