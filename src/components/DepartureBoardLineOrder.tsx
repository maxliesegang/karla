import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { Departure, PlatformKind } from "../data/transit-types";
import { classNames } from "../lib/class-names";
import {
  getVehicleAccessLabel,
  getDepartureAccessibilityLabel,
  getCountdownReading,
  getDepartureTimeReading,
  isDeparturePinned,
  isDepartureSelected,
  type DepartureTimeReading,
} from "../lib/departure-presentation";
import {
  findSharedPlatformKind,
  findSharedPlatformCode,
  formatPlatformLabel,
  formatSpokenPlatformLabel,
} from "../lib/platform-naming";
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
import { getDepartureOpenPath, navigateTo, routePaths } from "../routing";
import type { LineSelection } from "../lib/line-bundles";
import { DepartureCountdown } from "./DepartureCountdown";
import { DepartureTime } from "./DepartureTime";
import { LineBadge } from "./LineBadge";

/** Trips per direction: the next one and two behind it answer "when, and how often". */
const CORRIDOR_CHIP_LIMIT = 3;

/**
 * What a chip states under its direction heading: the published time (with a struck-through
 * schedule where moved), the destination only where the direction's trips end in different places,
 * and each warning on its own line so a narrow column cannot truncate it. The full reading is in
 * the chip's spoken label.
 */
type CorridorDepartureNote = {
  time: DepartureTimeReading | undefined;
  /** Only what the heading cannot say: a short end, a boarding place. */
  text?: string;
  warnings: string[];
};

function getCorridorDepartureNote(
  departure: Departure,
  sharedPlatformCode: string | undefined,
  /** Whether this direction's trips end in different places. */
  showsDestination: boolean,
): CorridorDepartureNote {
  const parts: string[] = [];
  if (showsDestination) parts.push(departure.destination);
  if (!sharedPlatformCode && departure.platformCode) {
    parts.push(formatPlatformLabel(departure.platformCode, departure.platformKind));
  }
  // The countdown already says "entfällt".
  const warnings =
    departure.status === "cancelled"
      ? []
      : [
          departure.status === "diverted" ? "Umleitung" : undefined,
          getVehicleAccessLabel(departure),
        ].filter((warning): warning is string => Boolean(warning));
  return {
    time: getDepartureTimeReading(departure),
    text: parts.length > 0 ? parts.join(" · ") : undefined,
    warnings,
  };
}

/**
 * One trip of a corridor as a compact chip, so every line fits on screen for comparison. Chips sit
 * in shared columns across the board; the button's label keeps the whole row for screen readers.
 */
