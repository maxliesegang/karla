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
  findStaleBoardLabel,
  findVehicleAccessLabel,
  getCountdownReading,
  getDepartureAccessibilityLabel,
  getDepartureStatusLabel,
  getDepartureTimeReading,
  isDepartureSelected,
} from "../lib/departure-presentation";
import type { DepartureTimeReading } from "../lib/departure-presentation";
import {
  formatPlatformName,
  formatSpokenPlatformHeading,
  getPlatformHeadingParts,
} from "../lib/platform-naming";
import { getDepartureOpenPath, navigateTo } from "../routing";
import type { LineSelection } from "../lib/line-bundles";
import { DepartureCountdown } from "./DepartureCountdown";
import { LineBadge } from "./LineBadge";
import { DepartureBoardStatusChip } from "./DepartureBoardStatusChip";
import { SegmentedControl, type SegmentedControlItem } from "./SegmentedControl";
import { classNames } from "../lib/class-names";
import { findNextCompatibleDeparture } from "../lib/stop-services";
import {
  groupDeparturesByPlatform,
  type DepartureBoardOrder,
  type DeparturePlatformGroup,
} from "../lib/departure-order";
import { useDepartureBoardOrder, useTransientScrollbar, writeDepartureBoardOrder } from "../hooks";
import {
  findJoinedTripPortionPair,
  getJoinedTripPortionPairs,
  type JoinedTripPortionPair,
} from "../lib/joined-trip-portions";
import type { StopCorridorPatterns } from "../lib/stop-corridor-patterns";
import { getStopServiceCorridorLineGroups } from "../lib/stop-corridors";
import { DepartureBoardLineOrder } from "./DepartureBoardLineOrder";
import { isSameVehicleTrip } from "../lib/trips";

/**
 * A stacked layout scrolls the document, so the board has to end somewhere a thumb can reach
 * past. A panel of its own scrolls itself and simply shows what the feed answered.
 */
const STACKED_DEPARTURE_LIMIT = 8;

type DepartureBoardPanelProps = {
  panelRef?: Ref<HTMLElement>;
  stop: TransitStop;
  departures: readonly Departure[];
  /** Completed selected-line trips; absent on a basic stop board by design. */
  completedLineDepartures?: readonly Departure[];
  departureBoard: DepartureBoard | null;
  network: TransitNetwork;
  /** The feed's clock, which is what every countdown on this board is counted from. */
  feedNow: number;
  /**
   * The lines being read together, where the rider has bundled the corridor. Every trip of them
   * reads as the selection, and a row tapped inside the bundle opens inside it.
   */
  lineSelection?: LineSelection;
  selectedDepartureId?: string;
  /**
   * What this stop has been observed to do, which is how the line reading relates its trips to each
   * other. Without it that reading still stands, gathering each line's trips under their headsigns
   * rather than under the places they head into.
   */
  corridorPatterns: StopCorridorPatterns;
  /** A stacked layout caps the list; a panel of its own shows the whole board and scrolls it. */
  isStacked?: boolean;
  /**
   * The stop's own menu, rendered at this board's foot rather than beside it: both of its halves —
   * the Linien toggle and what KVV announced about this stop — answer questions about the board
   * above them, so they stay beneath its scrollport and cannot be scrolled past.
   */
  bottomMenu?: ReactNode;
};

