import type { CSSProperties } from "react";
import { createLineSign } from "../../data/line-signs";
import type { DepartureBoard } from "../../data/transit-types";
import {
  type CountdownReading,
  getCountdownReading,
  getDepartureAccessibilityLabel,
  getDepartureStatusLabel,
  getDepartureTimeReading,
  getStaleBoardLabel,
} from "../../lib/departure-presentation";
import {
  type ZentrumStopBoardRow,
  type ZentrumTravelMeasure,
} from "../../lib/zentrum-schematic-overlays";
import { formatPlatformLabel } from "../../lib/platform-naming";
import type { ZentrumReachableStop, ZentrumStopReading } from "../../lib/zentrum-stop-view";
import { getZentrumTravelSourceLabel } from "../../lib/zentrum-presentation";
import { isRailDeparture } from "../../lib/zentrum-schematic-plan";
import { getDepartureOpenPath, navigateTo, routePaths } from "../../routing";
import { DepartureCountdown } from "../DepartureCountdown";
import { DepartureTime } from "../DepartureTime";
import { LineBadge } from "../LineBadge";
import type { ZentrumPanelEntranceMotion } from "../../lib/zentrum-panel";
import { ZENTRUM_STOP_PANEL_ID } from "./ZentrumStopBar";
import type { ZentrumLineSignReader } from "./line-sign";

/** Minutes as the board's countdown prints them. */
const toCountdownReading = (minutes: number): CountdownReading =>
  minutes <= 0
    ? { kind: "due", label: "jetzt" }
    : { kind: "minutes", minutes, label: `${minutes} min` };

/** When a ride leaves, as its row prints it under the ride time. */
export const formatWait = (minutes: number): string =>
  minutes <= 0 ? "jetzt" : `in ${minutes} min`;

/**
 * An opened stop's panel, written like the departure board; its name and reading stand on the
 * bar. Departures are the stop's whole board: a row whose tram is on the plan selects it, any
 * other opens its trip. The plan says where; this says when.
 */
export function ZentrumStopPanel({
  stopId,
  label,
  reading,
  rows,
  board,
  reachableStops,
  travelMeasure,
  selectedVehicleId,
  onSelectVehicle,
  onSelectDestination,
  getSign,
  feedNow,
  entranceMotion,
}: {
  stopId: string;
  label: string;
  reading: ZentrumStopReading;
  /** The stop's board read against the plan, or undefined until it answers. */
  rows?: readonly ZentrumStopBoardRow[];
  board: DepartureBoard | null;
  reachableStops: readonly ZentrumReachableStop[];
  travelMeasure: ZentrumTravelMeasure;
  selectedVehicleId?: string;
  onSelectVehicle: (vehicleId: string) => void;
  onSelectDestination: (nodeId: string) => void;
  getSign: ZentrumLineSignReader;
  feedNow: number;
  entranceMotion: ZentrumPanelEntranceMotion;
}) {
  const staleLabel = reading === "departures" ? getStaleBoardLabel(board, feedNow) : undefined;
  return (
    <aside
      id={ZENTRUM_STOP_PANEL_ID}
      className="zentrum-panel"
      data-entrance-motion={entranceMotion}
      aria-label={`Haltestelle ${label}`}
    >
      <p className="zentrum-panel-note">
        {reading === "departures"
          ? (staleLabel ?? (
              <>
                <span className="zentrum-panel-on-plan" aria-hidden="true" /> = schon im Plan
              </>
            ))
          : travelMeasure === "ride"
            ? "Fahrzeit in der Bahn, direkt ab hier, ohne Umsteigen."
            : travelMeasure === "split"
              ? "Fahrzeit, darunter bis zur Abfahrt. Direkt, ohne Umsteigen."
              : "Direkt ab hier, ohne Umsteigen."}
      </p>
      <div
        className="zentrum-panel-list"
        style={{ "--row-inset": "0px" } as CSSProperties}
        aria-live="polite"
      >
        {reading === "departures" ? (
          board?.dataStatus === "unavailable" ? (
            <p className="panel-empty">{board.errorMessage}</p>
          ) : rows === undefined ? (
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
                      <span className="zentrum-panel-on-plan" title="Schon im Plan" />
                    )}
                    {departure.destination}
                  </span>
                  <span className="departure-meta">
                    {timeReading && <DepartureTime reading={timeReading} />}
                    {departure.status !== "cancelled" && getDepartureStatusLabel(departure)}
                    <span className="zentrum-departure-boarding">
                      {formatPlatformLabel(
                        departure.platformCode,
                        departure.platformKind,
                        "unbekannt",
                      )}
                    </span>
                  </span>
                  {departure.serviceNote && (
                    <small className="zentrum-departure-note">{departure.serviceNote}</small>
                  )}
                </button>
              );
            })
          )
        ) : reachableStops.length === 0 ? (
          <p className="panel-empty">Gerade keine direkte Fahrt ab hier bekannt.</p>
        ) : (
          <ol key={stopId} className="zentrum-panel-destinations">
            {reachableStops.map((reachable) => (
              <li key={reachable.nodeId}>
                <button
                  type="button"
                  className="zentrum-destination-row"
                  onClick={() => onSelectDestination(reachable.nodeId)}
                  aria-label={`${reachable.label}, Linie ${reachable.lineId}, ${
                    reachable.waitMinutes === undefined
                      ? `${reachable.minutes} Minuten`
                      : `${reachable.minutes} Minuten Fahrt, ab in ${reachable.waitMinutes} Minuten`
                  }, ${getZentrumTravelSourceLabel(reachable)}. Passende Abfahrt anzeigen`}
                >
                  <LineBadge line={getSign(reachable.lineId)} size="sm" />
                  <span className="zentrum-panel-destinations-name">{reachable.label}</span>
                  <span className="departure-countdown zentrum-destination-time">
                    {travelMeasure !== "arrival" ? (
                      <DepartureCountdown
                        reading={{
                          kind: "minutes",
                          minutes: reachable.minutes,
                          label: `${reachable.minutes} min`,
                        }}
                      />
                    ) : (
                      <DepartureCountdown reading={toCountdownReading(reachable.minutes)} />
                    )}
                    {reachable.waitMinutes !== undefined && (
                      <small className="zentrum-destination-wait">
                        {formatWait(reachable.waitMinutes)}
                      </small>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
      <a
        className="zentrum-panel-link"
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
