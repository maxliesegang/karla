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
import { isRailDeparture } from "../../lib/zentrum-schematic-plan";
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

/** Minutes as the board's countdown prints them. */
export const toCountdownReading = (minutes: number): CountdownReading =>
  minutes <= 0
    ? { kind: "due", label: "jetzt" }
    : { kind: "minutes", minutes, label: `${minutes} min` };

/** One stop the travel-time reading reaches, by the tram that gets there first. */
export type ZentrumReachedStop = ZentrumTravelTime & { nodeId: string; label: string };

/**
 * An opened stop's panel, written like the departure board. Departures are the stop's whole
 * board: a row whose tram is on the plan selects it, any other opens its trip. The plan says
 * where; this says when.
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
  /** The stop's board read against the plan, or undefined until it answers. */
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
                      isRailDeparture(departure)
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
