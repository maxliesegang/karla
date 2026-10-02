import { getTripCallTimeReading } from "../../lib/departure-presentation";
import type { ZentrumSchematicVehicle } from "../../lib/zentrum-schematic";
import { zentrumSchematicNodeById } from "../../lib/zentrum-schematic-plan";
import { getDepartureAddressId, routePaths } from "../../routing";
import { DepartureTime } from "../DepartureTime";
import { LineBadge } from "../LineBadge";
import type { ZentrumLineSignReader } from "./line-sign";

/**
 * The vehicle a reader opened: which line it is, where it is going, and where it calls next.
 *
 * It takes the plan's panel the way an opened stop does, and is written the way the board writes a
 * trip: the line's badge and destination, and the stops it still calls at in the Zentrum with the
 * board's own times. It says in words what the drawing can only imply -- that the position is read
 * from published stop times rather than fixed by the vehicle itself -- and opens the whole trip.
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
  /** The stop closing this returns to, where it was opened from one. */
  returnLabel?: string;
  onClose: () => void;
}) {
  const isHolding = vehicle.from.id === vehicle.to.id || vehicle.progress === 0;
  // The stop the link leaves is behind a vehicle that has started moving.
  const aheadStops = vehicle.aheadStops.slice(isHolding ? 0 : 1);
  return (
    <aside id="zentrum-vehicle-detail" className="zentrum-sheet" aria-live="polite">
      <div className="zentrum-sheet-heading">
        <LineBadge line={getSign(vehicle.lineId)} size="sm" />
        <h2>{vehicle.destination}</h2>
        <button
          type="button"
          className="zentrum-sheet-close"
          aria-label={returnLabel ? `Zurück zu ${returnLabel}` : "Fahrzeugdetails schließen"}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <p className="zentrum-sheet-note">
        {isHolding
          ? `Hält an ${vehicle.from.label}.`
          : `Zwischen ${vehicle.from.label} und ${vehicle.to.label}.`}{" "}
        Aus den veröffentlichten Haltestellenzeiten geschätzt; keine GPS-Position.
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
        Ganzen Fahrtverlauf öffnen
      </a>
    </aside>
  );
}
