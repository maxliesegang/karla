import { LineBadge } from "../LineBadge";
import type { ZentrumLineSignReader } from "./line-sign";

/** The band under the plan: legend and caption. Tapping a badge follows that line. */
export function ZentrumSchematicToolbar({
  caption,
  lineIds,
  getSign,
  selectedLineId,
  onSelectLine,
}: {
  /** What the drawing cannot say itself: what the colour means, and how many trams run. */
  caption: string;
  lineIds: readonly string[];
  getSign: ZentrumLineSignReader;
  /** The followed line, as the address names it. */
  selectedLineId?: string;
  onSelectLine: (lineId: string | undefined) => void;
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
    </div>
  );
}

/** The drawing's own zoom and full-screen controls, floating on it so a phone saves a row. */
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
      {/* Spoken, not printed: the drawing shows the step, a screen reader needs telling. */}
      <span className="visually-hidden" aria-live="polite">
        {zoom === 1 ? "ganzer Plan" : `${Math.round(zoom * 100)} %`}
      </span>
    </div>
  );
}
