import { useEffect, useRef, useState } from "react";
import type { NearbyStopsController } from "../hooks";
import { navigateTo, routePaths } from "../routing";

/** Locates only on request, then opens the closest useful stop. */
export function NearbyStopButton({
  controller,
  currentPageStopId,
  onShowAlternatives,
}: {
  controller: NearbyStopsController;
  /** Set only on a plain stop page, not on a line or ride nested beneath it. */
  currentPageStopId?: string;
  onShowAlternatives: () => void;
}) {
  const isRequestedRef = useRef(false);
  const hasReachedLocatedStopRef = useRef(false);
  const [locatedStopId, setLocatedStopId] = useState<string>();
  const nearestStop = controller.stops[0]?.stop;
  const canCorrectLocation = Boolean(locatedStopId && currentPageStopId === locatedStopId);

  useEffect(() => {
    if (isRequestedRef.current && controller.status === "ready" && nearestStop) {
      isRequestedRef.current = false;
      setLocatedStopId(nearestStop.id);
      navigateTo(routePaths.stop(nearestStop.id));
    }
  }, [controller.status, nearestStop]);

  // The correction belongs to the one page opened by the location action. Once the rider leaves
  // it, returning through history is a new navigation and the bar offers location again.
  useEffect(() => {
    if (!locatedStopId) return;
    if (currentPageStopId === locatedStopId) {
      hasReachedLocatedStopRef.current = true;
      return;
    }
    if (hasReachedLocatedStopRef.current) {
      hasReachedLocatedStopRef.current = false;
      setLocatedStopId(undefined);
    }
  }, [currentPageStopId, locatedStopId]);

  const label = canCorrectLocation
    ? "Andere Haltestelle in der Nähe wählen"
    : controller.status === "locating"
      ? "Standort wird bestimmt"
      : controller.status === "ready" && controller.stops.length === 0
        ? "Keine Haltestelle in der Nähe"
        : controller.status === "denied" || controller.status === "unavailable"
          ? controller.message
          : "Nächste Haltestelle";

  return (
    <button
      type="button"
      className="header-action nearby-stop-button"
      aria-label={label}
      title={label}
      disabled={
        controller.status === "locating" ||
        controller.status === "denied" ||
        controller.status === "unavailable"
      }
      onClick={() => {
        if (canCorrectLocation) {
          onShowAlternatives();
          return;
        }
        isRequestedRef.current = true;
        controller.locate();
      }}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="3.25" />
        <path d="M10 2.25v2M10 15.75v2M2.25 10h2M15.75 10h2" />
      </svg>
      <span>{canCorrectLocation ? "Andere" : "Nähe"}</span>
    </button>
  );
}
