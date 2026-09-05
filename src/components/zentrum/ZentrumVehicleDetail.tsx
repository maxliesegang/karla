import type { ZentrumSchematicVehicle } from "../../lib/zentrum-schematic";
import { LineBadge } from "../LineBadge";
import type { ZentrumLineSignReader } from "./line-sign";

/**
 * The vehicle a reader opened: which line it is, where it is going, and what its mark is worth.
 *
 * It stands over the plan rather than under it, so opening a mark does not push the controls below
 * the fold — and it says in words what the drawing can only imply, that the position is read from
 * published stop times rather than fixed by the vehicle itself.
 */
export function ZentrumVehicleDetail({
  vehicle,
  getSign,
  onClose,
}: {
  vehicle: ZentrumSchematicVehicle;
  getSign: ZentrumLineSignReader;
  onClose: () => void;
}) {
  return (
    <aside id="zentrum-vehicle-detail" className="zentrum-vehicle-detail" aria-live="polite">
      <LineBadge line={getSign(vehicle.lineId)} size="sm" />
      <div>
        <span>Richtung</span>
        <strong>{vehicle.destination}</strong>
        <p>
          Zwischen {vehicle.from.label} und {vehicle.to.label}. Aus den veröffentlichten
          Haltestellenzeiten geschätzt; keine GPS-Position.
        </p>
      </div>
      <button
        type="button"
        className="zentrum-vehicle-detail-close"
        aria-label="Fahrzeugdetails schließen"
        onClick={onClose}
      >
        ×
      </button>
    </aside>
  );
}
