import { useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode, Ref } from "react";
import { getLineSign } from "../data/line-signs";
import type {
  StopEvent,
  StopEventBoard,
  TransitLine,
  StopPlace,
  TransitNetwork,
} from "../data/transit-types";
import {
  getStaleBoardLabel,
  getVehicleAccessLabel,
  getCountdownReading,
  type CountdownOptions,
  getStopEventAccessibilityLabel,
  getStopEventStatusLabel,
  getDepartureTimeReading,
  isStopEventPinned,
  isStopEventSelected,
} from "../lib/stop-event-presentation";
import { formatBayText, formatSpokenBayHeading, getBayHeadingParts } from "../lib/bay-naming";
import { getStopEventOpenPath, navigateTo } from "../routing";
import type { LineSelection } from "../lib/line-bundles";
import { DepartureCountdown } from "./DepartureCountdown";
import { DepartureTime } from "./DepartureTime";
import { LineBadge } from "./LineBadge";
import { StopEventBoardStatusChip } from "./StopEventBoardStatusChip";
import { SegmentedControl, type SegmentedControlItem } from "./SegmentedControl";
import { classNames } from "../lib/class-names";
import { findNextCompatibleStopEvent } from "../lib/stop-services";
import {
  groupStopEventsByBoardingPlace,
  type StopEventBoardingPlaceGroup,
  type StopEventBayGroup,
} from "../lib/stop-event-order";
import {
  getBoardingPlaceLabel,
  type BoardingPlace,
  type StopBoardingPlaces,
} from "../lib/boarding-places";
import { useStoredPreference } from "../hooks/stored-preference";
import { appSettings } from "../lib/app-settings";
import { useBoardingPlaceSections } from "../hooks/boarding-place-sections";
import { stopEventBoardOrder, type StopEventBoardOrder } from "../lib/stop-event-board-order";
import { usePullToRefresh } from "../hooks/pull-to-refresh";
import { BOARD_REFRESH_LABEL, PullToRefreshStrip } from "./PullToRefreshStrip";
import { useTransientScrollbar } from "../hooks/scrollbar";
import {
  findJoinedDatedJourneyPortionPair,
  getJoinedDatedJourneyPortionPairs,
  type JoinedDatedJourneyPortionPair,
} from "../lib/joined-dated-journey-portions";
import type { StopCorridorPatterns } from "../lib/stop-corridor-patterns";
import { getStopServiceCorridorLineGroups } from "../lib/stop-corridors";
import { StopEventBoardLineOrder } from "./StopEventBoardLineOrder";
import { isSameDatedJourney } from "../lib/journeys";
import { FEED_UNREADABLE_TEXT } from "./feed-copy";
import { findStopPointPart, type StopPlacePart } from "../lib/stop-place-parts";

type StopEventBoardPanelProps = {
  panelRef?: Ref<HTMLElement>;
  stop: StopPlace;
  stopEvents: readonly StopEvent[];
  /** Completed selected-line journeys; absent on a basic stop board by design. */
  completedLineStopEvents?: readonly StopEvent[];
  stopEventBoard: StopEventBoard | null;
  network: TransitNetwork;
  /** The feed's clock, which every countdown counts from. */
  feedNow: number;
  /**
   * The bundled lines; their journeys read as selected, and a row tapped in the bundle stays in it.
   */
  lineSelection?: LineSelection;
  /** The pinned journey, selected on every row of that vehicle. */
  selectedStopEvent?: StopEvent;
  /**
   * What this stop's journeys were observed to do; without it the line order groups by headsign.
   */
  corridorPatterns: StopCorridorPatterns;
  /** The stop's places, learned over the visit so they do not flicker with the rows. */
  boardingPlaces: StopBoardingPlaces;
  /** The place's parts, one per stop point; empty for a place of one. */
  parts: readonly StopPlacePart[];
  /** The part the board is read at; the whole place without one. */
  part: StopPlacePart | undefined;
  /** Reads the board at a part, or at the whole place. */
  onChoosePart: (partId: string | undefined) => void;
  /** A stacked layout caps the list; a panel of its own shows and scrolls the whole board. */
  isStacked?: boolean;
  /** How many readings have answered, failures included; the pull to refresh settles on this. */
  boardReadingCount?: number;
  /** Reads the board again (pull down past the first row); the board stays while reading. */
  onRefresh?: () => void;
  /** Stacked, the page owns the pull; its refresh, for the status chip. */
  onPageRefresh?: () => void;
};

