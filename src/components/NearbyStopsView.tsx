import { useRef } from "react";
import type { NearbyStopsController } from "../hooks/nearby-stops";
import { usePullToRefresh } from "../hooks/pull-to-refresh";
import { navigateTo, routePaths } from "../routing";
import { formatDistance } from "../lib/geo";
import { NEARBY_REFRESH_LABEL, PullToRefreshStrip } from "./PullToRefreshStrip";

export function NearbyStopsView({
  controller,
  isStacked = false,
}: {
  controller: NearbyStopsController;
  /** Stacked, the page owns the pull. */
  isStacked?: boolean;
}) {
  const listRef = useRef<HTMLElement>(null);
  const pullStripRef = useRef<HTMLDivElement>(null);
  // Only a list can be pulled; it locates again.
  const hasList = controller.stops.length > 0;
  usePullToRefresh({
    listRef,
    indicatorRef: pullStripRef,
    onRefresh: controller.locate,
    isEnabled: !isStacked && hasList,
  });
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

      {(controller.status === "idle" || controller.status === "locating") && !hasList ? (
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
        <nav ref={listRef} className="nearby-stops" aria-label="Nächste Haltestellen">
          {/* Inside the list, so a closed strip adds no gap to the view. */}
          {!isStacked && (
            <PullToRefreshStrip stripRef={pullStripRef} busyLabel={NEARBY_REFRESH_LABEL} />
          )}
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
