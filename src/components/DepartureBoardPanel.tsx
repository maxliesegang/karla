import { useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode, Ref } from "react";
import { getLineSign } from "../data/line-signs";
import type {
  Departure,
  DepartureBoard,
  TransitLine,
  TransitStop,
  TransitNetwork,
} from "../data/transit-types";
import {
  getStaleBoardLabel,
  getVehicleAccessLabel,
  getCountdownReading,
  getDepartureAccessibilityLabel,
  getDepartureStatusLabel,
  getDepartureTimeReading,
  isDeparturePinned,
  isDepartureSelected,
} from "../lib/departure-presentation";
import {
  formatPlatformLabel,
  formatSpokenPlatformHeading,
  getPlatformHeadingParts,
} from "../lib/platform-naming";
import { getDepartureOpenPath, navigateTo } from "../routing";
import type { LineSelection } from "../lib/line-bundles";
import { DepartureCountdown } from "./DepartureCountdown";
import { DepartureTime } from "./DepartureTime";
import { LineBadge } from "./LineBadge";
import { DepartureBoardStatusChip } from "./DepartureBoardStatusChip";
import { SegmentedControl, type SegmentedControlItem } from "./SegmentedControl";
import { classNames } from "../lib/class-names";
import { findNextCompatibleDeparture } from "../lib/stop-services";
import {
  groupDeparturesByBoardingPlace,
  type DepartureBoardingPlaceGroup,
  type DeparturePlatformGroup,
} from "../lib/departure-order";
import {
  getBoardingPlaceLabel,
  type BoardingPlace,
  type StopBoardingPlaces,
} from "../lib/boarding-places";
import { useStoredPreference } from "../hooks/stored-preference";
import { appSettings } from "../lib/app-settings";
import { useBoardingPlaceSections } from "../hooks/boarding-place-sections";
import { departureBoardOrder, type DepartureBoardOrder } from "../lib/departure-board-order";
import { usePullToRefresh } from "../hooks/pull-to-refresh";
import { useTransientScrollbar } from "../hooks/scrollbar";
import {
  findJoinedRunPortionPair,
  getJoinedRunPortionPairs,
  type JoinedRunPortionPair,
} from "../lib/joined-run-portions";
import type { StopCorridorPatterns } from "../lib/stop-corridor-patterns";
import { getStopServiceCorridorLineGroups } from "../lib/stop-corridors";
import { DepartureBoardLineOrder } from "./DepartureBoardLineOrder";
import { isSameRun } from "../lib/trips";

type DepartureBoardPanelProps = {
  panelRef?: Ref<HTMLElement>;
  stop: TransitStop;
  departures: readonly Departure[];
  /** Completed selected-line trips; absent on a basic stop board by design. */
  completedLineDepartures?: readonly Departure[];
  departureBoard: DepartureBoard | null;
  network: TransitNetwork;
  /** The feed's clock, which every countdown counts from. */
  feedNow: number;
  /**
   * The bundled lines; their trips read as selected, and a row tapped in the bundle stays in it.
   */
  lineSelection?: LineSelection;
  /** The pinned trip, selected on every row of that vehicle. */
  selectedDeparture?: Departure;
  /** What this stop's trips were observed to do; without it the line order groups by headsign. */
  corridorPatterns: StopCorridorPatterns;
  /** The stop's places, learned over the visit so they do not flicker with the rows. */
  boardingPlaces: StopBoardingPlaces;
  /** A stacked layout caps the list; a panel of its own shows and scrolls the whole board. */
  isStacked?: boolean;
  /** How many readings have answered, failures included; the pull to refresh settles on this. */
  boardReadingCount?: number;
  /** Reads the board again (pull down past the first row); the board stays while reading. */
  onRefresh?: () => void;
  /** The stop's menu, at the board's foot, since both its parts are about the board. */
  bottomMenu?: ReactNode;
};