function StopEventRow({
  stopEvent,
  nextCompatibleStopEvent,
  line,
  stopId,
  partId,
  partName,
  lineSelection,
  index,
  isSelected,
  isPinned,
  feedNow,
  showsBay,
  joinedPortionPair,
  countdownOptions,
}: {
  stopEvent: StopEvent;
  /** The part the board is read at, kept by a tap. */
  partId: string | undefined;
  /** The part the row leaves from, where the board joins several. */
  partName: string | undefined;
  /** The next journey on the same route, shown only when this one is cancelled. */
  nextCompatibleStopEvent?: StopEvent;
  line: TransitLine;
  stopId: string;
  /** The lines read together, so a row tapped in a bundle stays in it. */
  lineSelection: LineSelection | undefined;
  /** Print the bay only where no heading above states it. */
  showsBay: boolean;
  /** A high-confidence shared consist inferred from two complete route readings. */
  joinedPortionPair?: JoinedDatedJourneyPortionPair;
  /** The row's position, for the top-down entrance. */
  index: number;
  /** The pinned journey, or any journey of the line when none is pinned. */
  isSelected: boolean;
  /**
   * This row is the addressed journey (either row of a vehicle at a multi-place stop), so tapping
   * steps up.
   */
  isPinned: boolean;
  feedNow: number;
  countdownOptions: CountdownOptions;
}) {
  // A row tap gives the same address at every width; the diagram it opens can start the ride.
  const timeReading = getDepartureTimeReading(stopEvent);
  const vehicleAccessLabel = getVehicleAccessLabel(stopEvent);
  const nextCompatibleReading = nextCompatibleStopEvent
    ? getCountdownReading(nextCompatibleStopEvent, feedNow, countdownOptions)
    : undefined;
  const nextCompatibleLabel =
    nextCompatibleReading?.kind === "minutes"
      ? `${nextCompatibleReading.minutes} min`
      : nextCompatibleReading?.label;
  const isTerminatingPortion =
    joinedPortionPair && isSameDatedJourney(stopEvent, joinedPortionPair.terminating);
  const joinedLabel = joinedPortionPair
    ? isTerminatingPortion
      ? `Gemeinsam bis ${joinedPortionPair.terminating.destinationText} · weiterer Zugteil nach ${joinedPortionPair.continuing.destinationText}`
      : `Gemeinsam bis ${joinedPortionPair.terminating.destinationText}`
    : undefined;

  return (
    <button
      className={classNames(
        "departure",
        isSelected && "selected",
        isPinned && "pinned",
        stopEvent.status === "cancelled" && "cancelled",
        stopEvent.status === "diverted" && "diverted",
        joinedPortionPair && "joined-run-portion",
      )}
      style={{ "--departure-index": index } as CSSProperties}
      aria-current={isSelected ? "true" : undefined}
      onClick={() =>
        navigateTo(getStopEventOpenPath(stopEvent, stopId, isPinned, lineSelection, partId))
      }
      aria-label={`${getStopEventAccessibilityLabel(stopEvent, feedNow, countdownOptions)}${
        partName ? `, ${partName}` : ""
      }${joinedLabel ? `, ${joinedLabel}` : ""}${
        stopEvent.status === "cancelled" && nextCompatibleLabel
          ? `, nächste passende Fahrt ${nextCompatibleLabel}`
          : ""
      }, ${isPinned ? "Auswahl aufheben" : "Fahrtverlauf öffnen"}`}
    >
      <LineBadge line={line} />
      <span className="departure-countdown">
        <DepartureCountdown reading={getCountdownReading(stopEvent, feedNow, countdownOptions)} />
      </span>
      <span className="departure-destination">
        {stopEvent.destinationText}
        {stopEvent.serviceNote && <em>{stopEvent.serviceNote}</em>}
      </span>
      <span className="departure-meta">
        {joinedLabel && <strong className="departure-joined-service">{joinedLabel}</strong>}
        {stopEvent.status === "cancelled" && nextCompatibleLabel && (
          <strong className="departure-next-service">
            Nächste passende Fahrt {nextCompatibleLabel}
          </strong>
        )}
        {timeReading && <DepartureTime reading={timeReading} />}
        {/* Only what the countdown and time do not already say. */}
        {stopEvent.status !== "cancelled" && getStopEventStatusLabel(stopEvent)}
        {/* Only for a vehicle that is not step-free, in words; the norm is spoken. */}
        {stopEvent.status !== "cancelled" && vehicleAccessLabel && (
          <span className="departure-access">{vehicleAccessLabel}</span>
        )}
        {showsBay && (
          <b>
            {partName && `${partName} · `}
            {formatBayText(stopEvent.bay, stopEvent.bayKind)}
          </b>
        )}
      </span>
    </button>
  );
}

