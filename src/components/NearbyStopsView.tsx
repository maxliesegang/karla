import type { NearbyStopsController } from "../hooks";
import { navigateTo, routePaths } from "../routing";
import { formatDistance } from "../lib/geo";

export function NearbyStopsView({ controller }: { controller: NearbyStopsController }) {
  const message =
    controller.status === "denied" || controller.status === "unavailable"
      ? controller.message
      : controller.status === "ready" && controller.stops.length === 0
        ? "Keine Haltestelle in der Nähe gefunden."
        : undefined;

  return (
    <section className="nearby-stops-view" aria-labelledby="nearby-stops-heading">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Standort</p>
          <h1 id="nearby-stops-heading">Haltestellen in der Nähe</h1>
        </div>
      </div>

      {controller.status === "idle" || controller.status === "locating" ? (
        <button
          type="button"
          className="nearby-locate-action"
          disabled={controller.status === "locating"}
          onClick={controller.locate}
        >
          {controller.status === "locating" ? "Standort wird bestimmt …" : "Standort bestimmen"}
        </button>
      ) : message ? (
        <p className="nearby-stops-message">{message}</p>
      ) : (
        <nav className="nearby-stops" aria-label="Nächste Haltestellen">
          <ul>
            {controller.stops.map(({ stop, distanceMeters }) => (
              <li key={stop.id}>
                <button type="button" onClick={() => navigateTo(routePaths.stop(stop.id))}>
                  <strong>{stop.name}</strong>
                  <small>ca. {formatDistance(distanceMeters)} Luftlinie</small>
                  <b aria-hidden="true">›</b>
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </section>
  );
}