function DepartureRow({
  departure,
  nextCompatibleDeparture,
  line,
  stopId,
  lineSelection,
  index,
  isSelected,
  isPinned,
  feedNow,
  showsPlatform,
  joinedPortionPair,
}: {
  departure: Departure;
  /** The next trip on the same route, shown only when this one is cancelled. */
  nextCompatibleDeparture?: Departure;
  line: TransitLine;
  stopId: string;
  /** The lines read together, so a row tapped in a bundle stays in it. */
  lineSelection: LineSelection | undefined;
  /** Print the platform only where no heading above states it. */
  showsPlatform: boolean;
  /** A high-confidence shared consist inferred from two complete route readings. */
  joinedPortionPair?: JoinedRunPortionPair;
  /** The row's position, for the top-down entrance. */
  index: number;
  /** The pinned trip, or any trip of the line when none is pinned. */
  isSelected: boolean;
  /**
   * This row is the addressed trip (either row of a vehicle at a multi-place stop), so tapping
   * steps up.
   */
  isPinned: boolean;
  feedNow: number;
}) {
  // A row tap gives the same address at every width; the diagram it opens can start the ride.
  const timeReading = getDepartureTimeReading(departure);
  const vehicleAccessLabel = getVehicleAccessLabel(departure);
  const nextCompatibleReading = nextCompatibleDeparture
    ? getCountdownReading(nextCompatibleDeparture, feedNow)
    : undefined;
  const nextCompatibleLabel =
    nextCompatibleReading?.kind === "minutes"
      ? `${nextCompatibleReading.minutes} min`
      : nextCompatibleReading?.label;
  const isTerminatingPortion =
    joinedPortionPair && isSameRun(departure, joinedPortionPair.terminating);
  const joinedLabel = joinedPortionPair
    ? isTerminatingPortion
      ? `Gemeinsam bis ${joinedPortionPair.terminating.destination} · weiterer Zugteil nach ${joinedPortionPair.continuing.destination}`
      : `Gemeinsam bis ${joinedPortionPair.terminating.destination}`
    : undefined;

  return (
    <button
      className={classNames(
        "departure",
        isSelected && "selected",
        isPinned && "pinned",
        departure.status === "cancelled" && "cancelled",
        departure.status === "diverted" && "diverted",
        joinedPortionPair && "joined-run-portion",
      )}
      style={{ "--departure-index": index } as CSSProperties}
      aria-current={isSelected ? "true" : undefined}
      onClick={() => navigateTo(getDepartureOpenPath(departure, stopId, isPinned, lineSelection))}
      aria-label={`${getDepartureAccessibilityLabel(departure, feedNow)}${
        joinedLabel ? `, ${joinedLabel}` : ""
      }${
        departure.status === "cancelled" && nextCompatibleLabel
          ? `, nächste passende Fahrt ${nextCompatibleLabel}`
          : ""
      }, ${isPinned ? "Auswahl aufheben" : "Fahrtverlauf öffnen"}`}
    >
      <LineBadge line={line} />
      <span className="departure-countdown">
        <DepartureCountdown reading={getCountdownReading(departure, feedNow)} />
      </span>
      <span className="departure-destination">
        {departure.destination}
        {departure.serviceNote && <em>{departure.serviceNote}</em>}
      </span>
      <span className="departure-meta">
        {joinedLabel && <strong className="departure-joined-service">{joinedLabel}</strong>}
        {departure.status === "cancelled" && nextCompatibleLabel && (
          <strong className="departure-next-service">
            Nächste passende Fahrt {nextCompatibleLabel}
          </strong>
        )}
        {timeReading && <DepartureTime reading={timeReading} />}
        {/* Only what the countdown and time do not already say. */}
        {departure.status !== "cancelled" && getDepartureStatusLabel(departure)}
        {/* Only for a vehicle that is not step-free, in words; the norm is spoken. */}
        {departure.status !== "cancelled" && vehicleAccessLabel && (
          <span className="departure-access">{vehicleAccessLabel}</span>
        )}
        {showsPlatform && (
          <b>{formatPlatformLabel(departure.platformCode, departure.platformKind)}</b>
        )}
      </span>
    </button>
  );
}

/**
 * The board's three orders, all of the same departures: `Zeit` (what leaves next), `Steig` (by
 * platform; the root of Bahnsteig and Bussteig) and `Linie` (where each line goes and when).
 */
const departureOrderItems: readonly SegmentedControlItem<DepartureBoardOrder>[] = [
  { value: "time", label: "Zeit", ariaLabel: "Abfahrten nach Abfahrtszeit ordnen" },
  { value: "platform", label: "Steig", ariaLabel: "Abfahrten nach Steig gruppieren" },
  { value: "line", label: "Linie", ariaLabel: "Abfahrten nach Linie und Richtung gruppieren" },
];

function DepartureOrderControl({
  order,
  onOrderChange,
}: {
  order: DepartureBoardOrder;
  onOrderChange: (order: DepartureBoardOrder) => void;
}) {
  return (
    <SegmentedControl
      className="departure-board-order-control"
      value={order}
      items={departureOrderItems}
      ariaLabel="Abfahrten ordnen"
      onValueChange={onOrderChange}
    />
  );
}

/** A boarding place's section, only at stops with more than one place. */
function BoardingPlaceGroup({
  group,
  getSectionRef,
  renderRow,
}: {
  group: DepartureBoardingPlaceGroup;
  /** Registers the section under its place id, for the place bar. */
  getSectionRef: (placeId: string) => (section: HTMLElement | null) => void;
  renderRow: (departure: Departure, index: number) => ReactNode;
}) {
  const platformGroups = group.platformGroups.map((platformGroup) => (
    <PlatformGroup key={platformGroup.platformCode} group={platformGroup} renderRow={renderRow} />
  ));
  if (!group.boardingPlace) return <>{platformGroups}</>;
  const boardingPlace = group.boardingPlace;
  const label = getBoardingPlaceLabel(boardingPlace);
  return (
    <section
      ref={getSectionRef(boardingPlace.id)}
      className="departure-board-boarding-place"
      aria-label={label}
    >
      <h2>{label}</h2>
      {platformGroups}
    </section>
  );
}

