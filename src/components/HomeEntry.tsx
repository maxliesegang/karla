import { useLayoutEffect, useRef } from "react";
import type { NearbyStopsController } from "../hooks/nearby-stops";
import { useStoredPreference } from "../hooks/stored-preference";
import type { RecentStop } from "../lib/recent-stops";
import { savedStops as savedStopsPreference, type SavedStop } from "../lib/saved-stops";
import { network } from "../networks/network";
import { routePaths } from "../routing";
import { HomeMenu } from "./HomeMenu";
import { type LocatedStop, NearbyStopButton } from "./NearbyStopButton";
import { StopSearch } from "./StopSearch";

/** Starting stops for a first visit, from the network's own places so they show on the first paint. */
const SUGGESTED_STOPS = network.suggestedStopIds.map((stopId) => ({
  stopId,
  name: network.stopPlaces[stopId].name,
}));

/**
 * The home: ways to reach a stop (search, saved, recent or suggested stops, locate), then links to the
 * pages, each with a line saying what it is. Links rather than buttons, since every view is a hash
 * address.
 */
export function HomeEntry({
  searchInputRef,
  recentStops,
  nearbyStopsController,
  locatedStop,
  onShowNearbyStops,
}: {
  searchInputRef?: React.Ref<HTMLInputElement>;
  recentStops: readonly RecentStop[];
  nearbyStopsController: NearbyStopsController;
  locatedStop: LocatedStop;
  onShowNearbyStops: () => void;
}) {
  const savedStops = useStoredPreference(savedStopsPreference);
  return (
    <div className="home-entry">
      <div className="home-entry-find">
        <StopSearch inputRef={searchInputRef} recentStops={recentStops} savedStops={savedStops} />
        <NearbyStopButton
          variant="page"
          controller={nearbyStopsController}
          locatedStop={locatedStop}
          onShowAlternatives={onShowNearbyStops}
        />
      </div>
      <SavedHomeStops stops={savedStops} />
      <HomeStops stops={recentStops} savedStops={savedStops} />
      <HomeMenu />
    </div>
  );
}

/**
 * The stops the rider saved, all of them: a list they chose wraps rather than drops any. A quiet
 * link beside the label opens them for reordering and removal.
 */
function SavedHomeStops({ stops }: { stops: readonly SavedStop[] }) {
  if (stops.length === 0) return null;
  return (
    <nav className="recent-stops saved-stops" aria-labelledby="saved-stops-heading">
      <div className="saved-stops-heading">
        <h2 id="saved-stops-heading" className="eyebrow">
          Gemerkt
        </h2>
        <a
          href={`#${routePaths.saved()}`}
          className="saved-stops-edit"
          aria-label="Gemerkte Haltestellen bearbeiten"
        >
          Bearbeiten
        </a>
      </div>
      <StopChips stops={stops.map((stop) => ({ stopId: stop.stopId, name: stop.stopName }))} />
    </nav>
  );
}

/**
 * The rider's recent stops, or on a first visit the suggestions, under a visible label saying
 * which. Saved stops are not repeated, and with any saved there are no suggestions.
 */
function HomeStops({
  stops,
  savedStops,
}: {
  stops: readonly RecentStop[];
  savedStops: readonly SavedStop[];
}) {
  const remembered = stops
    .filter((visit) => visit.stopName && !savedStops.some((s) => s.stopId === visit.stopId))
    .map((visit) => ({ stopId: visit.stopId, name: visit.stopName as string }));
  const isRemembered = remembered.length > 0;
  const shown = isRemembered ? remembered : SUGGESTED_STOPS;
  const listRef = useFirstLineOnly<HTMLUListElement>(
    shown.map((stop) => `${stop.stopId}:${stop.name}`).join("|"),
  );
  if (!isRemembered && savedStops.length > 0) return null;

  return (
    <nav className="recent-stops" aria-labelledby="recent-stops-heading">
      <h2 id="recent-stops-heading" className="eyebrow">
        {isRemembered ? "Zuletzt besucht" : "Zum Beispiel"}
      </h2>
      {/* One row: the stops that fit whole, newest first. */}
      <StopChips stops={shown} listRef={listRef} />
    </nav>
  );
}

function StopChips({
  stops,
  listRef,
}: {
  stops: readonly { stopId: string; name: string }[];
  listRef?: React.Ref<HTMLUListElement>;
}) {
  return (
    <ul ref={listRef}>
      {stops.map((stop) => (
        <li key={stop.stopId}>
          <a href={`#${routePaths.stop(stop.stopId)}`} title={stop.name}>
            <span>{stop.name}</span>
            <b aria-hidden="true">›</b>
          </a>
        </li>
      ))}
    </ul>
  );
}

/**
 * Hides the list's items that wrapped past its first line, again on every resize, so a row shows
 * only whole chips. `hidden` rather than clipping takes the dropped ones out of the tab order and
 * the accessibility tree too.
 */
function useFirstLineOnly<T extends HTMLElement>(itemsKey: string) {
  const ref = useRef<T>(null);

  useLayoutEffect(() => {
    const list = ref.current;
    if (!list) return;
    const fit = () => {
      const children = [...list.children] as HTMLElement[];
      for (const child of children) child.hidden = false;
      const firstTop = children[0]?.offsetTop;
      for (const child of children) child.hidden = child.offsetTop > firstTop;
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(list);
    return () => observer.disconnect();
  }, [itemsKey]);

  return ref;
}
