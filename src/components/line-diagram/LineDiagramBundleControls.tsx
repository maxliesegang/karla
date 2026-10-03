import { useEffect, useRef, type CSSProperties, type MouseEvent } from "react";
import type { TransitLine } from "../../data/transit-types";
import { classNames } from "../../lib/class-names";
import type { LineBundleControl } from "../../lib/line-bundles";

/**
 * The bundle control in the line header: one folded control opening an overlay to add or drop
 * siblings. Each option wears its line's colours; an offer names the stop it reaches.
 */
export function LineDiagramBundleControls({
  controls,
  lineById,
  fallbackLine,
  onChangeBundle,
}: {
  controls: readonly LineBundleControl[];
  lineById: ReadonlyMap<string, TransitLine>;
  /** The line read, whose colours stand in for an unnamed sibling. */
  fallbackLine: TransitLine;
  onChangeBundle: (bundledLineIds: readonly string[]) => void;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !detailsRef.current?.contains(event.target)) {
        detailsRef.current?.removeAttribute("open");
      }
    };
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !detailsRef.current?.open) return;
      detailsRef.current.removeAttribute("open");
      detailsRef.current.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeWithEscape);
    };
  }, []);

  if (controls.length === 0) return null;
  const bundled = controls.filter(({ isActive }) => isActive);
  const offers = controls.filter(({ isActive }) => !isActive);
  /** One line's colours, for the sign plate and its pill. */
  const lineStyle = (lineId: string) => {
    const controlLine = lineById.get(lineId) ?? fallbackLine;
    return {
      "--line-color": controlLine.color,
      "--line-text": controlLine.textColor,
    } as CSSProperties;
  };
  const renderToggle = ({
    lineId,
    isActive,
    next,
    label,
    sharedUntilStopName,
  }: LineBundleControl) => (
    <button
      key={lineId}
      type="button"
      className={classNames("line-diagram-bundle-option", isActive && "active")}
      style={lineStyle(lineId)}
      aria-pressed={isActive}
      aria-label={label}
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        event.currentTarget.closest("details")?.removeAttribute("open");
        onChangeBundle(next);
      }}
    >
      <b className="line-diagram-bundle-sign" aria-hidden="true">
        {lineId}
      </b>
      <span className="line-diagram-bundle-option-copy" aria-hidden="true">
        <strong>Linie {lineId}</strong>
        <small>
          {isActive
            ? "Wird gemeinsam angezeigt"
            : sharedUntilStopName
              ? `Gleicher Weg bis ${sharedUntilStopName}`
              : "Zum Korridor hinzufügen"}
        </small>
      </span>
      <i className="line-diagram-bundle-option-state" aria-hidden="true">
        {isActive ? "−" : "+"}
      </i>
    </button>
  );
  return (
    <div className="line-diagram-bundle" role="group" aria-label="Linien bündeln">
      <details ref={detailsRef} className="line-diagram-bundle-offers">
        <summary
          aria-label={`Linien im Korridor bündeln${bundled.length > 0 ? `, ${bundled.length + 1} Linien ausgewählt` : ""}`}
        >
          <svg
            className="line-diagram-bundle-icon"
            viewBox="0 0 20 20"
            fill="none"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M4 2v3c0 .55.45 1 1 1h5" />
            <path d="M16 2v3c0 .55-.45 1-1 1h-5" />
            <path d="M10 6v8" />
            <path d="M10 14H5c-.55 0-1 .45-1 1v3" />
            <path d="M10 14h5c.55 0 1 .45 1 1v3" />
          </svg>
        </summary>
        <div className="line-diagram-bundle-overlay">
          <div className="line-diagram-bundle-overlay-heading">
            <strong>Linien im Korridor</strong>
            <small>Gemeinsam auf einem Linienweg anzeigen</small>
          </div>
          <div className="line-diagram-bundle-options">
            <div
              className="line-diagram-bundle-option primary active"
              style={lineStyle(fallbackLine.id)}
            >
              <b className="line-diagram-bundle-sign" aria-hidden="true">
                {fallbackLine.id}
              </b>
              <span className="line-diagram-bundle-option-copy">
                <strong>Linie {fallbackLine.id}</strong>
                <small>Ausgangslinie</small>
              </span>
              <i className="line-diagram-bundle-option-check" aria-hidden="true">
                ✓
              </i>
            </div>
            {bundled.map(renderToggle)}
            {offers.map(renderToggle)}
          </div>
        </div>
      </details>
    </div>
  );
}
