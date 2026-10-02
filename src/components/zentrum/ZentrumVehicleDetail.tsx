import { getTripCallTimeReading } from "../../lib/departure-presentation";
import type { ZentrumSchematicVehicle } from "../../lib/zentrum-schematic";
import { zentrumSchematicNodeById } from "../../lib/zentrum-schematic-plan";
import { getDepartureAddressId, routePaths } from "../../routing";
import { DepartureTime } from "../DepartureTime";
import { LineBadge } from "../LineBadge";
import type { ZentrumLineSignReader } from "./line-sign";

/**
 * An opened vehicle: line, destination and its remaining Zentrum stops with board times. It says
 * in words what the drawing only implies, that the position is an estimate, and links the trip.
 */
export function ZentrumVehicleDetail({
  vehicle,
  getSign,
  feedNow,
  returnLabel,
  onClose,
}: {
  vehicle: ZentrumSchematicVehicle;
  getSign: ZentrumLineSignReader;
  feedNow: number;
  /** The stop that closing this returns to, if it was opened from one. */
  returnLabel?: string;
  onClose: () => void;
}) {
  const isHolding = vehicle.from.id === vehicle.to.id || vehicle.progress === 0;
  // A vehicle that has started moving has left the stop its link starts at.
  const aheadStops = vehicle.aheadStops.slice(isHolding ? 0 : 1);
  return (
    <aside id="zentrum-vehicle-detail" className="zentrum-sheet" aria-live="polite">
      <div className="zentrum-sheet-heading">
        <LineBadge line={getSign(vehicle.lineId)} size="sm" />
        <h2>{vehicle.destination}</h2>
        <button
          type="button"
          className="zentrum-sheet-close"
          aria-label={returnLabel ? `Zurück zu ${returnLabel}` : "Bahn schließen"}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <p className="zentrum-sheet-note">
        {isHolding
          ? `Hält an ${vehicle.from.label}`
          : `Zwischen ${vehicle.from.label} und ${vehicle.to.label}`}
        {" · "}
        <span title="Aus den Zeiten an den Haltestellen geschätzt, kein GPS">
          Position geschätzt
        </span>
      </p>
      {aheadStops.length > 0 && (
        <ol className="zentrum-sheet-calls" aria-label="Nächste Halte im Zentrum">
          {aheadStops.map((stop) => {
            const reading = getTripCallTimeReading(stop.call, feedNow);
            return (
              <li key={`${stop.nodeId}:${stop.departsAt ?? ""}`}>
                <span>
                  {zentrumSchematicNodeById.get(stop.nodeId)?.label ?? stop.call.stopName}
                </span>
                {reading && <DepartureTime reading={reading} />}
              </li>
            );
          })}
        </ol>
      )}
      <a
        className="zentrum-sheet-link"
        href={`#${routePaths.trip(
          getDepartureAddressId(vehicle.departure),
          vehicle.lineId,
          vehicle.to.id,
        )}`}
      >
        Ganze Fahrt
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="m7.5 4.5 5 5.5-5 5.5" />
        </svg>
      </a>
    </aside>
  );
}
