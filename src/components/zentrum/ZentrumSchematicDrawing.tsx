import { type CSSProperties, type SVGProps, memo, useId, useMemo } from "react";
import type { TransitLine } from "../../data/transit-types";
import { getPlanLineTone, needsLineOutline } from "../../data/line-signs";
import {
  getZentrumSchematicStopId,
  ZENTRUM_SCHEMATIC_VIEWBOX,
} from "../../lib/zentrum-schematic-plan";
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
export const getZentrumLitStretchKey = (markerKey: string, foregroundPathId?: string): string =>
  `stretch:${markerKey}${foregroundPathId === undefined ? "" : `:foreground:${encodeURIComponent(foregroundPathId)}`}`;

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
  ({
    "--zentrum-line-color": linePath.sign.color,
    "--zentrum-line-tone": getPlanLineTone(linePath.sign.color),
  }) as CSSProperties;

/** A lane with crossing clearance and a fine edge for pale colors. */
function ZentrumTrackStroke({
  isStretch,
  borderMask,
  clipPath,
  "data-dimmed": dimmed,
  ...stroke
}: Omit<SVGProps<SVGPathElement>, "className"> & {
  "data-dimmed"?: "true";
  /** A stretch lit to its mark, dashed by its group's animated offset. */
  isStretch?: boolean;
  borderMask?: string;
  "data-trace"?: "true";
  "data-unlit-style"?: ZentrumPlanOptions["unlitLineStyle"];
}) {
  const dash = isStretch
    ? ({ pathLength: 1, strokeDasharray: "1 2", "data-stretch": "true" } as const)
    : undefined;
  const solid = !stroke["data-trace"] && !stroke["data-unlit-style"];
  const outlined = solid && typeof stroke.stroke === "string" && needsLineOutline(stroke.stroke);
  return (
    <g className="zentrum-schematic-network-track" data-dimmed={dimmed} clipPath={clipPath}>
      {solid && !dimmed && (
        <path
          className="zentrum-schematic-network-track-gap"
          d={stroke.d}
          mask={borderMask}
          {...dash}
        />
      )}
      {outlined && (
        <path
          className="zentrum-schematic-network-track-outline"
          mask={borderMask}
          {...stroke}
          {...dash}
        />
      )}
      <path
        className="zentrum-schematic-network-track-color"
        data-pale={outlined ? "true" : undefined}
        {...stroke}
        {...dash}
      />
    </g>
  );
}

