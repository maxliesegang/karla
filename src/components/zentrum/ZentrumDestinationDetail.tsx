import { useState } from "react";
import type { DepartureBoard } from "../../data/transit-types";
import { getStaleBoardLabel } from "../../lib/departure-presentation";
import type { ZentrumTravelTime } from "../../lib/zentrum-schematic-overlays";
import { getZentrumRidePresentation } from "../../lib/zentrum-presentation";
import { isSameRun } from "../../lib/trips";
import { getDepartureAddressId, routePaths } from "../../routing";
import { LineBadge } from "../LineBadge";
import type { ZentrumLineSignReader } from "./line-sign";
import type { ZentrumReachableStop } from "../../lib/zentrum-stop-view";

/** Compare direct rides and open the chosen run with its boarding and alighting stops. */
export function ZentrumDestinationDetail({
  originStopId,
  originStopLabel,
  reachableStop,
  rides,
  board,
  feedNow,
  getSign,
  onClose,
  onSelectStop,
}: {
  originStopId: string;
  originStopLabel: string;
  reachableStop: ZentrumReachableStop;
  rides: readonly ZentrumTravelTime[];
  board: DepartureBoard | null;
  feedNow: number;
  getSign: ZentrumLineSignReader;
  onClose: () => void;
  onSelectStop: (stopId: string) => void;
}) {
  const [chosenDeparture, setChosenDeparture] = useState(reachableStop.departure);
  const selectedRide =
    rides.find((ride) => isSameRun(ride.departure, chosenDeparture)) ?? reachableStop;
  const selected = getZentrumRidePresentation(selectedRide, board, feedNow);
  const staleBoardLabel = getStaleBoardLabel(board, feedNow);
  return (
    <aside
      className="zentrum-panel"
      data-entrance-motion="rise"
      aria-label={`Direkt nach ${reachableStop.label}`}
    >
      <div className="zentrum-panel-heading">
        <LineBadge line={getSign(selectedRide.lineId)} size="sm" />
        <h2>{reachableStop.label}</h2>
        <button
          type="button"
          className="zentrum-panel-close"
          aria-label={`Zurück zu ${originStopLabel}`}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <p className="zentrum-panel-note">Ab {originStopLabel} · ohne Umsteigen</p>
      <div className="zentrum-panel-list">
        <div className="zentrum-destination-summary" aria-live="polite">
          <strong>
            {selected.rideMinutes}
            <small> min Fahrt</small>
          </strong>
          <span>
            {selected.waitLabel}
            <small>Ankunft {selected.arrivalTime}</small>
          </span>
        </div>
        <p className="zentrum-destination-direction">Richtung {selected.direction}</p>
        <ol className="zentrum-panel-calls zentrum-destination-calls">
          <li>
            <span>
              {originStopLabel}
              <small>{selected.platformLabel}</small>
            </span>
            <b>{selected.departureTime}</b>
          </li>
          <li>
            <span>{reachableStop.label}</span>
            <b>{selected.arrivalTime}</b>
          </li>
        </ol>
        <p className="zentrum-panel-note">{selected.sourceLabel}</p>
        {selected.serviceNote && <p className="zentrum-boarding-note">{selected.serviceNote}</p>}
        {rides.length > 1 && (
          <>
            <h3 className="zentrum-destination-rides-heading">Fahrten vergleichen</h3>
            <ol
              className="zentrum-destination-rides"
              aria-label={`Fahrten nach ${reachableStop.label}`}
            >
              {rides.map((ride) => {
                const reading = getZentrumRidePresentation(ride, board, feedNow);
                const isSelected = isSameRun(ride.departure, selectedRide.departure);
                return (
                  <li key={getDepartureAddressId(ride.departure)}>
                    <button
                      type="button"
                      className="zentrum-destination-ride"
                      aria-pressed={isSelected}
                      aria-label={`Linie ${ride.lineId}, ${reading.waitLabel}, Abfahrt ${reading.departureTime}, Ankunft ${reading.arrivalTime}, ${reading.rideMinutes} min Fahrt, ${reading.platformLabel}, ${reading.sourceLabel}`}
                      onClick={() => setChosenDeparture(ride.departure)}
                    >
                      <LineBadge line={getSign(ride.lineId)} size="sm" />
                      <span className="zentrum-destination-ride-info">
                        <strong>{reading.waitLabel}</strong>
                        <small>
                          {reading.departureTime} → {reading.arrivalTime} · {reading.rideMinutes}{" "}
                          min Fahrt
                        </small>
                        <small>
                          {reading.platformLabel} · Richtung {reading.direction}
                        </small>
                        <small>{reading.sourceLabel}</small>
                        {reading.serviceNote && (
                          <small className="zentrum-boarding-note">{reading.serviceNote}</small>
                        )}
                      </span>
                      <span className="zentrum-destination-ride-check" aria-hidden="true">
                        {isSelected ? "✓" : ""}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </>
        )}
        {staleBoardLabel && (
          <p className="zentrum-panel-note" role="status">
            {staleBoardLabel}
          </p>
        )}
      </div>
      <a
        className="zentrum-panel-link"
        href={`#${routePaths.ride(getDepartureAddressId(selectedRide.departure), originStopId, reachableStop.nodeId)}`}
      >
        Mit Linie {selectedRide.lineId} um {selected.departureTime} fahren →
      </a>
      <button
        className="zentrum-destination-action"
        type="button"
        onClick={() => onSelectStop(reachableStop.nodeId)}
      >
        Ziele ab {reachableStop.label}
      </button>
    </aside>
  );
}