function CorridorDepartureChip({
  departure,
  note,
  stopId,
  lineSelection,
  isLead,
  isSelected,
  isPinned,
  feedNow,
}: {
  departure: Departure;
  /** What the heading cannot say for this trip. */
  note: CorridorDepartureNote;
  stopId: string;
  /** The lines read together, so a chip tapped in a bundle stays in it. */
  lineSelection: LineSelection | undefined;
  /** The next trip this way. */
  isLead: boolean;
  isSelected: boolean;
  isPinned: boolean;
  feedNow: number;
}) {
  return (
    <button
      type="button"
      className={classNames(
        "corridor-departure",
        isLead && "lead",
        isSelected && "selected",
        isPinned && "pinned",
        departure.status === "cancelled" && "cancelled",
      )}
      aria-current={isSelected ? "true" : undefined}
      onClick={() => navigateTo(getDepartureOpenPath(departure, stopId, isPinned, lineSelection))}
      aria-label={`${getDepartureAccessibilityLabel(departure, feedNow)}, ${
        isPinned ? "Auswahl aufheben" : "Fahrtverlauf öffnen"
      }`}
    >
      <span className="corridor-departure-countdown">
        <DepartureCountdown reading={getCountdownReading(departure, feedNow)} />
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

/** The direction as heard: line, ends, platform. */
function getCorridorSpokenLabel(
  corridor: StopServiceCorridor,
  lineId: string,
  sharedPlatformCode: string | undefined,
  sharedPlatformKind: PlatformKind | undefined,
  /** Which part of the stop these trips leave from, where there are several. */
  boardingPlaceLabel: string | undefined,
): string {
  // The way's places are visual only; the label speaks the direction and ends.
  const termini = getCorridorTermini(corridor.places);
  const directionIndex = termini.findIndex(({ label }) => label === corridor.directionLabel);
  const onwardPlaces = (directionIndex >= 0 ? termini.slice(directionIndex + 1) : [])
    .map((place) => `, weiter bis ${place.label}`)
    .join("");
  const platform = sharedPlatformCode
    ? `, ab ${formatSpokenPlatformLabel(sharedPlatformCode, sharedPlatformKind)}`
    : "";
  const place = boardingPlaceLabel ? `, Bereich ${boardingPlaceLabel}` : "";
  return `Linie ${lineId} Richtung ${corridor.directionLabel}${onwardPlaces}${place}${platform}`;
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
  renderChip: (departure: Departure, note: CorridorDepartureNote, isLead: boolean) => ReactNode;
}) {
  // The platform goes on the heading when every trip shares it, else on the trips. The shared route
  // is claimed only where observed in full.
  const termini = getCorridorTermini(corridor.places);
  const wayPlaceCount = corridor.places.length - termini.length;
  const { headingRef, measureRef, standDownCount } = useWayPlacesFit(corridor, wayPlaceCount);
  const sharedPlatformCode = findSharedPlatformCode(corridor.departures);
  const sharedPlatformKind = findSharedPlatformKind(corridor.departures);
  const sharedPlatformLabel = sharedPlatformCode
    ? formatPlatformLabel(sharedPlatformCode, sharedPlatformKind)
    : undefined;
  // Only where every trip agrees and the stop has several places (the S1 at Marktplatz leaves from
  // a different tunnel each way).
  const sharedBoardingPlace = findSharedBoardingPlace(boardingPlaces, corridor.departures);
  const boardingPlaceLabel = sharedBoardingPlace
    ? getBoardingPlaceLabel(sharedBoardingPlace)
    : undefined;
  const sharesLinienweg =
    corridor.hasObservedSharedRoute && termini.length <= 1 && corridor.destinations.length > 1;
  const shownDepartures = corridor.departures.slice(0, CORRIDOR_CHIP_LIMIT);

  return (
    <section
      className="departure-board-corridor"
      aria-label={getCorridorSpokenLabel(
        corridor,
        lineId,
        sharedPlatformCode,
        sharedPlatformKind,
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
        {(sharedPlatformLabel || sharesLinienweg || boardingPlaceLabel) && (
          <span className="departure-board-corridor-captions">
            {/* Only trips that part are labelled. */}
            {sharesLinienweg && <small>gemeinsamer Linienweg</small>}
            {boardingPlaceLabel && (
              <small className="departure-board-corridor-place" aria-hidden="true">
                {boardingPlaceLabel}
              </small>
            )}
            {sharedPlatformLabel && (
              <small className="departure-board-corridor-platform" aria-hidden="true">
                {sharedPlatformLabel}
              </small>
            )}
          </span>
        )}
      </h3>
      <div className="departure-board-corridor-strip">
        {shownDepartures.map((departure, index) =>
          renderChip(
            departure,
            getCorridorDepartureNote(
              departure,
              sharedPlatformCode,
              corridor.destinations.length > 1,
            ),
            index === 0,
          ),
        )}
        {/* Empty cells keep the board's columns aligned. */}
        {Array.from({ length: Math.max(0, columns - shownDepartures.length) }, (_, index) => (
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
  boardingPlaces,
  columns,
  renderChip,
}: {
  group: StopServiceCorridorLineGroup;
  stopId: string;
  boardingPlaces: StopBoardingPlaces;
  columns: number;
  renderChip: (departure: Departure, note: CorridorDepartureNote, isLead: boolean) => ReactNode;
}) {
  return (
    <section className="departure-board-line-group" aria-label={`Linie ${group.id}`}>
      <h2>
        <button
          type="button"
          className="stop-line-group-heading"
          onClick={() => navigateTo(routePaths.line(group.line.id, stopId))}
          aria-label={`Linie ${group.line.id}, Linienverlauf öffnen`}
          // The band's line colour, mixed toward the ink in CSS.
          style={{ "--line-color": group.line.color } as CSSProperties}
        >
          <LineBadge line={group.line} size="sm" />
          <span>Linienverlauf</span>
          <b aria-hidden="true">›</b>
        </button>
      </h2>
      {group.corridors.map((corridor) => (
        <CorridorGroup
          key={corridor.id}
          corridor={corridor}
          lineId={group.id}
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
export function DepartureBoardLineOrder({
  groups,
  stopId,
  boardingPlaces,
  lineSelection,
  selectedDeparture,
  feedNow,
}: {
  groups: readonly StopServiceCorridorLineGroup[];
  stopId: string;
  /** The stop's places, so each direction can say which it leaves from. */
  boardingPlaces: StopBoardingPlaces;
  /** The lines in view; their trips read as selected. */
  lineSelection: LineSelection | undefined;
  /** The pinned trip, selected on every row of that vehicle. */
  selectedDeparture: Departure | undefined;
  feedNow: number;
}) {
  const renderChip = (departure: Departure, note: CorridorDepartureNote, isLead: boolean) => (
    <CorridorDepartureChip
      key={departure.id}
      departure={departure}
      note={note}
      stopId={stopId}
      lineSelection={lineSelection}
      isLead={isLead}
      isSelected={isDepartureSelected(departure, selectedDeparture, lineSelection)}
      isPinned={isDeparturePinned(departure, selectedDeparture)}
      feedNow={feedNow}
    />
  );

  // Columns: the busiest direction's count, up to three.
  const corridorColumns = Math.min(
    CORRIDOR_CHIP_LIMIT,
    Math.max(
      1,
      ...groups.flatMap((group) => group.corridors.map((corridor) => corridor.departures.length)),
    ),
  );

  return (
    <div className="departure-board-line-order" data-corridor-columns={corridorColumns}>
      {groups.map((group) => (
        <LineGroup
          key={group.id}
          group={group}
          stopId={stopId}
          boardingPlaces={boardingPlaces}
          columns={corridorColumns}
          renderChip={renderChip}
        />
      ))}
    </div>
  );
}
