import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { Departure, PlatformKind } from "../data/transit-types";
import { classNames } from "../lib/class-names";
import {
  findVehicleAccessLabel,
  getDepartureAccessibilityLabel,
  getCountdownReading,
  getDepartureTimeReading,
  isDepartureSelected,
  type DepartureTimeReading,
} from "../lib/departure-presentation";
import {
  findSharedPlatformKind,
  findSharedPlatformName,
  formatPlatformName,
  formatSpokenPlatformName,
} from "../lib/platform-naming";
import type { StopServiceCorridor, StopServiceCorridorLineGroup } from "../lib/stop-corridors";
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

/**
 * How many of a direction's trips stand on the board at once.
 *
 * A rider reading this order is asking "when does the 2 go my way, and how does that compare to the
 * 5" — a question the next departure answers and the two behind it qualify: how long the wait is if
 * this one is missed, and how often the direction runs. A fourth countdown adds nothing to that
 * comparison and takes its width from the direction's own name, which is the part a rider who does
 * not know the network has to read. Three is therefore what a direction shows; the time order keeps
 * the rest of them.
 */
const CORRIDOR_CHIP_LIMIT = 3;

/**
 * What a trip has to state for itself, under a heading that has already stated the rest.
 *
 * Every chip publishes the time its trip is expected at — the same one published time the other two
 * orders print, with the schedule struck through beside it where a deviation moved it. A countdown
 * alone was the reading's own doing: "in 5 min" is not a time a rider can hold a departure board or
 * a printed timetable up against, and the punctuality that the pair of numbers states — this trip
 * is running late, that one is not — was the one thing the line order could not show at all. It is
 * also what makes the strip a table: one number in the same place in every box, under a countdown
 * whose size changes from chip to chip.
 *
 * Whether the trip is monitored is not printed here. It is a word on nineteen chips out of twenty
 * at the hours a board is mostly timetable, and a strip of small print under every countdown is
 * exactly what this reading exists to be free of; the time order states it on the row, and every
 * chip still speaks it in its own label.
 *
 * The destination is stated only where the trips of the direction actually part. A corridor is the
 * way these trips share, so where every one of them ends in the same place the heading above has
 * already said where they go: three chips each captioned "Durlach Turmberg" under "→ Durlach" said
 * one thing three times over, in the smallest type on the board, and left a rider scanning the
 * exceptions to find the one trip that really does end early. Where they do part, every chip names
 * its own end, because that is the choice being made. The full destination is never lost either
 * way: each chip speaks it in its own label, as it always did.
 *
 * Each warning prints on a line of its own, under the rest. A warning is the one part of a chip a
 * rider may be scanning *for*, and it is the whole of what says a trip is diverted or has steps —
 * so it is the one thing here that must never be the half of a note that a narrow column drops:
 * "Knielinger Allee · Um…" is a chip that has quietly stopped warning anybody. Joined to each other
 * they were as lossy as they had been joined to the destination — a column this narrow gives a
 * warning two lines, and two warnings sharing them cost the second one its word.
 */
type CorridorDepartureNote = {
  /** The one published time, which every chip states. */
  time: DepartureTimeReading | undefined;
  /** Only what the heading cannot say for this trip: where it ends short, where it leaves from. */
  text?: string;
  warnings: string[];
};

function getCorridorDepartureNote(
  departure: Departure,
  sharedPlatformName: string | undefined,
  /** Whether the trips of this direction end in different places, which is the only time they say. */
  showsDestination: boolean,
): CorridorDepartureNote {
  const parts: string[] = [];
  if (showsDestination) parts.push(departure.destination);
  if (!sharedPlatformName && departure.platformName) {
    parts.push(formatPlatformName(departure.platformName, departure.platformKind));
  }
  // The countdown already says "entfällt" in the largest type on the chip; nothing repeats it.
  const warnings =
    departure.status === "cancelled"
      ? []
      : [
          departure.status === "diverted" ? "Umleitung" : undefined,
          findVehicleAccessLabel(departure),
        ].filter((warning): warning is string => Boolean(warning));
  return {
    time: getDepartureTimeReading(departure),
    text: parts.length > 0 ? parts.join(" · ") : undefined,
    warnings,
  };
}