/**
 * The board's three orders, all of the same departures: `Zeit` (what leaves next), `Steig` (by
 * bay; the root of Bahnsteig and Bussteig) and `Linie` (where each line goes and when).
 */
const stopEventOrderItems: readonly SegmentedControlItem<StopEventBoardOrder>[] = [
  { value: "time", label: "Zeit", ariaLabel: "Abfahrten nach Abfahrtszeit ordnen" },
  { value: "platform", label: "Steig", ariaLabel: "Abfahrten nach Steig gruppieren" },
  { value: "line", label: "Linie", ariaLabel: "Abfahrten nach Linie und Richtung gruppieren" },
];

function StopEventOrderControl({
  order,
  onOrderChange,
}: {
  order: StopEventBoardOrder;
  onOrderChange: (order: StopEventBoardOrder) => void;
}) {
  return (
    <SegmentedControl
      className="departure-board-order-control"
      value={order}
      items={stopEventOrderItems}
      ariaLabel="Abfahrten ordnen"
      onValueChange={onOrderChange}
    />
  );
}

/** Which part of the place the board reads: all of it, or one stop point's own board. */
function StopPlacePartControl({
  parts,
  part,
  onChoosePart,
}: {
  parts: readonly StopPlacePart[];
  part: StopPlacePart | undefined;
  onChoosePart: (partId: string | undefined) => void;
}) {
  const items: readonly SegmentedControlItem<string>[] = [
    { value: "", label: "Alle", ariaLabel: "Abfahrten aller Bereiche" },
    ...parts.map(({ id, name }) => ({ value: id, label: name, ariaLabel: `Abfahrten ${name}` })),
  ];
  return (
    <SegmentedControl
      className="departure-board-part-control"
      value={part?.id ?? ""}
      items={items}
      ariaLabel="Bereich der Haltestelle"
      onValueChange={(partId) => onChoosePart(partId || undefined)}
    />
  );
}

/** A boarding place's section, only at stops with more than one place. */
function BoardingPlaceGroup({
  group,
  getSectionRef,
  renderRow,
}: {
  group: StopEventBoardingPlaceGroup;
  /** Registers the section under its place id, for the place bar. */
  getSectionRef: (placeId: string) => (section: HTMLElement | null) => void;
  renderRow: (stopEvent: StopEvent, index: number) => ReactNode;
}) {
  const bayGroups = group.bayGroups.map((bayGroup) => (
    <BayGroup key={bayGroup.bay} group={bayGroup} renderRow={renderRow} />
  ));
  if (!group.boardingPlace) return <>{bayGroups}</>;
  const boardingPlace = group.boardingPlace;
  const label = getBoardingPlaceLabel(boardingPlace);
  return (
    <section
      ref={getSectionRef(boardingPlace.id)}
      className="departure-board-boarding-place"
      aria-label={label}
    >
      <h2>{label}</h2>
      {bayGroups}
    </section>
  );
}

