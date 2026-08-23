import type { RecentStop } from "../lib/recent-stops";
import { navigateTo, routePaths, type HomeView } from "../routing";
import { HomeTabs } from "./HomeTabs";
import { StopSearch } from "./StopSearch";

/**
 * The top of the home, in the order the questions are asked.
 *
 * *Which stop?* first, because naming a stop is the only thing the home is for; the stops already
 * read next, because for a returning rider they are the answer and cost no typing; the two
 * reference roots last. The search stood in the bar before, where it was chrome on every screen
 * including the waiting glance, and on a phone a second control that opened a modal over the board.
 * Here it is the view, one tap behind the brand (F6).
 *
 * The remembered stops are shown rather than only offered inside the field, because the landing now
 * opens on one of them (A1): a rider who was carried to the wrong end of their journey needs the
 * other end visible, not one focus and one keystroke away.
 */
export function HomeEntry({
  activeView,
  searchInputRef,
  recentStops,
}: {
  activeView: HomeView;
  searchInputRef?: React.Ref<HTMLInputElement>;
  recentStops: readonly RecentStop[];
}) {
  return (
    <div className="home-entry">
      <StopSearch inputRef={searchInputRef} recentStops={recentStops} />
      <RecentStops stops={recentStops} />
      <HomeTabs activeView={activeView} />
    </div>
  );
}

/** Silent until there is something to remember: a heading over an empty list answers nothing. */
function RecentStops({ stops }: { stops: readonly RecentStop[] }) {
  const named = stops.filter((visit) => visit.stopName);
  if (named.length === 0) return null;

  return (
    <nav className="recent-stops" aria-labelledby="recent-stops-heading">
      <h2 id="recent-stops-heading">Zuletzt gelesen</h2>
      <ul>
        {named.map((visit) => (
          <li key={visit.stopId}>
            <button type="button" onClick={() => navigateTo(routePaths.stop(visit.stopId))}>
              <span>{visit.stopName}</span>
              <b aria-hidden="true">›</b>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