/**
 * The places as navigation, not a filter: a button scrolls to its place's section, and the place
 * whose heading is stuck at the top is marked. Platform order only, and only places with
 * departures.
 */
function BoardingPlaceBar({
  places,
  activePlaceId,
  onJump,
}: {
  places: readonly BoardingPlace[];
  activePlaceId: string | undefined;
  onJump: (placeId: string) => void;
}) {
  return (
    <div className="departure-board-place-bar" role="group" aria-label="Zu einem Bereich springen">
      {places.map((place) => {
        const label = getBoardingPlaceLabel(place);
        const isActive = place.id === activePlaceId;
        return (
          <button
            key={place.id}
            type="button"
            className={isActive ? "selected" : undefined}
            aria-current={isActive ? "true" : undefined}
            onClick={() => onJump(place.id)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/** One platform's departures under its signpost, in departure order. */
function PlatformGroup({
  group,
  renderRow,
}: {
  group: DeparturePlatformGroup;
  renderRow: (departure: Departure, index: number) => ReactNode;
}) {
  const { word, code } = getPlatformHeadingParts(group.platformCode, group.platformKind);
  return (
    <section
      className="departure-board-platform-group"
      aria-label={formatSpokenPlatformHeading(group.platformCode, group.platformKind)}
    >
      {/* The code is the glyph on the sign; the operator's word is its caption. */}
      <h2>
        {word && <small>{word}</small>}
        <b>{code}</b>
      </h2>
      {group.departures.map(renderRow)}
    </section>
  );
}

export function DepartureBoardPanel({
  panelRef,
  stop,
  departures,
  completedLineDepartures = [],
  departureBoard,
  network,
  feedNow,
  lineSelection,
  selectedDeparture,
  corridorPatterns,
  boardingPlaces,
  isStacked = false,
  boardReadingCount = 0,
  onRefresh,
  bottomMenu,
}: DepartureBoardPanelProps) {
  // The panel is keyed by stop, so a new stop starts collapsed.
  const [isExpanded, setIsExpanded] = useState(false);
  // The shared preference, since the board request depends on it too.
  const departureOrder = useStoredPreference(departureBoardOrder);
  const departureListRef = useRef<HTMLDivElement>(null);
  useTransientScrollbar(departureListRef);
  const pullIndicatorRef = useRef<HTMLDivElement>(null);
  // The pull reads its gesture on the list and scrolls whichever element holds the board; it does
  // nothing before a board is read.
  usePullToRefresh({
    listRef: departureListRef,
    indicatorRef: pullIndicatorRef,
    isPageScrollport: isStacked,
    onRefresh: onRefresh ?? (() => {}),
    readingCount: boardReadingCount,
    isEnabled: Boolean(onRefresh) && departureBoard !== null,
  });
  const isGroupedByPlatform = departureOrder === "platform";
  const isGroupedByLine = departureOrder === "line";
  // Live only in platform order, where the sections exist.
  const boardingPlaceSections = useBoardingPlaceSections(departureListRef, {
    isEnabled: isGroupedByPlatform,
    isPageScrollport: isStacked,
  });
  // The rider's setting for where a stacked board stops.
  const { stackedDepartureLimit } = useStoredPreference(appSettings);
  const visibleDepartures = useMemo(
    () => (!isStacked || isExpanded ? departures : departures.slice(0, stackedDepartureLimit)),
    [departures, isExpanded, isStacked, stackedDepartureLimit],
  );
  const collapsedCount = isStacked ? Math.max(0, departures.length - stackedDepartureLimit) : 0;
  // Groups only the departures shown, so the cap does not change with the order.
  const boardingPlaceGroups = useMemo(
    () =>
      isGroupedByPlatform ? groupDeparturesByBoardingPlace(visibleDepartures, boardingPlaces) : [],
    [boardingPlaces, isGroupedByPlatform, visibleDepartures],
  );
  // A place with no departures gets no button.
  const shownBoardingPlaces = useMemo(
    () =>
      boardingPlaceGroups.flatMap((group) => (group.boardingPlace ? [group.boardingPlace] : [])),
    [boardingPlaceGroups],
  );
  // The board's own rows, related by observed corridors; no second request.
  const lineGroups = useMemo(
    () =>
      isGroupedByLine ? getStopServiceCorridorLineGroups(visibleDepartures, corridorPatterns) : [],
    [corridorPatterns, isGroupedByLine, visibleDepartures],
  );
  const staleLabel = getStaleBoardLabel(departureBoard, feedNow);
  const joinedPortionPairs = useMemo(
    () => getJoinedRunPortionPairs(completedLineDepartures),
    [completedLineDepartures],
  );
  const renderRow = (departure: Departure, index: number) => (
    <DepartureRow
      key={departure.id}
      departure={departure}
      index={index}
      nextCompatibleDeparture={
        departure.status === "cancelled"
          ? findNextCompatibleDeparture(departures, departure)
          : undefined
      }
      line={getLineSign(network.lines, departure.lineId, departure.transportMode)}
      stopId={stop.id}
      lineSelection={lineSelection}
      isSelected={isDepartureSelected(departure, selectedDeparture, lineSelection)}
      isPinned={isDeparturePinned(departure, selectedDeparture)}
      feedNow={feedNow}
      showsPlatform={!isGroupedByPlatform}
      joinedPortionPair={findJoinedRunPortionPair(departure, joinedPortionPairs)}
    />
  );

  return (
    <aside
      ref={panelRef}
      className="departure-board-panel"
      aria-labelledby="departure-board-title"
      tabIndex={-1}
    >
      <div className="departure-board-heading">
        <div>
          <h1 id="departure-board-title">{stop.name}</h1>
          {stop.alias && <p className="departure-board-stop-meta">{stop.alias}</p>}
        </div>
        <div className="departure-board-heading-actions">
          <DepartureOrderControl order={departureOrder} onOrderChange={departureBoardOrder.write} />
          <DepartureBoardStatusChip departureBoard={departureBoard} feedNow={feedNow} />
        </div>
      </div>

      {/* A stale board says how old it is, in words. */}
      {staleLabel && (
        <p className="departure-board-stale" role="status">
          {staleLabel}
        </p>
      )}

      {/* Only in platform order with more than one place. */}
      {shownBoardingPlaces.length > 1 && (
        <BoardingPlaceBar
          places={shownBoardingPlaces}
          activePlaceId={boardingPlaceSections.activePlaceId}
          onJump={boardingPlaceSections.scrollToSection}
        />
      )}

      {/* The pull strip, outside the list so it does not scroll away. */}
      <div ref={pullIndicatorRef} className="departure-board-pull" role="status">
        <div className="departure-board-pull-inner">
          <span className="departure-board-pull-label" data-pull="hint">
            Zum Aktualisieren ziehen
          </span>
          <span className="departure-board-pull-label" data-pull="ready">
            Loslassen zum Aktualisieren
          </span>
          <span className="departure-board-pull-label" data-pull="busy">
            Abfahrten werden aktualisiert …
          </span>
        </div>
      </div>

      <div
        ref={departureListRef}
        className="departure-board-list"
        aria-busy={departureBoard === null}
      >
        {isGroupedByPlatform ? (
          boardingPlaceGroups.map((group) => (
            <BoardingPlaceGroup
              key={group.boardingPlace?.id ?? "unplaced"}
              group={group}
              getSectionRef={boardingPlaceSections.getSectionRef}
              renderRow={renderRow}
            />
          ))
        ) : isGroupedByLine ? (
          <DepartureBoardLineOrder
            groups={lineGroups}
            boardingPlaces={boardingPlaces}
            stopId={stop.id}
            lineSelection={lineSelection}
            selectedDeparture={selectedDeparture}
            feedNow={feedNow}
          />
        ) : (
          visibleDepartures.map(renderRow)
        )}

        {departureBoard === null && (
          <div className="panel-empty">
            <strong>Abfahrten werden geladen …</strong>
          </div>
        )}
        {departureBoard?.dataStatus === "unavailable" && (
          <div className="panel-empty">
            <strong>Abfahrten nicht verfügbar</strong>
            <span>
              {departureBoard.errorMessage ?? "Der KVV-Feed konnte nicht gelesen werden."}
            </span>
          </div>
        )}
        {departureBoard?.dataStatus === "live" && departures.length === 0 && (
          <div className="panel-empty">
            <strong>Keine weiteren Abfahrten</strong>
          </div>
        )}
        {collapsedCount > 0 && (
          <button
            type="button"
            className="departure-board-more"
            aria-expanded={isExpanded}
            aria-label={
              isExpanded
                ? `Liste auf ${stackedDepartureLimit} Abfahrten verkürzen`
                : `${collapsedCount} weitere Abfahrten anzeigen`
            }
            onClick={() => setIsExpanded(!isExpanded)}
          >
            {isExpanded ? "Weniger anzeigen" : `+ ${collapsedCount} weitere Abfahrten`}
          </button>
        )}
      </div>

      {bottomMenu}
    </aside>
  );
}
