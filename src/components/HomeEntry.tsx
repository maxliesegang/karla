import type { NearbyStopsController } from "../hooks";
import type { RecentStop } from "../lib/recent-stops";
import { routePaths } from "../routing";
import { HomeMenu } from "./HomeMenu";
import { NearbyStopButton } from "./NearbyStopButton";
import { StopSearch } from "./StopSearch";

/**
 * Where a rider who has read nothing yet can start.
 *
 * The first visit is the one the home has least to say to — nothing is remembered, and a bare field
 * asks a question the rider may not be able to answer in the app's own words. Three stops the city
 * itself starts at cost one row and turn an empty page into a usable one. Authored ids, not live
 * data: the offer must stand on the first paint, before any board has answered.
 */
const SUGGESTED_STOPS = [
  { stopId: "marktplatz", name: "Marktplatz" },
  { stopId: "europaplatz", name: "Europaplatz" },
  { stopId: "hauptbahnhof", name: "Hauptbahnhof" },
] as const;

/**
 * The home: the two ways to reach a stop, then the pages.
 *
 * The rider's question is *which stop?*, asked three ways — named, already read, or the one they
 * are standing at — so the three stand together at the top: the field, the stops beside and under
 * it, and the locate control that on this page is a first-class action rather than a corner of the
 * bar. It is the likeliest answer a first visitor has, and a control that *asks* for a location is
 * a fair thing to show before the permission has been answered; the page still says everything it
 * says without one.
 *
 * Under that, the pages of KARLA, each with the one line that says what it is — a word like
 * *Meldungen* names a page only to someone who has already opened it. They are links, not buttons: every view
 * here is a hash address, so a link is what lets a rider open one in a tab, and what a screen
 * reader announces correctly.
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
 * The stops one tap away: the ones this rider has been reading, or — the first time, when there are
 * none — the three the city starts at.
 *
 * The label is drawn rather than hidden. Beside a search field a row of stop names could be
 * suggestions, favourites, or stops nearby, and which of the three it is decides whether a rider
 * trusts it; one small word answers that for the cost of a line.
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
        {isRemembered ? "Zuletzt besucht" : "Zum Anfangen"}
      </h2>
      {/* One row at every width, riding off the edge where four names overflow it: a second band
          would cost the pages below a row each, and the hidden bar costs nothing because the cut
          chip at the edge is the invitation to swipe. */}
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
