import { Fragment, useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import { transitSource } from "../data/transit-source";
import type { StopPlace } from "../data/transit-types";
import type { RecentStop } from "../lib/recent-stops";
import type { SavedStop } from "../lib/saved-stops";
import { navigateTo, routePaths } from "../routing";
import { FEED_UNREADABLE_TEXT } from "./feed-copy";
import { getStopPlaceSubtitle } from "../lib/stop-naming";

/**
 * Stop search by name (`/` focuses it). Authored stops match locally at once; the provider is asked
 * after typing settles. An empty field lists the rider's saved, then recent stops.
 */
const SEARCH_DEBOUNCE_MS = 220;

/** Which remembered list a row belongs to, named as its group label. */
type SearchOptionGroup = "Gemerkt" | "Zuletzt besucht";

/** A list row, found or remembered. */
type SearchOption = { stopId: string; name: string; detail?: string; group?: SearchOptionGroup };

/**
 * The last settled search with its query, as one state so a stale answer never shows as current.
 */
type SettledSearch = {
  query: string;
  results: readonly StopPlace[];
  /** The provider could not be read, as opposed to answering with nothing. */
  failed: boolean;
};

const NO_RESULTS: readonly StopPlace[] = [];

export function StopSearch({
  inputRef,
  recentStops = [],
  savedStops = [],
  focusOnMount = false,
  onRequestClose,
}: {
  inputRef?: React.Ref<HTMLInputElement>;
  /** Recent stops, offered while nothing is typed. */
  recentStops?: readonly RecentStop[];
  /** Saved stops, offered before the recent ones. */
  savedStops?: readonly SavedStop[];
  focusOnMount?: boolean;
  onRequestClose?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [settledSearch, setSettledSearch] = useState<SettledSearch | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchElementRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  useImperativeHandle(inputRef, () => searchElementRef.current as HTMLInputElement);

  useEffect(() => {
    if (focusOnMount) searchElementRef.current?.focus();
  }, [focusOnMount]);

  // A short query just shows nothing; no state to store.
  const isQueryLongEnough = query.trim().length >= 2;

  useEffect(() => {
    if (!isQueryLongEnough) return;
    let active = true;
    const timer = window.setTimeout(() => {
      transitSource.searchStops(query).then(
        (found) => {
          if (!active) return;
          setActiveIndex(0);
          setSettledSearch({ query, results: found, failed: false });
        },
        () => {
          if (!active) return;
          setSettledSearch({ query, results: NO_RESULTS, failed: true });
        },
      );
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [query, isQueryLongEnough]);

  // Close the list on outside clicks.
  useEffect(() => {
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, []);

  // One list, so the keyboard reaches saved, recent and found stops alike.
  const settledResults = settledSearch?.results ?? NO_RESULTS;
  const visibleResults: readonly SearchOption[] = isQueryLongEnough
    ? settledResults.map((stop) => ({
        stopId: stop.id,
        name: stop.name,
        detail: getStopPlaceSubtitle(stop),
      }))
    : [
        ...savedStops.map(
          (stop): SearchOption => ({
            stopId: stop.stopId,
            name: stop.stopName,
            group: "Gemerkt",
          }),
        ),
        ...recentStops
          .filter((visit) => !savedStops.some((stop) => stop.stopId === visit.stopId))
          .map(
            (visit): SearchOption => ({
              stopId: visit.stopId,
              name: visit.stopName ?? visit.stopId,
              group: "Zuletzt besucht",
            }),
          ),
      ];
  // When there are no rows: still searching, no results, or the provider failed.
  const hasSettledForQuery = settledSearch?.query === query;
  const isSearching = isQueryLongEnough && !hasSettledForQuery;
  const isSearchFeedbackVisible =
    isOpen &&
    isQueryLongEnough &&
    visibleResults.length === 0 &&
    (isSearching || (hasSettledForQuery && settledResults.length === 0));
  const isListVisible = isOpen && (visibleResults.length > 0 || isSearchFeedbackVisible);
  const hasRememberedStops = !isQueryLongEnough && visibleResults.length > 0;
  const activeOptionIndex = Math.min(activeIndex, Math.max(visibleResults.length - 1, 0));

  const open = (option: SearchOption) => {
    setIsOpen(false);
    setQuery("");
    onRequestClose?.();
    navigateTo(routePaths.stop(option.stopId));
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setIsOpen(false);
      event.currentTarget.blur();
      onRequestClose?.();
      return;
    }
    if (visibleResults.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) => (current + step + visibleResults.length) % visibleResults.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      open(visibleResults[Math.min(activeIndex, visibleResults.length - 1)]);
    }
  };

  return (
    <div className="stop-search" ref={containerRef}>
      <input
        ref={searchElementRef}
        type="search"
        value={query}
        placeholder="Haltestelle suchen"
        aria-label="Haltestelle suchen"
        role="combobox"
        aria-expanded={isListVisible}
        aria-controls={listId}
        aria-activedescendant={isListVisible ? `${listId}-option-${activeOptionIndex}` : undefined}
        aria-autocomplete="list"
        autoComplete="off"
        onChange={(event) => {
          setQuery(event.target.value);
          setIsOpen(true);
        }}
        onFocus={() => setIsOpen(true)}
        onKeyDown={onKeyDown}
      />
      {isListVisible && (
        <ul
          className="stop-search-results"
          id={listId}
          role="listbox"
          aria-label={hasRememberedStops ? "Gemerkt und zuletzt besucht" : "Suchergebnisse"}
        >
          {visibleResults.map((option, index) => (
            <Fragment key={option.stopId}>
              {option.group && option.group !== visibleResults[index - 1]?.group && (
                <li className="stop-search-group" role="presentation">
                  {option.group}
                </li>
              )}
              <li
                id={`${listId}-option-${index}`}
                role="option"
                aria-selected={index === activeOptionIndex}
                className={index === activeOptionIndex ? "active" : ""}
                onMouseEnter={() => setActiveIndex(index)}
                onPointerDown={(event) => {
                  event.preventDefault();
                  open(option);
                }}
              >
                <strong>{option.name}</strong>
                {option.detail && <small>{option.detail}</small>}
              </li>
            </Fragment>
          ))}
          {visibleResults.length === 0 && isSearchFeedbackVisible && (
            <li className="stop-search-note" role="presentation">
              {isSearching ? (
                "Es wird gesucht …"
              ) : settledSearch?.failed ? (
                <>
                  <strong>Suche nicht erreichbar</strong>
                  <small>{FEED_UNREADABLE_TEXT}</small>
                </>
              ) : (
                <>
                  <strong>Keine Treffer</strong>
                  <small>Nichts gefunden zu „{query.trim()}“</small>
                </>
              )}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
