import type { CSSProperties } from "react";
import {
  type CountdownReading,
  formatClockTime,
  getTripCallTimeReading,
} from "../../lib/departure-presentation";
import {
  type ZentrumStopDeparture,
  type ZentrumTravelTime,
  getMinutesUntilArrival,
  getMinutesUntilDeparture,
} from "../../lib/zentrum-schematic-overlays";
import { routePaths } from "../../routing";
import { DepartureCountdown } from "../DepartureCountdown";
import { DepartureTime } from "../DepartureTime";
import { LineBadge } from "../LineBadge";
import { SegmentedControl } from "../SegmentedControl";
import type { ZentrumLineSignReader } from "./line-sign";

/** The two questions an opened stop answers on the plan. */
export type ZentrumStopReading = "departures" | "travelTimes";

const STOP_READINGS = [
  { value: "departures", label: "Abfahrten" },
  { value: "travelTimes", label: "Fahrzeit" },
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
 * rows with the board's badge, time and countdown -- so a tram here reads exactly as it does on the
 * board one tap away. The plan carries where; this carries when.
 */
export function ZentrumStopPanel({
  stopId,
  label,
  reading,
  onChangeReading,
  departures,
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
  departures: readonly ZentrumStopDeparture[];
  reachedStops: readonly ZentrumReachedStop[];
  selectedVehicleId?: string;
  onSelectVehicle: (vehicleId: string) => void;
  getSign: ZentrumLineSignReader;
  feedNow: number;
  onClose: () => void;
}) {
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
          ? "Die nächsten Bahnen auf dem Plan, die hier abfahren."
          : "Ankunft ohne Umsteigen, mit der nächsten Bahn ab hier."}
      </p>
      <div
        className="zentrum-sheet-list"
        style={{ "--row-inset": "0px" } as CSSProperties}
        aria-live="polite"
      >
        {reading === "departures" ? (
          departures.length === 0 ? (
            <p className="panel-empty">Gerade ist keine Bahn auf dem Plan hierher unterwegs.</p>
          ) : (
            departures.map((departure, index) => {
              const timeReading = getTripCallTimeReading(departure.call, feedNow);
              const { vehicle } = departure;
              const isSelected = selectedVehicleId === vehicle.id;
              return (
                <button
                  key={vehicle.id}
                  type="button"
                  className={`departure${isSelected ? " selected" : ""}`}
                  style={{ "--departure-index": index } as CSSProperties}
                  aria-pressed={isSelected}
                  onClick={() => onSelectVehicle(vehicle.id)}
                >
                  <LineBadge line={getSign(vehicle.lineId)} />
                  <span className="departure-countdown">
                    <DepartureCountdown
                      reading={toCountdownReading(
                        getMinutesUntilDeparture(departure.departsAt, feedNow),
                      )}
                    />
                  </span>
                  <span className="departure-destination">{vehicle.destination}</span>
                  <span className="departure-meta">
                    {timeReading && <DepartureTime reading={timeReading} />}
                    {departure.isAtStop && <span>steht hier</span>}
                  </span>
                </button>
              );
            })
          )
        ) : reachedStops.length === 0 ? (
          <p className="panel-empty">Gerade ist keine direkte Fahrt ab hier bekannt.</p>
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
      <a className="zentrum-sheet-link" href={`#${routePaths.stop(stopId)}`}>
        Alle Abfahrten an {label}
      </a>
    </aside>
  );
}
