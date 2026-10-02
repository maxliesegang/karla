import { LineBadge } from "../LineBadge";
import { SegmentedControl } from "../SegmentedControl";
import type { ZentrumLineSignReader } from "./line-sign";

/** The plan's own two readings: its lines, or where the trams on it are still going. */
export type ZentrumPlanReading = "lines" | "progress";

const PLAN_READINGS = [
  { value: "lines", label: "Linien" },
  { value: "progress", label: "Fahrwege" },
] as const;

/**
 * One band of controls under the plan: the legend, the caption, and the plan's reading.
 *
 * The legend is also the filter: a badge is the one gesture that follows a line, whatever the
 * reading. The plan's reading changes what the map lights rather than the route being followed,
 * and leaves while an opened stop decides that instead. The size the plan is drawn at is not here:
 * it is a control of the drawing, so it floats on the drawing (`ZentrumPlanControls`).
 */
export function ZentrumSchematicToolbar({
  caption,
  lineIds,
  getSign,
  selectedLineId,
  onSelectLine,
  planReading,
  onChangePlanReading,
}: {
  /** What the drawing cannot say of itself: what the colour means, and how many are running. */
  caption: string;
  lineIds: readonly string[];
  getSign: ZentrumLineSignReader;
  /** The line the plan is following, as the address names it. */
  selectedLineId?: string;
  onSelectLine: (lineId: string | undefined) => void;
  planReading: ZentrumPlanReading;
  /** Absent while an opened stop decides what is lit, which leaves the plan's reading nothing to do. */
  onChangePlanReading?: (reading: ZentrumPlanReading) => void;
}) {
  return (
    <div className="zentrum-schematic-toolbar">
      <div
        className="zentrum-schematic-lines"
        data-has-selection={selectedLineId !== undefined}
        aria-label="Linie im Plan verfolgen"
        role="group"
      >
        {selectedLineId !== undefined && (
          <button
            type="button"
            className="zentrum-schematic-lines-reset"
            onClick={() => onSelectLine(undefined)}
          >
            Alle Linien
          </button>
        )}
        {lineIds.map((lineId) => {
          const isSelected = selectedLineId === lineId;
          return (
            <button
              key={lineId}
              type="button"
              className={isSelected ? "selected" : undefined}
              aria-pressed={isSelected}
              aria-label={
                isSelected ? `Linie ${lineId} nicht mehr verfolgen` : `Linie ${lineId} verfolgen`
              }
              onClick={() => onSelectLine(isSelected ? undefined : lineId)}
            >
              <LineBadge line={getSign(lineId)} size="xs" />
            </button>
          );
        })}
      </div>
      <p className="zentrum-schematic-caption">{caption}</p>
      {onChangePlanReading && (
        <SegmentedControl
          className="departure-board-order-control zentrum-schematic-reading"
          value={planReading}
          items={PLAN_READINGS}
          onValueChange={onChangePlanReading}
          ariaLabel="Was der Plan zeigt"
        />
      )}
    </div>
  );
}

/**
 * The drawing's own controls, floating in its corner the way every map's are: the size the plan is
 * read at, and the size it is drawn at. On the drawing rather than in the band under it, so a phone
 * does not give a whole row of the screen to three buttons.
 */
export function ZentrumPlanControls({
  zoom,
  canZoomIn,
  canZoomOut,
  onChangeZoom,
  isFullscreen,
  onChangeFullscreen,
}: {
  zoom: number;
  canZoomIn: boolean;
  canZoomOut: boolean;
  onChangeZoom: (direction: 1 | -1) => void;
  /** Whether the plan is being read at the size of the screen. */
  isFullscreen: boolean;
  onChangeFullscreen: (isFullscreen: boolean) => void;
}) {
  return (
    <div className="zentrum-plan-controls">
      <button
        type="button"
        className="zentrum-plan-expand"
        aria-pressed={isFullscreen}
        aria-label={isFullscreen ? "Vollbild verlassen" : "Vollbild"}
        title={isFullscreen ? "Vollbild verlassen" : "Vollbild"}
        onClick={() => onChangeFullscreen(!isFullscreen)}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path
            d={
              isFullscreen
                ? "M12 3.5V8h4.5M8 16.5V12H3.5M12 8l4.5-4.5M8 12l-4.5 4.5"
                : "M12 3.5h4.5V8M8 16.5H3.5V12M16.5 3.5 12 8M3.5 16.5 8 12"
            }
          />
        </svg>
      </button>
      <div className="zentrum-plan-zoom" role="group" aria-label="Zoom">
        <button
          type="button"
          aria-label="Vergrößern"
          title="Vergrößern"
          disabled={!canZoomIn}
          onClick={() => onChangeZoom(1)}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M10 4.5v11M4.5 10h11" />
          </svg>
        </button>
        <button
          type="button"
          aria-label="Verkleinern"
          title="Verkleinern"
          disabled={!canZoomOut}
          onClick={() => onChangeZoom(-1)}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M4.5 10h11" />
          </svg>
        </button>
      </div>
      {/* The step is spoken rather than printed: the drawing already shows it, and a screen reader
          pressing a button it cannot see still needs to be told what it did. */}
      <span className="visually-hidden" aria-live="polite">
        {zoom === 1 ? "ganzer Plan" : `${Math.round(zoom * 100)} %`}
      </span>
    </div>
  );
}
