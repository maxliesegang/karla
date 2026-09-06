import { LineBadge } from "../LineBadge";
import type { ZentrumLineSignReader } from "./line-sign";

/**
 * One band of controls under the plan rather than four.
 *
 * The zoom sits at the end a thumb reaches, the legend runs along the rest of it, and the legend is
 * also the filter: a badge is the one gesture that follows a line, whatever the reading. Beside the
 * zoom stands the size the plan is read at — one is how much of the Zentrum is in the box, the
 * other is how big the box is, and a reader reaching for one is reaching for the other next.
 *
 * The caption rides the same band, between the two. It used to stand on a row of its own as a
 * bordered pill, which gave the foot of the page two lines of chrome that lined up with nothing:
 * a pill floating over the legend under it. Set as plain text on the controls' own baseline it
 * says exactly as much, and the plan gets the row back.
 */
export function ZentrumSchematicToolbar({
  caption,
  lineIds,
  getSign,
  selectedLineId,
  onSelectLine,
  zoom,
  canZoomIn,
  canZoomOut,
  onChangeZoom,
  isFullscreen,
  onChangeFullscreen,
}: {
  /** What the drawing cannot say of itself: what the marks are worth, and how many are running. */
  caption: string;
  lineIds: readonly string[];
  getSign: ZentrumLineSignReader;
  /** The line the plan is following, as the address names it. */
  selectedLineId?: string;
  onSelectLine: (lineId: string | undefined) => void;
  zoom: number;
  canZoomIn: boolean;
  canZoomOut: boolean;
  onChangeZoom: (direction: 1 | -1) => void;
  /** Whether the plan is being read at the size of the screen. */
  isFullscreen: boolean;
  onChangeFullscreen: (isFullscreen: boolean) => void;
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
            Alle
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
      <div className="zentrum-schematic-zoom">
        <button
          type="button"
          className="zentrum-schematic-expand"
          aria-pressed={isFullscreen}
          aria-label={isFullscreen ? "Vollbild verlassen" : "Plan im Vollbild lesen"}
          onClick={() => onChangeFullscreen(!isFullscreen)}
        >
          {isFullscreen ? "\u2715" : "\u2922"}
        </button>
        <button
          type="button"
          aria-label="Plan verkleinern"
          disabled={!canZoomOut}
          onClick={() => onChangeZoom(-1)}
        >
          −
        </button>
        <button
          type="button"
          aria-label="Plan vergrößern"
          disabled={!canZoomIn}
          onClick={() => onChangeZoom(1)}
        >
          +
        </button>
        {/* The step is spoken rather than printed: it was a third of a control band spent
            restating what the drawing in front of the reader already shows, and a screen reader
            pressing a button it cannot see still needs to be told what it did. */}
        <span className="visually-hidden" aria-live="polite">
          {zoom === 1 ? "ganzer Plan" : `${Math.round(zoom * 100)} %`}
        </span>
      </div>
    </div>
  );
}
