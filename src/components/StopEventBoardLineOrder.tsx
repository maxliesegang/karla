import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { StopEvent, BayKind } from "../data/transit-types";
import { classNames } from "../lib/class-names";
import { isNetworkLineIdentity } from "../lib/line-families";
import {
  getVehicleAccessLabel,
  getStopEventAccessibilityLabel,
  getCountdownReading,
  type CountdownOptions,
  getDepartureTimeReading,
  isStopEventPinned,
  isStopEventSelected,
  type DepartureTimeReading,
} from "../lib/stop-event-presentation";
import {
  findSharedBayKind,
  findSharedBay,
  formatBayText,
  formatSpokenBayText,
} from "../lib/bay-naming";
import type { StopServiceCorridor, StopServiceCorridorLineGroup } from "../lib/stop-corridors";
import {
  findSharedBoardingPlace,
  getBoardingPlaceLabel,
  type StopBoardingPlaces,
} from "../lib/boarding-places";
import {
  getCorridorTermini,
  getShownCorridorPlaces,
  type StopServiceCorridorPlace,
} from "../lib/stop-corridor-way";
import { getStopEventOpenPath, navigateTo, routePaths } from "../routing";
import { useStoredPreference } from "../hooks/stored-preference";
import { appSettings } from "../lib/app-settings";
import type { LineSelection } from "../lib/line-bundles";
import { DepartureCountdown } from "./DepartureCountdown";
import { DepartureTime } from "./DepartureTime";
import { LineBadge } from "./LineBadge";

/** Journeys per direction: the next one and two behind it answer "when, and how often". */
const CORRIDOR_CHIP_LIMIT = 3;

/**
 * What a chip states under its direction heading: the published time (with a struck-through
 * schedule where moved), the destination only where the direction's journeys end in different
 * places, and each warning on its own line so a narrow column cannot truncate it. The full reading
 * is in the chip's spoken label.
 */
type CorridorStopEventNote = {
  time: DepartureTimeReading | undefined;
  /** Only what the heading cannot say: a short end, a boarding place. */
  text?: string;
  warnings: string[];
};

function getCorridorStopEventNote(
  stopEvent: StopEvent,
  sharedBay: string | undefined,
  /** Whether this direction's journeys end in different places. */
  showsDestination: boolean,
): CorridorStopEventNote {
  const parts: string[] = [];
  if (showsDestination) parts.push(stopEvent.destinationText);
  if (!sharedBay && stopEvent.bay) {
    parts.push(formatBayText(stopEvent.bay, stopEvent.bayKind));
  }
  // The countdown already says "entfällt".
  const warnings =
    stopEvent.status === "cancelled"
      ? []
      : [
          stopEvent.status === "diverted" ? "Umleitung" : undefined,
          getVehicleAccessLabel(stopEvent),
        ].filter((warning): warning is string => Boolean(warning));
  return {
    time: getDepartureTimeReading(stopEvent),
    text: parts.length > 0 ? parts.join(" · ") : undefined,
    warnings,
  };
}

/**
 * One journey of a corridor as a compact chip, so every line fits on screen for comparison. Chips
 * sit in shared columns across the board; the button's label keeps the whole row for screen
 * readers.
 */
function CorridorStopEventChip({
  stopEvent,
  note,
  stopId,
  partId,
  lineSelection,
  isLead,
  isSelected,
  isPinned,
  feedNow,
  countdownOptions,
}: {
  stopEvent: StopEvent;
  /** What the heading cannot say for this journey. */
  note: CorridorStopEventNote;
  stopId: string;
  /** The part the board is read at, kept by a tap. */
  partId: string | undefined;
  /** The lines read together, so a chip tapped in a bundle stays in it. */
  lineSelection: LineSelection | undefined;
  /** The next journey this way. */
  isLead: boolean;
  isSelected: boolean;
  isPinned: boolean;
  feedNow: number;
  countdownOptions: CountdownOptions;
}) {
  return (
    <button
      type="button"
      className={classNames(
        "corridor-departure",
        isLead && "lead",
        isSelected && "selected",
        isPinned && "pinned",
        stopEvent.status === "cancelled" && "cancelled",
      )}
      aria-current={isSelected ? "true" : undefined}
      onClick={() =>
        navigateTo(getStopEventOpenPath(stopEvent, stopId, isPinned, lineSelection, partId))
      }
      aria-label={`${getStopEventAccessibilityLabel(stopEvent, feedNow, countdownOptions)}, ${
        isPinned ? "Auswahl aufheben" : "Fahrtverlauf öffnen"
      }`}
    >
      <span className="corridor-departure-countdown">
        <DepartureCountdown reading={getCountdownReading(stopEvent, feedNow, countdownOptions)} />
      </span>
      {/* Spoken in full in the button's label. */}
      {note.time && (
        <small className="corridor-departure-time" aria-hidden="true">
          <DepartureTime reading={note.time} />
        </small>
      )}
      {note.text && <small className="corridor-departure-note">{note.text}</small>}
      {note.warnings.map((warning) => (
        <small key={warning} className="corridor-departure-note corridor-departure-warning">
          {warning}
        </small>
      ))}
    </button>
  );
}