/**
 * When the vehicle leaves, and — only where a deviation moved it — the schedule it was moved off.
 *
 * One published time, so the row and its countdown answer with the same minute. The struck schedule
 * is evidence, not a second reading: nothing here has to be added up.
 */ function DepartureTime({ reading }: { reading: DepartureTimeReading }) {
  return (
    <span className="departure-time">
      <span className={classNames("departure-expected-time", reading.punctuality)}>
        {reading.expectedTime}
      </span>
      {reading.scheduledTime && <s className="departure-scheduled-time">{reading.scheduledTime}</s>}
    </span>
  );
}

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
  joinedTrip,
}: {
  departure: Departure;
  /** The next observed trip over the same route, stated only when this one is cancelled. */
  nextCompatibleDeparture?: Departure;
  line: TransitLine;
  stopId: string;
  /** The lines being read together, so a row tapped inside a bundle stays inside it. */
  lineSelection: LineSelection | undefined;
  /** Its platform, printed on the row only where no heading above it already states one. */
  showsPlatform: boolean;
  /** A high-confidence shared consist inferred from two complete route readings. */
  joinedTrip?: JoinedTripPortionPair;
  /**
   * Where the row stands in what it is being read within, which is the only thing its entrance
   * needs: a board settles from the top down, in reading order, rather than all at once.
   */
  index: number;
  /** This row is the selection: the pinned trip, or any trip of the line when none is pinned. */
  isSelected: boolean;
  /** This row is the one trip the address names, so tapping it again steps back up to the line. */
  isPinned: boolean;
  feedNow: number;
}) {
  // One gesture, one address, at every width: a row refines the chain to the trip it names and the
  // board stays in view. Sending a narrow viewport straight to the ride instead meant the same tap
  // produced a different URL by window width, so a link shared from a phone and one shared from a
  // desktop were different places. Where the ride is what the rider wants, the diagram this opens
  // carries the control that starts it.
  const timeReading = getDepartureTimeReading(departure);
  const vehicleAccessLabel = findVehicleAccessLabel(departure);
  const nextCompatibleReading = nextCompatibleDeparture
    ? getCountdownReading(nextCompatibleDeparture, feedNow)
    : undefined;
  const nextCompatibleLabel =
    nextCompatibleReading?.kind === "minutes"
      ? `${nextCompatibleReading.minutes} min`
      : nextCompatibleReading?.label;
  const isTerminatingPortion = joinedTrip && isSameVehicleTrip(departure, joinedTrip.terminating);
  const joinedLabel = joinedTrip
    ? isTerminatingPortion
      ? `Gemeinsam bis ${joinedTrip.terminating.destination} · weiterer Zugteil nach ${joinedTrip.continuing.destination}`
      : `Gemeinsam bis ${joinedTrip.terminating.destination}`
    : undefined;

  return (
    <button
      className={classNames(
        "departure",
        isSelected && "selected",
        isPinned && "pinned",
        departure.status === "cancelled" && "cancelled",
        departure.status === "diverted" && "diverted",
        joinedTrip && "joined-trip-portion",
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
        {/* The countdown column already says "entfällt" in the largest type in the row, and a
            deviation is already the published time — only what neither states is worded here. */}
        {departure.status !== "cancelled" && getDepartureStatusLabel(departure)}
        {/* Only where the operator says this vehicle is *not* step-free — the rare row a rider with
            a wheelchair, a pram or a suitcase has to see, and the one thing on the row they cannot
            tell from the platform. The step-free norm is spoken in the row's label rather than
            printed nineteen times over the exception. A word, never a mark or a colour alone. */}
        {departure.status !== "cancelled" && vehicleAccessLabel && (
          <span className="departure-access">{vehicleAccessLabel}</span>
        )}
        {showsPlatform && (
          <b>{formatPlatformName(departure.platformName, departure.platformKind)}</b>
        )}
      </span>
    </button>
  );
}

/**
 * The three orders a departure board is read in, and nothing else.
 *
 * A rider glancing at a stop wants what leaves next, in the order it leaves — that is the board. A
 * rider standing at a stop with six platforms wants what leaves from the one they are on. A rider
 * who knows they want the 2 wants to see where the 2 goes from here and when the next two of them
 * are. All three are the same departures: nothing is hidden, nothing is re-sorted, the rows are
 * only gathered differently — which is why this is a switch between orders and not a filter, and
 * why the third of them is here rather than in a panel of its own listing the same trips again.
 *
 * The halves are named for what the board is ordered by: `Zeit`, `Steig` and `Linie` are a set a
 * rider reads as when-where-which. `Steig` is the root shared by Bahnsteig and Bussteig, so it is
 * true above a board holding Gleise and Bussteige at once without picking one of their words — and
 * it is what the rider reads on the sign they are walking towards, which is this order's whole job.
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

/**
 * The departures leaving from one platform, under the platform's own signpost.
 *
 * Nothing is hidden and nothing is re-sorted: this is the same board read a second way, so the
 * rows inside a group stay in the order they leave in.
 */
function PlatformGroup({
  group,
  renderRow,
}: {
  group: DeparturePlatformGroup;
  renderRow: (departure: Departure, index: number) => ReactNode;
}) {
  const { word, code } = getPlatformHeadingParts(group.platformName, group.platformKind);
  return (
    <section
      className="departure-board-platform-group"
      aria-label={formatSpokenPlatformHeading(group.platformName, group.platformKind)}
    >
      {/* A signpost, not a title: the code is the glyph the rider matches against the sign they
          are walking towards, and the operator's word is its caption. */}
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
  selectedDepartureId,
  corridorPatterns,
  isStacked = false,
  bottomMenu,
}: DepartureBoardPanelProps) {
  // The shell keys this panel by stop, so another board arrives as a fresh glance rather than a
  // continuation of this one — the collapse does not have to watch for the stop itself.
  const [isExpanded, setIsExpanded] = useState(false);
  // Read from the shared preference rather than held here: the board request depends on it too, and
  // a copy of it in this panel would leave the two disagreeing about what was asked for.
  const departureOrder = useDepartureBoardOrder();
  const departureListRef = useRef<HTMLDivElement>(null);
  useTransientScrollbar(departureListRef);
  const isGroupedByPlatform = departureOrder === "platform";
  const isGroupedByLine = departureOrder === "line";
  // A panel of its own scrolls: capping it there hid two thirds of a board the feed had already
  // answered, behind a click, on a screen with room for all of it.
  const visibleDepartures = useMemo(
    () => (!isStacked || isExpanded ? departures : departures.slice(0, STACKED_DEPARTURE_LIMIT)),
    [departures, isExpanded, isStacked],
  );
  const collapsedCount = isStacked ? Math.max(0, departures.length - STACKED_DEPARTURE_LIMIT) : 0;
  // Grouping the departures already on screen rather than the whole board: either way the board
  // shows the next few departures, and a cap that changed with the order would be a second board.
  const platformGroups = useMemo(
    () => (isGroupedByPlatform ? groupDeparturesByPlatform(visibleDepartures) : []),
    [isGroupedByPlatform, visibleDepartures],
  );
  // The same departures the other two orders show, related to one another by what this stop has been
  // observed to do. It is the board's own rows throughout — no second request, and nothing on screen
  // that the time order does not also hold.
  const lineGroups = useMemo(
    () =>
      isGroupedByLine ? getStopServiceCorridorLineGroups(visibleDepartures, corridorPatterns) : [],
    [corridorPatterns, isGroupedByLine, visibleDepartures],
  );
  const staleLabel = findStaleBoardLabel(departureBoard, feedNow);
  const joinedPairs = useMemo(
    () => getJoinedTripPortionPairs(completedLineDepartures),
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
      isSelected={isDepartureSelected(departure, selectedDepartureId, lineSelection)}
      isPinned={selectedDepartureId === departure.id}
      feedNow={feedNow}
      // In grouped order the heading above the row already names its platform.
      showsPlatform={!isGroupedByPlatform}
      joinedTrip={findJoinedTripPortionPair(departure, joinedPairs)}
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
          <DepartureOrderControl order={departureOrder} onOrderChange={writeDepartureBoardOrder} />
          <DepartureBoardStatusChip departureBoard={departureBoard} feedNow={feedNow} />
        </div>
      </div>

      {/* A board that cannot be refreshed still says something true — as long as it says how old it
          is. Stated in full, never implied by a dimmed row. */}
      {staleLabel && (
        <p className="departure-board-stale" role="status">
          {staleLabel}
        </p>
      )}

      <div
        ref={departureListRef}
        className="departure-board-list"
        aria-busy={departureBoard === null}
      >
        {isGroupedByPlatform ? (
          platformGroups.map((group) => (
            <PlatformGroup key={group.platformName} group={group} renderRow={renderRow} />
          ))
        ) : isGroupedByLine ? (
          <DepartureBoardLineOrder
            groups={lineGroups}
            stopId={stop.id}
            lineSelection={lineSelection}
            selectedDepartureId={selectedDepartureId}
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
                ? `Liste auf ${STACKED_DEPARTURE_LIMIT} Abfahrten verkürzen`
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
