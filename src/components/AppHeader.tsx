import { useCurrentTime } from "../hooks/clock";
import type { NearbyStopsController } from "../hooks/nearby-stops";
import { formatClockTime } from "../lib/departure-presentation";
import { navigateTo, routePaths } from "../routing";
import { NearbyStopButton } from "./NearbyStopButton";

/** Its own component, so the minute tick repaints only the time. */
function Clock() {
  return <time>{formatClockTime(useCurrentTime())}</time>;
}

/**
 * The bar: where the rider is in the chain, the clock, and the locate control. Everything else
 * lives where its answer is, since chrome here costs every glance.
 */
export function AppHeader({
  backPath,
  nearbyStopsController,
  currentPageStopId,
  onShowNearbyStops,
  isStationBoardMode = false,
  showsNearbyStopButton = true,
}: {
  /** One level up the selection chain. */
  backPath?: string;
  nearbyStopsController: NearbyStopsController;
  currentPageStopId?: string;
  onShowNearbyStops: () => void;
  isStationBoardMode?: boolean;
  /** Off where the page offers the same action itself. */
  showsNearbyStopButton?: boolean;
}) {
  return (
    <header className="app-header">
      <div className="app-header-brand">
        {isStationBoardMode ? (
          <span className="brand" aria-label="KARLA">
            <span className="brand-mark">KARLA</span>
          </span>
        ) : (
          <button
            type="button"
            className="brand"
            onClick={() => navigateTo(routePaths.home())}
            aria-label="Zur KARLA-Startseite"
          >
            <span className="brand-mark">KARLA</span>
          </button>
        )}
        {/* Steps up the chain, like Escape; browser back walks history instead. */}
        {backPath && (
          <button
            type="button"
            className="header-action step-up"
            onClick={() => navigateTo(backPath)}
            aria-label="Eine Ebene zurück"
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="m12.5 4.5-5 5.5 5 5.5" />
            </svg>
          </button>
        )}
      </div>

      {!isStationBoardMode && showsNearbyStopButton && (
        <nav className="app-header-quick-actions" aria-label="Schnellzugriff">
          <NearbyStopButton
            controller={nearbyStopsController}
            currentPageStopId={currentPageStopId}
            onShowAlternatives={onShowNearbyStops}
          />
        </nav>
      )}

      <div className="app-header-status">
        <Clock />
      </div>
    </header>
  );
}