/** The direction as heard: line, ends, bay. */
function getCorridorSpokenLabel(
  corridor: StopServiceCorridor,
  lineId: string,
  sharedBay: string | undefined,
  sharedBayKind: BayKind | undefined,
  /** Which part of the stop these journeys leave from, where there are several. */
  boardingPlaceLabel: string | undefined,
): string {
  // The way's places are visual only; the label speaks the direction and ends.
  const termini = getCorridorTermini(corridor.places);
  const directionIndex = termini.findIndex(({ label }) => label === corridor.directionLabel);
  const onwardPlaces = (directionIndex >= 0 ? termini.slice(directionIndex + 1) : [])
    .map((place) => `, weiter bis ${place.label}`)
    .join("");
  const bay = sharedBay ? `, ab ${formatSpokenBayText(sharedBay, sharedBayKind)}` : "";
  const place = boardingPlaceLabel ? `, Bereich ${boardingPlaceLabel}` : "";
  return `Linie ${lineId} Richtung ${corridor.directionLabel}${onwardPlaces}${place}${bay}`;
}

/** The direction gets one line; the way's places stand down to fit. */
const DIRECTION_LINE_BUDGET = 1;

/**
 * How many of the way's places to drop so the direction fits one line, measured on a hidden copy:
 * the least prominent goes first until it fits. A new corridor starts with every place again. The
 * ends never drop; they wrap.
 */
