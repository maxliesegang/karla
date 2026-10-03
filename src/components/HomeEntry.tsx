import type { NearbyStopsController } from "../hooks/nearby-stops";
import type { RecentStop } from "../lib/recent-stops";
import { routePaths } from "../routing";
import { HomeMenu } from "./HomeMenu";
import { NearbyStopButton } from "./NearbyStopButton";
import { StopSearch } from "./StopSearch";

/** Starting stops for a first visit, authored so they show on the first paint. */
const SUGGESTED_STOPS = [
  { stopId: "marktplatz", name: "Marktplatz" },
  { stopId: "europaplatz", name: "Europaplatz" },
  { stopId: "hauptbahnhof", name: "Hauptbahnhof" },
] as const;

/**
 * The home: ways to reach a stop (search, recent or suggested stops, locate), then links to the
 * pages, each with a line saying what it is. Links rather than buttons, since every view is a hash
 * address.
 */
export function HomeEntry({
  searchInputRef,
  recentStops,
  nearbyStopsController,
  onShowNearbyStops,
}: {
  searchInputRef?: React.Ref<HTMLInputElement>;
  recentStops: readonly RecentStop[];
  nearbyStopsController: NearbyStopsController;
  onShowNearbyStops: () => void;
}) {
  return (
    <div className="home-entry">
      <div className="home-entry-find">
        <StopSearch inputRef={searchInputRef} recentStops={recentStops} />
        <NearbyStopButton
          variant="page"
          controller={nearbyStopsController}
          onShowAlternatives={onShowNearbyStops}
        />
      </div>
      <HomeStops stops={recentStops} />
      <HomeMenu />
    </div>
  );
}

/**
 * The rider's recent stops, or on a first visit the suggestions, under a visible label saying
 * which.
 */
function HomeStops({ stops }: { stops: readonly RecentStop[] }) {
  const remembered = stops
    .filter((visit) => visit.stopName)
    .map((visit) => ({ stopId: visit.stopId, name: visit.stopName as string }));
  const isRemembered = remembered.length > 0;
  const shown = isRemembered ? remembered : SUGGESTED_STOPS;

  return (
    <nav className="recent-stops" aria-labelledby="recent-stops-heading">
      <h2 id="recent-stops-heading" className="eyebrow">
        {isRemembered ? "Zuletzt besucht" : "Zum Beispiel"}
      </h2>
      {/* One row that scrolls sideways; the cut-off chip invites the swipe. */}
      <ul>
        {shown.map((stop) => (
          <li key={stop.stopId}>
            <a href={`#${routePaths.stop(stop.stopId)}`}>
              <span>{stop.name}</span>
              <b aria-hidden="true">›</b>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
