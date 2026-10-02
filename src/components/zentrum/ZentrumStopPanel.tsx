import type { CSSProperties } from "react";
import { createLineSign } from "../../data/line-signs";
import type { DepartureBoard } from "../../data/transit-types";
import {
  type CountdownReading,
  formatClockTime,
  getCountdownReading,
  getDepartureAccessibilityLabel,
  getDepartureStatusLabel,
  getDepartureTimeReading,
  getStaleBoardLabel,
} from "../../lib/departure-presentation";
import {
  type ZentrumStopBoardRow,
  type ZentrumTravelTime,
  getMinutesUntilArrival,
} from "../../lib/zentrum-schematic-overlays";
import { getDepartureOpenPath, navigateTo, routePaths } from "../../routing";
import { DepartureCountdown } from "../DepartureCountdown";
import { DepartureTime } from "../DepartureTime";
import { LineBadge } from "../LineBadge";
import { SegmentedControl } from "../SegmentedControl";
import type { ZentrumLineSignReader } from "./line-sign";

/** The two questions an opened stop answers on the plan. */
export type ZentrumStopReading = "departures" | "travelTimes";

const STOP_READINGS = [
  { value: "travelTimes", label: "Fahrzeiten" },
  { value: "departures", label: "Abfahrten" },
] as const;

/** Minutes as the board's countdown column prints them, so a minute reads the same everywhere. */
export const toCountdownReading = (minutes: number): CountdownReading =>
  minutes <= 0
    ? { kind: "due", label: "jetzt" }
    : { kind: "minutes", minutes, label: `${minutes} min` };

/** One stop the travel-time reading reaches, by the tram that gets there first. */
export type ZentrumReachedStop = ZentrumTravelTime & { nodeId: string; label: string };

/**
 * The stop a rider opened on the plan: the plan's answer, said in the board's own words.
 *
 * It is the panel beside the plan, where the departure board stands beside a line's diagram, and it
 * is written the way the board is -- the stop's name, the readings as a segmented control, and
 * rows with the board's badge, time and countdown. The departures are the stop's whole board, not
 * only the trams the plan is drawing: a tram already on the plan is marked, and its row finds it
 * there; any other row opens its trip, as it would on the board. The plan carries where; this
 * carries when.
 */
export function ZentrumStopPanel({
  stopId,
  label,
  reading,
  onChangeReading,
  rows,
  board,
  reachedStops,
  selectedVehicleId,
  onSelectVehicle,
  getSign,
  feedNow,
  onClose,
}: {
  stopId: string;
  label: string;
  reading: ZentrumStopReading;
  onChangeReading: (reading: ZentrumStopReading) => void;
  /** The stop's board read against the plan, or nothing while it has not answered. */
  rows?: readonly ZentrumStopBoardRow[];
  board: DepartureBoard | null;
  reachedStops: readonly ZentrumReachedStop[];
  selectedVehicleId?: string;
  onSelectVehicle: (vehicleId: string) => void;
  getSign: ZentrumLineSignReader;
  feedNow: number;
  onClose: () => void;
}) {
  const staleLabel = reading === "departures" ? getStaleBoardLabel(board, feedNow) : undefined;
  return (
    <aside className="zentrum-sheet" aria-label={`Haltestelle ${label}`}>
      <div className="zentrum-sheet-heading">
        <h2>{label}</h2>
        <button
          type="button"
          className="zentrum-sheet-close"
          aria-label={`${label} schließen`}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <SegmentedControl
        className="departure-board-order-control zentrum-sheet-readings"
        value={reading}
        items={STOP_READINGS}
        onValueChange={onChangeReading}
        ariaLabel={`Was der Plan ab ${label} zeigt`}
      />
      <p className="zentrum-sheet-note">
        {reading === "departures"
          ? (staleLabel ?? (
              <>
                <span className="zentrum-sheet-on-plan" aria-hidden="true" /> = schon im Plan
              </>
            ))
          : "Direkt ab hier, ohne Umsteigen."}
      </p>
      <div
        className="zentrum-sheet-list"
        style={{ "--row-inset": "0px" } as CSSProperties}
        aria-live="polite"
      >
        {reading === "departures" ? (
          rows === undefined ? (
            <p className="panel-empty">Abfahrten werden geladen …</p>
          ) : rows.length === 0 ? (
            <p className="panel-empty">Gerade keine Abfahrten.</p>
          ) : (
            rows.map(({ departure, vehicleId }, index) => {
              const timeReading = getDepartureTimeReading(departure);
              const isSelected = vehicleId !== undefined && selectedVehicleId === vehicleId;
              return (
                <button
                  key={departure.id}
                  type="button"
                  className={`departure${isSelected ? " selected" : ""}${
                    departure.status === "cancelled" ? " cancelled" : ""
                  }`}
                  style={{ "--departure-index": index } as CSSProperties}
                  aria-pressed={vehicleId === undefined ? undefined : isSelected}
                  aria-label={`${getDepartureAccessibilityLabel(departure, feedNow)}, ${
                    vehicleId === undefined ? "Fahrtverlauf öffnen" : "im Plan zeigen"
                  }`}
                  onClick={() =>
                    vehicleId === undefined
                      ? navigateTo(getDepartureOpenPath(departure, stopId, false, undefined))
                      : onSelectVehicle(vehicleId)
                  }
                >
                  <LineBadge
                    line={
                      departure.transportMode === "tram" || departure.transportMode === "lightRail"
                        ? getSign(departure.lineId)
                        : createLineSign(departure.lineId, departure.transportMode)
                    }
                  />
                  <span className="departure-countdown">
                    <DepartureCountdown reading={getCountdownReading(departure, feedNow)} />
                  </span>
                  <span className="departure-destination">
                    {vehicleId !== undefined && (
                      <span className="zentrum-sheet-on-plan" title="Schon im Plan" />
                    )}
                    {departure.destination}
                  </span>
                  <span className="departure-meta">
                    {timeReading && <DepartureTime reading={timeReading} />}
                    {departure.status !== "cancelled" && getDepartureStatusLabel(departure)}
                  </span>
                </button>
              );
            })
          )
        ) : reachedStops.length === 0 ? (
          <p className="panel-empty">Gerade keine direkte Fahrt ab hier bekannt.</p>
        ) : (
          <ol className="zentrum-sheet-reached">
            {reachedStops.map((reached) => (
              <li key={reached.nodeId}>
                <LineBadge line={getSign(reached.lineId)} size="sm" />
                <span className="zentrum-sheet-reached-name">
                  {reached.label}
                  <small>an {formatClockTime(new Date(reached.arrivesAt))}</small>
                </span>
                <span className="departure-countdown">
                  <DepartureCountdown
                    reading={toCountdownReading(getMinutesUntilArrival(reached.arrivesAt, feedNow))}
                  />
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
      <a
        className="zentrum-sheet-link"
        href={`#${routePaths.stop(stopId)}`}
        aria-label={`Haltestellenseite ${label} öffnen`}
      >
        Zur Haltestelle
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="m7.5 4.5 5 5.5-5 5.5" />
        </svg>
      </a>
    </aside>
  );
}
