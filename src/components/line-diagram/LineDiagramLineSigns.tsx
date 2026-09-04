import type { CSSProperties } from "react";
import type { TransitLine } from "../../data/transit-types";
import { classNames } from "../../lib/class-names";

/** The signs of every line in the reading, with the primary kept visually dominant. */
export function LineDiagramLineSigns({
  lines,
  onClearTrip,
  clearTripLabel,
}: {
  lines: readonly TransitLine[];
  onClearTrip?: () => void;
  clearTripLabel?: string;
}) {
  const signs = lines.map((line, index) => (
    <span
      key={line.id}
      className={classNames("line-diagram-sign", index > 0 && "additional")}
      style={
        {
          "--line-sign-color": line.color,
          "--line-sign-text": line.textColor,
        } as CSSProperties
      }
      aria-hidden="true"
    >
      {line.id}
    </span>
  ));
  const linesLabel = `Linien ${lines.map(({ id }) => id).join(", ")}`;

  return onClearTrip ? (
    <button
      type="button"
      className="line-diagram-signs interactive"
      onClick={onClearTrip}
      aria-label={clearTripLabel ?? linesLabel}
    >
      {signs}
    </button>
  ) : (
    <span className="line-diagram-signs" role="group" aria-label={linesLabel}>
      {signs}
    </span>
  );
}