function useWayPlacesFit(
  corridor: StopServiceCorridor,
  wayPlaceCount: number,
): {
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  measureRef: React.RefObject<HTMLSpanElement | null>;
  standDownCount: number;
} {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const corridorRef = useRef(corridor);
  const [standDownCount, setStandDownCount] = useState(0);

  useLayoutEffect(() => {
    // A stand-down re-runs this effect; a new corridor resets it.
    const isFreshCorridor = corridorRef.current !== corridor;
    corridorRef.current = corridor;
    if (isFreshCorridor && standDownCount > 0) {
      setStandDownCount(0);
      return;
    }

    const measure = () => {
      const measureElement = measureRef.current;
      if (!measureElement || standDownCount >= wayPlaceCount) return;
      const lineHeight = Number.parseFloat(getComputedStyle(measureElement).lineHeight);
      if (!Number.isFinite(lineHeight)) return;
      if (measureElement.getBoundingClientRect().height <= lineHeight * DIRECTION_LINE_BUDGET + 0.5)
        return;
      setStandDownCount(standDownCount + 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined" || !headingRef.current) return;
    const observer = new ResizeObserver(measure);
    observer.observe(headingRef.current);
    return () => observer.disconnect();
  }, [corridor, standDownCount, wayPlaceCount]);

  return { headingRef, measureRef, standDownCount };
}

/** The way as drawn: places with arrows, ends always, places between only where they fit. */
function DirectionChain({
  places,
  directionLabel,
  standDownCount,
}: {
  places: readonly StopServiceCorridorPlace[];
  directionLabel: string;
  standDownCount: number;
}) {
  const shown = getShownCorridorPlaces(places, standDownCount);
  if (shown.length === 0) {
    // No way observed: the direction is the name.
    return (
      <span>
        <b className="departure-board-corridor-arrow" aria-hidden="true">
          →
        </b>
        {directionLabel}
      </span>
    );
  }
  const directionIndex = shown.findIndex(
    ({ isTerminus, label }) => isTerminus && label === directionLabel,
  );
  return (
    <>
      {shown.map((place, index) =>
        index === directionIndex ? (
          <span key={index}>
            <b className="departure-board-corridor-arrow" aria-hidden="true">
              →
            </b>
            {place.label}
          </span>
        ) : (
          <span className="departure-board-corridor-onward" key={index}>
            <b aria-hidden="true">→</b>
            {place.label}
          </span>
        ),
      )}
    </>
  );
}

/**
 * One direction of one line: the corridor's name and fixed countdown columns, so neither squeezes
 * the other.
 */
function CorridorGroup({
  corridor,
  lineId,
  boardingPlaces,
  columns,
  renderChip,
}: {
  corridor: StopServiceCorridor;
  lineId: string;
  boardingPlaces: StopBoardingPlaces;
  /** Countdown columns on the whole board. */
  columns: number;
  renderChip: (stopEvent: StopEvent, note: CorridorStopEventNote, isLead: boolean) => ReactNode;
}) {
  // The bay goes on the heading when every journey shares it, else on the journeys. The shared
  // route is claimed only where observed in full.
  const termini = getCorridorTermini(corridor.places);
  const wayPlaceCount = corridor.places.length - termini.length;
  const { headingRef, measureRef, standDownCount } = useWayPlacesFit(corridor, wayPlaceCount);
  const sharedBay = findSharedBay(corridor.stopEvents);
  const sharedBayKind = findSharedBayKind(corridor.stopEvents);
  const sharedBayText = sharedBay ? formatBayText(sharedBay, sharedBayKind) : undefined;
  // Only where every journey agrees and the stop has several places (the S1 at Marktplatz leaves
  // from a different tunnel each way).
  const sharedBoardingPlace = findSharedBoardingPlace(boardingPlaces, corridor.stopEvents);
  const boardingPlaceLabel = sharedBoardingPlace
    ? getBoardingPlaceLabel(sharedBoardingPlace)
    : undefined;
  const sharesLinienweg =
    corridor.hasObservedSharedRoute && termini.length <= 1 && corridor.destinations.length > 1;
  const shownStopEvents = corridor.stopEvents.slice(0, CORRIDOR_CHIP_LIMIT);

  return (
    <section
      className="departure-board-corridor"
      aria-label={getCorridorSpokenLabel(
        corridor,
        lineId,
        sharedBay,
        sharedBayKind,
        boardingPlaceLabel,
      )}
    >
      <h3 ref={headingRef}>
        {/* The way out on one line: places stand down in rank order; ends never clip. */}
        <span className="departure-board-corridor-direction">
          <DirectionChain
            places={corridor.places}
            directionLabel={corridor.directionLabel}
            standDownCount={standDownCount}
          />
        </span>
        {wayPlaceCount > 0 && (
          <span
            ref={measureRef}
            className="departure-board-corridor-direction departure-board-corridor-direction-measure"
            aria-hidden="true"
          >
            <DirectionChain
              places={corridor.places}
              directionLabel={corridor.directionLabel}
              standDownCount={standDownCount}
            />
          </span>
        )}
        {(sharedBayText || sharesLinienweg || boardingPlaceLabel) && (
          <span className="departure-board-corridor-captions">
            {/* Only journeys that part are labelled. */}
            {sharesLinienweg && <small>gemeinsamer Linienweg</small>}
            {boardingPlaceLabel && (
              <small className="departure-board-corridor-place" aria-hidden="true">
                {boardingPlaceLabel}
              </small>
            )}
            {sharedBayText && (
              <small className="departure-board-corridor-platform" aria-hidden="true">
                {sharedBayText}
              </small>
            )}
          </span>
        )}
      </h3>
      <div className="departure-board-corridor-strip">
        {shownStopEvents.map((stopEvent, index) =>
          renderChip(
            stopEvent,
            getCorridorStopEventNote(stopEvent, sharedBay, corridor.destinations.length > 1),
            index === 0,
          ),
        )}
        {/* Empty cells keep the board's columns aligned. */}
        {Array.from({ length: Math.max(0, columns - shownStopEvents.length) }, (_, index) => (
          <i key={`blank-${index}`} className="corridor-departure-blank" aria-hidden="true" />
        ))}
      </div>
    </section>
  );
}

/** One line's departures, grouped by direction under a sticky line heading. */
function LineGroup({
  group,
  stopId,
  partId,
  boardingPlaces,
  columns,
  renderChip,
}: {
  group: StopServiceCorridorLineGroup;
  stopId: string;
  partId: string | undefined;
  boardingPlaces: StopBoardingPlaces;
  columns: number;
  renderChip: (stopEvent: StopEvent, note: CorridorStopEventNote, isLead: boolean) => ReactNode;
}) {
  return (
    <section className="departure-board-line-group" aria-label={`Linie ${group.line.id}`}>
      <h2>
        {isNetworkLineIdentity(group.line.identity) ? (
          <button
            type="button"
            className="stop-line-group-heading"
            onClick={() => navigateTo(routePaths.line(group.line.id, stopId, [], partId))}
            aria-label={`Linie ${group.line.id}, Linienverlauf öffnen`}
            // The band's line colour, mixed toward the ink in CSS.
            style={{ "--line-color": group.line.color } as CSSProperties}
          >
            <LineBadge line={group.line} size="sm" />
            <span>Linienverlauf</span>
            <b aria-hidden="true">›</b>
          </button>
        ) : (
          // Another operator's line has no line page here.
          <span
            className="stop-line-group-heading is-static"
            style={{ "--line-color": group.line.color } as CSSProperties}
          >
            <LineBadge line={group.line} size="sm" />
          </span>
        )}
      </h2>
      {group.corridors.map((corridor) => (
        <CorridorGroup
          key={corridor.id}
          corridor={corridor}
          lineId={group.line.id}
          boardingPlaces={boardingPlaces}
          columns={columns}
          renderChip={renderChip}
        />
      ))}
    </section>
  );
}

/**
 * The board's line order: departures by line and direction. Groups come prebuilt from
 * `getStopServiceCorridorLineGroups`.
 */
export function StopEventBoardLineOrder({
  groups,
  stopId,
  partId,
  boardingPlaces,
  lineSelection,
  selectedStopEvent,
  feedNow,
}: {
  groups: readonly StopServiceCorridorLineGroup[];
  stopId: string;
  /** The part the board is read at, kept by a tap. */
  partId?: string;
  /** The stop's places, so each direction can say which it leaves from. */
  boardingPlaces: StopBoardingPlaces;
  /** The lines in view; their journeys read as selected. */
  lineSelection: LineSelection | undefined;
  /** The pinned journey, selected on every row of that vehicle. */
  selectedStopEvent: StopEvent | undefined;
  feedNow: number;
}) {
  const { isShowingLastMinuteSeconds } = useStoredPreference(appSettings);
  const countdownOptions = { isShowingLastMinuteSeconds };
  const renderChip = (stopEvent: StopEvent, note: CorridorStopEventNote, isLead: boolean) => (
    <CorridorStopEventChip
      key={stopEvent.id}
      stopEvent={stopEvent}
      note={note}
      stopId={stopId}
      partId={partId}
      lineSelection={lineSelection}
      isLead={isLead}
      isSelected={isStopEventSelected(stopEvent, selectedStopEvent, lineSelection)}
      isPinned={isStopEventPinned(stopEvent, selectedStopEvent)}
      feedNow={feedNow}
      countdownOptions={countdownOptions}
    />
  );

  // Columns: the busiest direction's count, up to three.
  const corridorColumns = Math.min(
    CORRIDOR_CHIP_LIMIT,
    Math.max(
      1,
      ...groups.flatMap((group) => group.corridors.map((corridor) => corridor.stopEvents.length)),
    ),
  );

  return (
    <div className="departure-board-line-order" data-corridor-columns={corridorColumns}>
      {groups.map((group) => (
        <LineGroup
          key={group.id}
          group={group}
          stopId={stopId}
          partId={partId}
          boardingPlaces={boardingPlaces}
          columns={corridorColumns}
          renderChip={renderChip}
        />
      ))}
    </div>
  );
}