/**
 * One trip of a corridor, as the minute it leaves in.
 *
 * The line reading is a comparison, and a comparison is only readable while the things compared are
 * on screen together. A full row per trip put four departures where four *lines* had to fit, so the
 * reading that exists to give an overview was the one that had to be scrolled. The direction is
 * stated once, above; what a trip has left to add is when it goes — the countdown, the time that
 * countdown is running to, and then only the exceptions. Every chip of the board sits in the same three columns, so the next departure of one line
 * is directly above the next departure of the next — which is the comparison itself, drawn.
 * Nothing is dropped from the button's label, so a screen reader still hears the whole row.
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
  /** What the heading above cannot say for this trip: where it ends short, where it leaves from. */
  note: CorridorDepartureNote;
  stopId: string;
  /** The lines being read together, so a chip tapped inside a bundle stays inside it. */
  lineSelection: LineSelection | undefined;
  /** The next trip this way — the one a rider reading this direction is actually catching. */
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
      {/* The minute it is expected at, spoken in full in the button's label above. */}
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

/** The corridor's direction as it is heard: the line, the ends a rider picks between, the platform. */
function getCorridorSpokenLabel(
  corridor: StopServiceCorridor,
  lineId: string,
  sharedPlatformName: string | undefined,
  sharedPlatformKind: PlatformKind | undefined,
): string {
  // The way's own places are for the eye; what is heard is the direction and the ends past it.
  const termini = getCorridorTermini(corridor.places);
  const directionIndex = termini.findIndex(({ label }) => label === corridor.directionLabel);
  const onwardPlaces = (directionIndex >= 0 ? termini.slice(directionIndex + 1) : [])
    .map((place) => `, weiter bis ${place.label}`)
    .join("");
  const platform = sharedPlatformName
    ? `, ab ${formatSpokenPlatformName(sharedPlatformName, sharedPlatformKind)}`
    : "";
  return `Linie ${lineId} Richtung ${corridor.directionLabel}${onwardPlaces}${platform}`;
}

/** The direction is one line: the way's own places fit beside its ends or stand down. */
const DIRECTION_LINE_BUDGET = 1;

/**
 * How many of the way's own places the row has stood down to fit the one line the direction gets.
 *
 * Measured against a hidden copy of the chain as it currently reads, laid out at the width the
 * heading really gets: while it outgrows its line, one more place stands down — the least prominent
 * still shown, since `getShownCorridorPlaces` drops them in rank order — until what is left fits,
 * so a row keeps every place it has the room for rather than dropping the way whole.
 * A fresh corridor offers the whole way again, so a row that gains the room takes its places back.
 * The ends are never stood down: where they alone outgrow the line they wrap rather than vanish,
 * and nothing on the row is ever cut off mid-word.
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
    // A stand-down re-runs this effect to measure what is left; a fresh corridor is the one thing
    // that offers the whole way again.
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

/**
 * The way as the row draws it: every place with the arrow that walks to it, the end the corridor
 * heads into carrying the strong arrow. The ends are the chain's spine and are always drawn; the
 * places between them only where the one line has room for them.
 */
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
    // No way was observed: the direction is the one name the row has.
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
 * One direction of one line: where it goes, and when the next ones leave.
 *
 * The corridor's own name carries the direction — the place these trips head into, not the headsign
 * of whichever one happens to be first — and it is given the width it needs to be read: the
 * countdowns beside it stand in fixed columns, so a longer direction never squeezes them and they
 * never squeeze it. The next three leave visible; the time order keeps the rest of the direction.
 */