/** Borders stay outside the fill, combined where branches share a drawn track and color. */
const getBorderMasks = (paths: readonly ZentrumSchematicDrawnLinePath[], prefix: string) => {
  const byTrack = new Map<string, ZentrumSchematicDrawnLinePath[]>();
  for (const path of paths) {
    const key = `${path.trackId}\u0000${path.sign.color}`;
    const group = byTrack.get(key) ?? [];
    group.push(path);
    byTrack.set(key, group);
  }
  return [...byTrack.values()]
    .filter((group) => group.length > 1 || group.some((path) => path.foregroundRegions.length > 0))
    .map((group, index) => ({
      id: `${prefix}-merge-${index}`,
      paths: group,
      data: group.map((path) => path.data).join(" "),
      pale: needsLineOutline(group[0].sign.color),
    }));
};

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
  const segmentByCorridorId = new Map<string, ZentrumSchematicLinePathSegment>();
  for (const { segments } of drawnLinePaths) {
    for (const segment of segments) {
      if (!segmentByCorridorId.has(segment.corridorId))
        segmentByCorridorId.set(segment.corridorId, segment);
    }
  }
  return [...overlay.corridorIdsByLineId].flatMap(([lineId, corridorIds]) => {
    const own = drawnLinePaths.find((linePath) => linePath.lineIds.includes(lineId));
    if (!own) return [];
    const ownCorridorIds = new Set(own.segments.map(({ corridorId }) => corridorId));
    return [...corridorIds].flatMap((corridorId) => {
      const segment = ownCorridorIds.has(corridorId)
        ? undefined
        : segmentByCorridorId.get(corridorId);
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
  selectedLineId,
  onSelectLine,
  onHoverLines,
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
  selectedLineId?: string;
  onSelectLine: (lineId: string | undefined) => void;
  onHoverLines: (lineIds: readonly string[]) => void;
}) {
  const maskPrefix = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const borderMasks = useMemo(
    () => getBorderMasks(drawnLinePaths, maskPrefix),
    [drawnLinePaths, maskPrefix],
  );
  const borderMaskByPathId = useMemo(
    () =>
      new Map(
        borderMasks
          .filter((mask) => mask.paths.length > 1)
          .flatMap((mask) => mask.paths.map((path) => [path.id, `url(#${mask.id})`] as const)),
      ),
    [borderMasks],
  );
  // Foreground borders exclude the existing fill to keep clip edges invisible.
  const foregroundBorderMaskByPathId = useMemo(
    () =>
      new Map(
        borderMasks.flatMap((mask) =>
          mask.paths.map((path) => [path.id, `url(#${mask.id})`] as const),
        ),
      ),
    [borderMasks],
  );
  const foregroundClips = useMemo(
    () =>
      drawnLinePaths
        .filter((path) => path.foregroundRegions.length > 0)
        .map((path, index) => ({
          id: `${maskPrefix}-turn-${index}`,
          path,
        })),
    [drawnLinePaths, maskPrefix],
  );
  const foregroundClipByPathId = useMemo(
    () => new Map(foregroundClips.map(({ id, path }) => [path.id, `url(#${id})`])),
    [foregroundClips],
  );
  const maskBox = {
    x: ZENTRUM_SCHEMATIC_VIEWBOX.x - 50,
    y: ZENTRUM_SCHEMATIC_VIEWBOX.y - 50,
    width: ZENTRUM_SCHEMATIC_VIEWBOX.width + 100,
    height: ZENTRUM_SCHEMATIC_VIEWBOX.height + 100,
  };
  // Firefox requires lengths in px for calc() stroke widths inside the SVG.
  const lanes = (count: number) => `${trackWidth * count}px`;
  const trackStyle = {
    "--zentrum-schematic-track-width": lanes(1),
    "--zentrum-stop-capsule-width": lanes(ZENTRUM_SCHEMATIC_STOP_CAPSULE_WIDTH),
    "--zentrum-stop-capsule-fill": lanes(
      ZENTRUM_SCHEMATIC_STOP_CAPSULE_WIDTH * ZENTRUM_SCHEMATIC_STOP_CAPSULE_FILL,
    ),
    "--zentrum-stop-selection-ring-width": lanes(ZENTRUM_SCHEMATIC_STOP_CAPSULE_WIDTH + 1),
    "--zentrum-stop-selection-gap-width": lanes(ZENTRUM_SCHEMATIC_STOP_CAPSULE_WIDTH + 0.55),
    "--zentrum-stop-link-width": lanes(ZENTRUM_SCHEMATIC_STOP_LINK_WIDTH),
    "--zentrum-stop-link-pitch": lanes(ZENTRUM_SCHEMATIC_STOP_LINK_PITCH),
  } as CSSProperties;
  return (
    <svg
      viewBox={`${ZENTRUM_SCHEMATIC_VIEWBOX.x} ${ZENTRUM_SCHEMATIC_VIEWBOX.y} ${ZENTRUM_SCHEMATIC_VIEWBOX.width} ${ZENTRUM_SCHEMATIC_VIEWBOX.height}`}
      style={trackStyle}
      aria-label="Linien im Plan"
    >
      {(borderMasks.length > 0 || foregroundClips.length > 0) && (
        <defs>
          {foregroundClips.map(({ id, path }) => (
            <clipPath key={id} id={id}>
              {path.foregroundRegions.map((turn, index) => (
                <rect key={index} {...turn} />
              ))}
            </clipPath>
          ))}
          {borderMasks.map((mask) => (
            <mask key={mask.id} id={mask.id} maskUnits="userSpaceOnUse" {...maskBox}>
              <rect {...maskBox} fill="white" />
              <path
                className="zentrum-schematic-merge-mask"
                d={mask.data}
                data-pale={mask.pale ? "true" : undefined}
              />
            </mask>
          ))}
        </defs>
      )}
      <g aria-hidden="true" pointerEvents="none">
        <ZentrumSchematicTracks
          drawnLinePaths={drawnLinePaths}
          highlightedLineIds={highlightedLineIds}
          hasOverlay={overlay !== undefined}
          unlitLineStyle={unlitLineStyle}
          borderMaskByPathId={borderMaskByPathId}
        />
        {!overlay && (
          <ZentrumSchematicTracks
            drawnLinePaths={drawnLinePaths}
            highlightedLineIds={highlightedLineIds}
            hasOverlay={false}
            unlitLineStyle={unlitLineStyle}
            borderMaskByPathId={foregroundBorderMaskByPathId}
            foregroundClipByPathId={foregroundClipByPathId}
          />
        )}
        {overlay && (
          <ZentrumSchematicLitLayer
            drawnLinePaths={drawnLinePaths}
            highlightedLineIds={highlightedLineIds}
            overlay={overlay}
            borderMaskByPathId={borderMaskByPathId}
          />
        )}
        {overlay && (
          <ZentrumSchematicLitLayer
            drawnLinePaths={drawnLinePaths}
            highlightedLineIds={highlightedLineIds}
            overlay={overlay}
            foregroundClipByPathId={foregroundClipByPathId}
            borderMaskByPathId={foregroundBorderMaskByPathId}
          />
        )}
        <ZentrumSchematicStopMarks stopMarks={stopMarks} selectedStopId={selectedStopId} />
      </g>
      <g className="zentrum-schematic-line-targets" onMouseLeave={() => onHoverLines([])}>
        {drawnLinePaths.map((linePath) => {
          const lineId =
            selectedLineId !== undefined && linePath.lineIds.includes(selectedLineId)
              ? selectedLineId
              : linePath.lineId;
          const isSelected = selectedLineId === lineId;
          const toggleLine = () => onSelectLine(isSelected ? undefined : lineId);
          return (
            <path
              key={linePath.id}
              d={linePath.data}
              role="button"
              tabIndex={0}
              aria-label={
                isSelected ? `Linie ${lineId} nicht mehr verfolgen` : `Linie ${lineId} verfolgen`
              }
              aria-pressed={isSelected}
              onMouseEnter={() => onHoverLines(linePath.lineIds)}
              onMouseLeave={() => onHoverLines([])}
              onFocus={() => onHoverLines(linePath.lineIds)}
              onBlur={() => onHoverLines([])}
              onClick={toggleLine}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                toggleLine();
              }}
            />
          );
        })}
      </g>
    </svg>
  );
}

