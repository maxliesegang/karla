import { useCurrentTime, type NearbyStopsController } from "../hooks";
import { formatClockTime } from "../lib/departure-presentation";
import { navigateTo, routePaths } from "../routing";
import { NearbyStopButton } from "./NearbyStopButton";

/** Own component so the minute tick repaints the time alone, not the panels below it. */
function Clock() {
  return <time>{formatClockTime(useCurrentTime())}</time>;
}

/**
 * The bar carries one question at a time and no more.
 *
 * What is left is the shell itself — where the rider is in the chain, and the two things true of
 * every view: the clock the board is read against, and the one control that answers a question the
 * bar is the right place for, "the stop I am standing at". Everything else moved to where its
 * answer is: the search to the top of the home, where choosing a stop is the whole point of the
 * view, and the operator's notices under the board they concern (F6, F7).
 *
 * A control in the bar is on every screen at every width, which is what makes it expensive: the
 * waiting glance is the surface this app exists for, and chrome above it is paid for by the rider
 * every time they check when their tram leaves.
 */
export function AppHeader({
  backPath,
  nearbyStopsController,
  currentPageStopId,
  onShowNearbyStops,
  isStationBoardMode = false,
}: {
  /** One level up the nested stop selection chain. */
  backPath?: string;
  nearbyStopsController: NearbyStopsController;
  currentPageStopId?: string;
  onShowNearbyStops: () => void;
  isStationBoardMode?: boolean;
}) {
  return (
    <header className="app-header">
      <div className="app-header-brand">
        {isStationBoardMode ? (
          <span className="brand">
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
        {/* Stepping up the chain is what Escape does and what this does; the browser's own back
            button goes back through history, which is a different journey. */}
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

      {!isStationBoardMode && (
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