function CorridorGroup({
  corridor,
  lineId,
  columns,
  renderChip,
}: {
  corridor: StopServiceCorridor;
  lineId: string;
  /** How many countdown columns the whole board is laid out in, which every strip fills. */
  columns: number;
  renderChip: (departure: Departure, note: CorridorDepartureNote, isLead: boolean) => ReactNode;
}) {
  // The platform is a fact about where to stand, so it is stated where it holds: on the heading when
  // every trip of the direction leaves from it, on the trip when they part. The shared route is
  // claimed only where it was observed in full — a first link says the trips leave together, not
  // that they stay together.
  const termini = getCorridorTermini(corridor.places);
  const wayPlaceCount = corridor.places.length - termini.length;
  const { headingRef, measureRef, standDownCount } = useWayPlacesFit(corridor, wayPlaceCount);
  const sharedPlatformName = findSharedPlatformName(corridor.departures);
  const sharedPlatformKind = findSharedPlatformKind(corridor.departures);
  const sharedPlatformLabel = sharedPlatformName
    ? formatPlatformName(sharedPlatformName, sharedPlatformKind)
    : undefined;
  const sharesLinienweg =
    corridor.hasObservedSharedRoute && termini.length <= 1 && corridor.destinations.length > 1;
  const shownDepartures = corridor.departures.slice(0, CORRIDOR_CHIP_LIMIT);

  return (
    <section
      className="departure-board-corridor"
      aria-label={getCorridorSpokenLabel(corridor, lineId, sharedPlatformName, sharedPlatformKind)}
    >
      <h3 ref={headingRef}>
        {/* The way out of this stop, on the one line the direction fills: the places these trips
            pass through and the ends they turn back at, walked in route order. The ends always
            show; the way's own places stand down, least prominent first, while the chain outgrows
            the line. Nothing here clips — a direction cut off mid-word is the one thing on this
            reading a rider who does not know the network cannot recover from the rest of the row. */}
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
        {(sharedPlatformLabel || sharesLinienweg) && (
          <span className="departure-board-corridor-captions">
            {/* Only trips that part need saying so: a chain of places already reads as one route
                that some trips stay on longer than others. */}
            {sharesLinienweg && <small>gemeinsamer Linienweg</small>}
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
              sharedPlatformName,
              corridor.destinations.length > 1,
            ),
            index === 0,
          ),
        )}
        {/* A direction with fewer trips in view than the board lays out columns for keeps the
            columns: the strip is one table across the whole board, and a row that simply stopped
            two thirds of the way across it left the hairline it closes on running out over nothing.
            An empty cell is the honest reading — this direction has no third trip on the board —
            and it is what keeps every rule of the table straight down the panel. */}
        {Array.from({ length: Math.max(0, columns - shownDepartures.length) }, (_, index) => (
          <i key={`blank-${index}`} className="corridor-departure-blank" aria-hidden="true" />
        ))}
      </div>
    </section>
  );
}

/**
 * One line's departures from this stop, gathered under the directions they take out of it.
 *
 * The heading is the way to the whole line: it is the one thing this reading offers that the board
 * itself cannot, since a row addresses a single trip and a rider asking "where does the 2 go" is
 * asking about the line. It is a band the eye can find while scrolling, and it sticks — the same
 * signpost the platform reading gives a platform, given here to the line, because in this order the
 * line is what a rider is scrolling to find.
 */
function LineGroup({
  group,
  stopId,
  columns,
  renderChip,
}: {
  group: StopServiceCorridorLineGroup;
  stopId: string;
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
          // The band carries its own line's sign colour so the pointer can answer in that colour
          // rather than in a flat white. CSS mixes it toward the ink before painting with it.
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
          columns={columns}
          renderChip={renderChip}
        />
      ))}
    </section>
  );
}

/**
 * The board's third order, its departures gathered by the line and direction they take out of the
 * stop. The groups arrive prebuilt from `getStopServiceCorridorLineGroups`; this is only their
 * reading, so the order stays a reading of the board the rider already has and never a second board.
 */
export function DepartureBoardLineOrder({
  groups,
  stopId,
  lineSelection,
  selectedDepartureId,
  feedNow,
}: {
  groups: readonly StopServiceCorridorLineGroup[];
  stopId: string;
  /** The lines in view, whose every trip this stop lists reads as the selection. */
  lineSelection: LineSelection | undefined;
  selectedDepartureId: string | undefined;
  feedNow: number;
}) {
  // The line reading's own row: the same trip, addressed the same way as a row, printed as the
  // countdown the comparison is actually made on.
  const renderChip = (departure: Departure, note: CorridorDepartureNote, isLead: boolean) => (
    <CorridorDepartureChip
      key={departure.id}
      departure={departure}
      note={note}
      stopId={stopId}
      lineSelection={lineSelection}
      isLead={isLead}
      isSelected={isDepartureSelected(departure, selectedDepartureId, lineSelection)}
      isPinned={selectedDepartureId === departure.id}
      feedNow={feedNow}
    />
  );

  // How many countdown columns the board lays out — the most any one direction has to show, up to
  // the three it may. Reserving all three under a board whose directions run every twenty minutes
  // left two empty columns beside every line; taking them from the board's own busiest direction
  // keeps the columns aligned and lets the strip end where the departures do.
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
          columns={corridorColumns}
          renderChip={renderChip}
        />
      ))}
    </div>
  );
}