/**
 * The places as navigation, not a filter: a button scrolls to its place's section, and the place
 * whose heading is stuck at the top is marked. Bay order only, and only places with
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

/** One bay's departures under its signpost, in departure order. */
function BayGroup({
  group,
  renderRow,
}: {
  group: StopEventBayGroup;
  renderRow: (stopEvent: StopEvent, index: number) => ReactNode;
}) {
  const { word, code } = getBayHeadingParts(group.bay, group.bayKind);
  return (
    <section
      className="departure-board-platform-group"
      aria-label={formatSpokenBayHeading(group.bay, group.bayKind)}
    >
      {/* The code is the glyph on the sign; the operator's word is its caption. */}
      <h2>
        {word && <small>{word}</small>}
        <b>{code}</b>
      </h2>
      {group.stopEvents.map(renderRow)}
    </section>
  );
}

export function StopEventBoardPanel({
  panelRef,
  stop,
  stopEvents,
  completedLineStopEvents = [],
  stopEventBoard,
  network,
  feedNow,
  lineSelection,
  selectedStopEvent,
  corridorPatterns,
  boardingPlaces,
  parts,
  part,
  onChoosePart,
  isStacked = false,
  boardReadingCount = 0,
  onRefresh,
  onPageRefresh,
}: StopEventBoardPanelProps) {
  // The panel is keyed by stop, so a new stop starts collapsed.
  const [isExpanded, setIsExpanded] = useState(false);
  // The shared preference, since the board request depends on it too.
  const stopEventOrder = useStoredPreference(stopEventBoardOrder);
  const stopEventListRef = useRef<HTMLDivElement>(null);
  useTransientScrollbar(stopEventListRef);
  const pullIndicatorRef = useRef<HTMLDivElement>(null);
  // A panel that scrolls itself has its own pull; stacked, the page's pull refreshes the board.
  const pull = usePullToRefresh({
    listRef: stopEventListRef,
    indicatorRef: pullIndicatorRef,
    onRefresh: onRefresh ?? (() => {}),
    readingCount: boardReadingCount,
    isEnabled: !isStacked && Boolean(onRefresh) && stopEventBoard !== null,
  });
  const requestRefresh = isStacked ? onPageRefresh : onRefresh && pull.refresh;
  const isGroupedByBay = stopEventOrder === "platform";
  const isGroupedByLine = stopEventOrder === "line";
  // Live only in bay order, where the sections exist.
  const boardingPlaceSections = useBoardingPlaceSections(stopEventListRef, {
    isEnabled: isGroupedByBay,
    isPageScrollport: isStacked,
  });
  // The rider's setting for where a stacked board stops.
  const { stackedDepartureLimit, isShowingLastMinuteSeconds } = useStoredPreference(appSettings);
  const countdownOptions = { isShowingLastMinuteSeconds };
  const visibleStopEvents = useMemo(
    () => (!isStacked || isExpanded ? stopEvents : stopEvents.slice(0, stackedDepartureLimit)),
    [stopEvents, isExpanded, isStacked, stackedDepartureLimit],
  );
  const collapsedCount = isStacked ? Math.max(0, stopEvents.length - stackedDepartureLimit) : 0;
  // Groups only the departures shown, so the cap does not change with the order.
  const boardingPlaceGroups = useMemo(
    () => (isGroupedByBay ? groupStopEventsByBoardingPlace(visibleStopEvents, boardingPlaces) : []),
    [boardingPlaces, isGroupedByBay, visibleStopEvents],
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
      isGroupedByLine ? getStopServiceCorridorLineGroups(visibleStopEvents, corridorPatterns) : [],
    [corridorPatterns, isGroupedByLine, visibleStopEvents],
  );
  const staleLabel = getStaleBoardLabel(stopEventBoard, feedNow);
  const joinedPortionPairs = useMemo(
    () => getJoinedDatedJourneyPortionPairs(completedLineStopEvents),
    [completedLineStopEvents],
  );
  const renderRow = (stopEvent: StopEvent, index: number) => (
    <StopEventRow
      key={stopEvent.id}
      stopEvent={stopEvent}
      index={index}
      nextCompatibleStopEvent={
        stopEvent.status === "cancelled"
          ? findNextCompatibleStopEvent(stopEvents, stopEvent)
          : undefined
      }
      line={getLineSign(network.lines, stopEvent.lineId, stopEvent.ptMode, stopEvent.lineRef)}
      stopId={stop.id}
      partId={part?.id}
      partName={
        part ? undefined : findStopPointPart(stop.id, stopEvent.boardingProviderStopPointId)?.name
      }
      lineSelection={lineSelection}
      isSelected={isStopEventSelected(stopEvent, selectedStopEvent, lineSelection)}
      isPinned={isStopEventPinned(stopEvent, selectedStopEvent)}
      feedNow={feedNow}
      showsBay={!isGroupedByBay}
      joinedPortionPair={findJoinedDatedJourneyPortionPair(stopEvent, joinedPortionPairs)}
      countdownOptions={countdownOptions}
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
          <StopEventOrderControl order={stopEventOrder} onOrderChange={stopEventBoardOrder.write} />
          <StopEventBoardStatusChip
            stopEventBoard={stopEventBoard}
            feedNow={feedNow}
            onRefresh={requestRefresh}
          />
        </div>
      </div>

      {parts.length > 1 && (
        <StopPlacePartControl parts={parts} part={part} onChoosePart={onChoosePart} />
      )}

      {/* A stale board says how old it is, in words. */}
      {staleLabel && (
        <p className="departure-board-stale" role="status">
          {staleLabel}
        </p>
      )}

      {/* Only in bay order with more than one place. */}
      {shownBoardingPlaces.length > 1 && (
        <BoardingPlaceBar
          places={shownBoardingPlaces}
          activePlaceId={boardingPlaceSections.activePlaceId}
          onJump={boardingPlaceSections.scrollToSection}
        />
      )}

      {/* The pull strip, outside the list so it does not scroll away. */}
      {!isStacked && (
        <PullToRefreshStrip stripRef={pullIndicatorRef} busyLabel={BOARD_REFRESH_LABEL} />
      )}

      <div
        ref={stopEventListRef}
        className="departure-board-list"
        aria-busy={stopEventBoard === null}
      >
        {isGroupedByBay ? (
          boardingPlaceGroups.map((group) => (
            <BoardingPlaceGroup
              key={group.boardingPlace?.id ?? "unplaced"}
              group={group}
              getSectionRef={boardingPlaceSections.getSectionRef}
              renderRow={renderRow}
            />
          ))
        ) : isGroupedByLine ? (
          <StopEventBoardLineOrder
            groups={lineGroups}
            boardingPlaces={boardingPlaces}
            stopId={stop.id}
            partId={part?.id}
            lineSelection={lineSelection}
            selectedStopEvent={selectedStopEvent}
            feedNow={feedNow}
          />
        ) : (
          visibleStopEvents.map(renderRow)
        )}

        {stopEventBoard === null && (
          <div className="panel-empty">
            <strong>Abfahrten werden geladen …</strong>
          </div>
        )}
        {stopEventBoard?.dataStatus === "unavailable" && (
          <div className="panel-empty">
            <strong>Abfahrten nicht verfügbar</strong>
            <span>{stopEventBoard.errorMessage ?? FEED_UNREADABLE_TEXT}</span>
          </div>
        )}
        {stopEventBoard?.dataStatus === "live" && stopEvents.length === 0 && (
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
    </aside>
  );
}
