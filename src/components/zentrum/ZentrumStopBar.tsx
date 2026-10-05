import { SegmentedControl } from "../SegmentedControl";
import type { ZentrumStopReading } from "../../lib/zentrum-stop-view";

const STOP_READINGS = [
  { value: "destinations", label: "Ziele" },
  { value: "departures", label: "Abfahrten" },
] as const;

/** The id of the opened stop's panel, which the bar's toggle controls. */
export const ZENTRUM_STOP_PANEL_ID = "zentrum-stop-panel";

/** The opened stop's name, reading and panel controls beneath the plan. */
export function ZentrumStopBar({
  label,
  reading,
  onChangeReading,
  isPanelOpen,
  onTogglePanel,
  onClose,
}: {
  label: string;
  reading: ZentrumStopReading;
  onChangeReading: (reading: ZentrumStopReading) => void;
  isPanelOpen: boolean;
  onTogglePanel: () => void;
  onClose: () => void;
}) {
  return (
    <div className="zentrum-stop-bar" role="group" aria-label={`Haltestelle ${label}`}>
      {/* Keyed, so another stop's name fades in where the last one stood. */}
      <h2 key={label}>{label}</h2>
      <SegmentedControl
        className="departure-board-order-control zentrum-stop-readings"
        value={reading}
        items={STOP_READINGS}
        onValueChange={onChangeReading}
        ariaLabel={`Was der Plan ab ${label} zeigt`}
      />
      <button
        type="button"
        className="zentrum-panel-close zentrum-stop-panel-toggle"
        aria-expanded={isPanelOpen}
        aria-controls={isPanelOpen ? ZENTRUM_STOP_PANEL_ID : undefined}
        aria-label={isPanelOpen ? `Liste ${label} einklappen` : `Liste ${label} aufklappen`}
        title={isPanelOpen ? "Einklappen" : "Aufklappen"}
        onClick={onTogglePanel}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="m5.5 12.5 4.5-5 4.5 5" />
        </svg>
      </button>
      <button
        type="button"
        className="zentrum-panel-close"
        aria-label={`${label} schließen`}
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
}
