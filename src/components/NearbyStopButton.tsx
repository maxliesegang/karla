import { useCallback, useEffect, useRef, useState } from "react";
import { IS_GEOLOCATION_SUPPORTED } from "../hooks/geolocation";
import type { NearbyStopsController } from "../hooks/nearby-stops";
import { navigateTo, routePaths } from "../routing";

/** The stop a location press opened, shared by the home's action and the bar's chip. */
export type LocatedStop = { stopId?: string; open: (stopId: string) => void };

/**
 * Remembers the stop a location press opened, whichever button pressed, so the bar offers another
 * nearby stop there. Leaving that page forgets it.
 */
export function useLocatedStop(currentPageStopId: string | undefined): LocatedStop {
  const hasReachedLocatedStopRef = useRef(false);
  const [stopId, setStopId] = useState<string>();

  useEffect(() => {
    if (!stopId) return;
    if (currentPageStopId === stopId) {
      hasReachedLocatedStopRef.current = true;
      return;
    }
    if (hasReachedLocatedStopRef.current) {
      hasReachedLocatedStopRef.current = false;
      setStopId(undefined);
    }
  }, [currentPageStopId, stopId]);

  const open = useCallback((nextStopId: string) => {
    hasReachedLocatedStopRef.current = false;
    setStopId(nextStopId);
    navigateTo(routePaths.stop(nextStopId));
  }, []);

  return { stopId, open };
}

/** Locates on request, then opens the closest useful stop. As a bar chip or a full home action. */
export function NearbyStopButton({
  controller,
  locatedStop,
  currentPageStopId,
  onShowAlternatives,
  variant = "bar",
}: {
  controller: NearbyStopsController;
  locatedStop: LocatedStop;
  /** Set only on a plain stop page, not on a line or ride nested beneath it. */
  currentPageStopId?: string;
  onShowAlternatives: () => void;
  /** The bar or the home page. */
  variant?: "bar" | "page";
}) {
  const isRequestedRef = useRef(false);
  const nearestStop = controller.stops[0]?.stop;
  const canCorrectLocation = Boolean(
    locatedStop.stopId && currentPageStopId === locatedStop.stopId,
  );
  const openLocatedStop = locatedStop.open;

  useEffect(() => {
    if (isRequestedRef.current && controller.status === "ready" && nearestStop) {
      isRequestedRef.current = false;
      openLocatedStop(nearestStop.id);
    } else if (
      isRequestedRef.current &&
      controller.status !== "idle" &&
      controller.status !== "locating"
    ) {
      // A press that found no stop says why on the nearby page, which offers another try.
      isRequestedRef.current = false;
      onShowAlternatives();
    }
  }, [controller.status, nearestStop, onShowAlternatives, openLocatedStop]);

  const label = canCorrectLocation
    ? "Andere Haltestelle in der Nähe wählen"
    : controller.status === "locating"
      ? "Standort wird bestimmt"
      : controller.status === "ready" && controller.stops.length === 0
        ? "Keine Haltestelle in der Nähe"
        : controller.status === "denied" || controller.status === "unavailable"
          ? controller.message
          : "Nächste Haltestelle";

  const isPageAction = variant === "page";

  return (
    <button
      type="button"
      className={isPageAction ? "home-nearby-action" : "header-action nearby-stop-button"}
      aria-label={label}
      title={label}
      // A fix that failed or was too coarse may come next time; a refusal or no support will not.
      disabled={controller.status === "denied" || !IS_GEOLOCATION_SUPPORTED}
      onClick={() => {
        if (canCorrectLocation) {
          onShowAlternatives();
          return;
        }
        // A press during a reading already under way is answered by that reading.
        if (isRequestedRef.current || controller.status === "locating") {
          isRequestedRef.current = true;
          return;
        }
        isRequestedRef.current = true;
        void controller.locate();
      }}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="3.25" />
        <path d="M10 2.25v2M10 15.75v2M2.25 10h2M15.75 10h2" />
      </svg>
      {/* The bar shows a word; the page the full question. */}
      <span>
        {isPageAction
          ? canCorrectLocation
            ? "Andere Haltestelle"
            : controller.status === "locating"
              ? "Standort wird bestimmt …"
              : "Haltestelle in der Nähe"
          : canCorrectLocation
            ? "Andere"
            : "Nähe"}
      </span>
    </button>
  );
}