/** Every line drawn whole, in colour or as a quiet trace. */
const ZentrumSchematicTracks = memo(function ZentrumSchematicTracks({
  drawnLinePaths,
  highlightedLineIds,
  hasOverlay,
  unlitLineStyle,
  borderMaskByPathId,
  foregroundClipByPathId,
}: {
  drawnLinePaths: readonly ZentrumSchematicDrawnLinePath[];
  highlightedLineIds?: ReadonlySet<string>;
  hasOverlay: boolean;
  unlitLineStyle: ZentrumPlanOptions["unlitLineStyle"];
  borderMaskByPathId: ReadonlyMap<string, string>;
  foregroundClipByPathId?: ReadonlyMap<string, string>;
}) {
  return (
    <g>
      {drawnLinePaths.map((linePath) => {
        const dimmedAttribute = getDimmedAttribute(highlightedLineIds, linePath.lineIds);
        const clipPath = foregroundClipByPathId?.get(linePath.id);
        if (foregroundClipByPathId && (!clipPath || dimmedAttribute)) return null;
        const usesUnlitLineStyle = hasOverlay && unlitLineStyle !== "trace" && !dimmedAttribute;
        const isGrayTrace = hasOverlay && !usesUnlitLineStyle;
        return (
          <ZentrumTrackStroke
            key={`base:${linePath.id}`}
            d={linePath.data}
            borderMask={borderMaskByPathId.get(linePath.id)}
            clipPath={clipPath}
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
  borderMaskByPathId,
  foregroundClipByPathId,
}: {
  drawnLinePaths: readonly ZentrumSchematicDrawnLinePath[];
  highlightedLineIds?: ReadonlySet<string>;
  overlay: ZentrumSchematicOverlay;
  borderMaskByPathId: ReadonlyMap<string, string>;
  foregroundClipByPathId?: ReadonlyMap<string, string>;
}) {
  return (
    <g>
      {drawnLinePaths.flatMap((linePath) => {
        const clipPath = foregroundClipByPathId?.get(linePath.id);
        if (
          foregroundClipByPathId &&
          (!clipPath || getDimmedAttribute(highlightedLineIds, linePath.lineIds))
        )
          return [];
        // A trunk and its branches share one path, lit wherever any of them is.
        const litCorridorIds = new Set(
          linePath.lineIds.flatMap((lineId) => [
            ...(overlay.corridorIdsByLineId.get(lineId) ?? []),
          ]),
        );
        const segmentCorridorIds = new Set(linePath.segments.map(({ corridorId }) => corridorId));
        return [
          ...linePath.segments
            .filter((segment) => litCorridorIds.has(segment.corridorId))
            .map((segment) => (
              <ZentrumTrackStroke
                key={`lit:${linePath.id}:${segment.corridorId}`}
                d={segment.data}
                borderMask={borderMaskByPathId.get(linePath.id)}
                clipPath={clipPath}
                stroke={linePath.sign.color}
                style={getLineColorStyle(linePath)}
                data-dimmed={getDimmedAttribute(highlightedLineIds, linePath.lineIds)}
              />
            )),
          ...overlay.stretches.flatMap(({ vehicle, end }) => {
            // A mark off its line's drawn pattern follows an unpainted lane.
            if (
              !linePath.lineIds.includes(vehicle.lineId) ||
              !vehicle.path.corridorRanges.some(({ corridorId }) =>
                segmentCorridorIds.has(corridorId),
              )
            ) {
              return [];
            }
            const data = getZentrumSchematicVehiclePathData(vehicle.path, 0, end);
            if (!data) return [];
            if (foregroundClipByPathId && getDimmedAttribute(highlightedLineIds, [vehicle.lineId]))
              return [];
            const key = getZentrumLitStretchKey(
              vehicle.markerKey ?? vehicle.id,
              foregroundClipByPathId ? linePath.id : undefined,
            );
            // The animated lane inherits its dash offset from the group.
            return [
              <g
                key={key}
                data-marker-key={key}
                style={{ strokeDashoffset: getZentrumLitStretchOffset(vehicle.progress, end) }}
              >
                <ZentrumTrackStroke
                  d={data}
                  isStretch
                  borderMask={borderMaskByPathId.get(linePath.id)}
                  clipPath={clipPath}
                  stroke={linePath.sign.color}
                  style={getLineColorStyle(linePath)}
                  data-dimmed={getDimmedAttribute(highlightedLineIds, [vehicle.lineId])}
                />
              </g>,
            ];
          }),
        ];
      })}
      {getStrayLitSegments(drawnLinePaths, overlay).flatMap(({ lineId, linePath, segment }) => {
        const clipPath = foregroundClipByPathId?.get(linePath.id);
        if (
          foregroundClipByPathId &&
          (!clipPath || getDimmedAttribute(highlightedLineIds, [lineId]))
        )
          return [];
        return [
          <ZentrumTrackStroke
            key={`stray:${lineId}:${segment.corridorId}`}
            d={segment.data}
            clipPath={clipPath}
            stroke={linePath.sign.color}
            style={getLineColorStyle(linePath)}
            data-dimmed={getDimmedAttribute(highlightedLineIds, [lineId])}
          />,
        ];
      })}
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
    isSelected: getZentrumSchematicStopId(mark.nodeId) === selectedStopId ? "true" : undefined,
  }));
  const selectedMarks = marks.filter((mark) => mark.isSelected);
  return (
    <g>
      {marks.map(({ nodeId, links }) =>
        links ? (
          <path key={`link:${nodeId}`} className="zentrum-schematic-stop-link" d={links} />
        ) : null,
      )}
      {selectedMarks.map(({ nodeId, capsules }) => (
        <path
          key={`ring:${nodeId}`}
          className="zentrum-schematic-stop-selection-ring"
          d={capsules}
        />
      ))}
      {selectedMarks.map(({ nodeId, capsules }) => (
        <path key={`gap:${nodeId}`} className="zentrum-schematic-stop-selection-gap" d={capsules} />
      ))}
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
