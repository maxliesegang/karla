import { useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import { transitSource } from "../data/transit-source";
import type { TransitStop } from "../data/transit-types";
import type { RecentStop } from "../lib/recent-stops";
import { navigateTo, routePaths } from "../routing";

/**
 * Jumping straight to a stop by name.
 *
 * The app could already resolve any stop in the KVV network by name — the provider search has been
 * behind `TransitSource` the whole time — but there was no way for a reader to ask. On a wide
 * screen that is the missing pointer affordance and the missing keyboard one at once: `/` puts the
 * caret here, typing narrows, Enter opens the board.
 *
 * Authored stops answer instantly and locally; the provider is asked only after the typing settles,
 * so a name typed at speed costs one request rather than one per keystroke.
 *
 * An empty field is not an empty list. A rider uses the same two or three stops every day, and the
 * moment they open the search is exactly the moment those are the answer — so the stops they have
 * been reading stand in the list until they type something that narrows it. It costs no chrome
 * anywhere else in the app: the shortcut lives inside the affordance that already exists for
 * finding a stop, on the phone sheet and behind `/` alike.
 */
const SEARCH_DEBOUNCE_MS = 220;

/** A row of the list, whether it was found by typing or remembered from a previous reading. */
type SearchOption = { stopId: string; name: string; detail?: string; isRecent?: boolean };

/**
 * What the last settled search produced, kept with the query it settled for.
 *
 * One state rather than three: the results, whether the read failed, and the query they belong to
 * always change together, so typing on can never show a stale answer as the current one.
 */
type SettledSearch = {
  query: string;
  results: readonly TransitStop[];
  /** The provider could not be read at all — distinct from a search that answered with nothing. */
  failed: boolean;
};

const NO_RESULTS: readonly TransitStop[] = [];

export function StopSearch({
  inputRef,
  recentStops = [],
  focusOnMount = false,
  onRequestClose,
}: {
  inputRef?: React.Ref<HTMLInputElement>;
  /** The stops the rider has been reading, offered while there is nothing typed to narrow by. */
  recentStops?: readonly RecentStop[];
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

  // Too short a query is not a state to store, it is simply nothing to show — clearing the results
  // in the effect would be a render caused by a value already known while rendering.
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

  // A results list that outlives the click that dismissed it is the classic combobox annoyance.
  useEffect(() => {
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, []);

  // One list either way, so a keyboard reaches the remembered stops exactly as it reaches found
  // ones — same arrows, same Enter, same option row.
  const settledResults = settledSearch?.results ?? NO_RESULTS;
  const visibleResults: readonly SearchOption[] = isQueryLongEnough
    ? settledResults.map((stop) => ({ stopId: stop.id, name: stop.name, detail: stop.alias }))
    : recentStops.map((visit) => ({
        stopId: visit.stopId,
        name: visit.stopName ?? visit.stopId,
        isRecent: true,
      }));
  // What the list says when it is not results: that the search is still working on the query, that
  // it answered with nothing, or that it could not read the provider at all. A failed read and an
  // empty answer both leave the list without rows; the wording below tells the two apart.
  const hasSettledForQuery = settledSearch?.query === query;
  const isSearching = isQueryLongEnough && !hasSettledForQuery;
  const isSearchFeedbackVisible =
    isOpen &&
    isQueryLongEnough &&
    visibleResults.length === 0 &&
    (isSearching || (hasSettledForQuery && settledResults.length === 0));
  const isListVisible = isOpen && (visibleResults.length > 0 || isSearchFeedbackVisible);
  const hasRecentStops = !isQueryLongEnough && visibleResults.length > 0;
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
          aria-label={hasRecentStops ? "Zuletzt gelesen" : "Suchergebnisse"}
        >
          {hasRecentStops && (
            <li className="stop-search-group" role="presentation">
              Zuletzt gelesen
            </li>
          )}
          {visibleResults.map((option, index) => (
            <li
              key={option.stopId}
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
          ))}
          {visibleResults.length === 0 && isSearchFeedbackVisible && (
            <li className="stop-search-note" role="presentation">
              {isSearching ? (
                "Es wird gesucht …"
              ) : settledSearch?.failed ? (
                <>
                  <strong>Suche nicht erreichbar</strong>
                  <small>Der KVV-Feed konnte nicht gelesen werden.</small>
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
