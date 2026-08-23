import { useMemo } from "react";
import { getLineSign } from "../data/line-signs";
import type { Departure, DepartureBoard, TransitStop, TransitNetwork } from "../data/transit-types";
import {
  formatClockTime,
  getCountdownReading,
  getDepartureAccessibilityLabel,
  getDepartureTimeReading,
  getViaSummary,
} from "../lib/departure-presentation";
import { getBoardAgeMs, getCountdownMinutes } from "../lib/feed-clock";
import { groupDeparturesByPlatform } from "../lib/departure-order";
import {
  findSharedPlatformKind,
  formatPlatformName,
  getPlatformWord,
} from "../lib/platform-naming";
import {
  getPlatformLabel,
  isPlatformMatch,
  normalizePlatformName,
  type StationBoardConfig,
} from "../routing";
import { LineBadge } from "./LineBadge";
import { classNames } from "../lib/class-names";

/**
 * The unattended station board.
 *
 * Read from three to ten metres by someone who will not touch it, on a screen that has been on for
 * weeks. That makes it a different component from the board a rider scrolls: it never scrolls,
 * never offers a control, fills its screen exactly, and states its own age rather than implying
 * freshness. Everything it shows has to survive being glanced at from across a hall.
 */

/** How long each page of a board with more departures than rows stays up. */
const PAGE_DURATION_MS = 15_000;
/** Past this the board says how old it is at full size, rather than in a footer nobody can read. */
const STALE_BOARD_MS = 3 * 60_000;

type StationBoardPanelProps = {
  stop: TransitStop;
  departures: readonly Departure[];
  departureBoard: DepartureBoard | null;
  network: TransitNetwork;
  stationBoardConfig: StationBoardConfig;
  feedNow: number;
};

function StationBoardRow({
  departure,
  network,
  stationBoardConfig,
  feedNow,
}: {
  departure: Departure;
  network: TransitNetwork;
  stationBoardConfig: StationBoardConfig;
  feedNow: number;
}) {
  const line = getLineSign(network.lines, departure.lineId, departure.transportMode);
  const reading = getCountdownReading(departure, feedNow);
  const timeReading = getDepartureTimeReading(departure);
  // An operating note is about this trip and outranks the route it takes; the route is what a rider
  // checks when nothing is wrong. Neither is ever truncated away — that is what hiding a diversion
  // would be.
  const platformWord = getPlatformWord(departure.platformKind);
  const detail =
    stationBoardConfig.detail === "off"
      ? ""
      : departure.serviceNote ||
        (stationBoardConfig.detail !== "note" ? getViaSummary(departure) : "");

  return (
    <div
      className={classNames(
        "station-board-row",
        departure.status === "cancelled" && "cancelled",
        departure.status === "diverted" && "diverted",
      )}
      role="listitem"
      aria-label={getDepartureAccessibilityLabel(departure, feedNow)}
    >
      <LineBadge line={line} />
      <span className="station-board-destination">
        <strong>{departure.destination}</strong>
        {detail && <em>{detail}</em>}
      </span>
      {/* Read from ten metres, a struck-through time reads as a broken screen, so the unattended
          board publishes the one time that answers the question and lets the countdown agree with
          it. The schedule it was moved off is a detail for the rider's own board. */}
      <span className={classNames("station-board-time", timeReading?.punctuality)}>
        {timeReading?.expectedTime ?? "–"}
      </span>
      {/* On a whole-stop board the code alone is ambiguous — `A` is a bus stand and `24` a track —
          so the feed's word captions it in quieter type above, leaving the code the glyph that is
          read from ten metres. A single-platform board states the word once in its heading instead. */}
      <span className="station-board-platform">
        {stationBoardConfig.mode === "stop" && platformWord && <small>{platformWord}</small>}
        {departure.platformName || "–"}
      </span>
      {/* The modifier carries the block's name: a bare `due` would collide with the interactive
          board's own column class, which is a grid cell in a different layout entirely. Only the
          readings that deviate from a plain minute count are styled — `entfällt` down to a size
          that fits the word, `jetzt` in the accent — but the modifier is written for all three, so
          the class always says which of the three the column is showing. */}
      <span
        className={classNames("station-board-countdown", `station-board-countdown-${reading.kind}`)}
      >
        {reading.kind === "minutes" ? (
          <>
            <strong>{reading.minutes}</strong>
            <small>min</small>
          </>
        ) : (
          <strong>{reading.label}</strong>
        )}
      </span>
    </div>
  );
}

export function StationBoardPanel({
  stop,
  departures,
  departureBoard,
  network,
  stationBoardConfig,
  feedNow,
}: StationBoardPanelProps) {
  const { rowCount, platformNames, mode, minimumMinutes, grouping } = stationBoardConfig;

  const platformDepartures = useMemo(
    () =>
      mode === "platform"
        ? departures.filter((departure) => isPlatformMatch(departure.platformName, platformNames))
        : departures,
    [departures, mode, platformNames],
  );
  const matchingDepartures = useMemo(
    () =>
      platformDepartures.filter((departure) => {
        // A departure a rider on the concourse can no longer reach is not information, it is clutter.
        return (
          departure.status === "cancelled" ||
          getCountdownMinutes(departure, feedNow) >= minimumMinutes
        );
      }),
    [platformDepartures, minimumMinutes, feedNow],
  );

  const orderedDepartures = useMemo(
    () =>
      grouping === "platform"
        ? groupDeparturesByPlatform(matchingDepartures).flatMap(({ departures: group }) => group)
        : matchingDepartures,
    [matchingDepartures, grouping],
  );

  // More departures than rows means paging, not hiding: every page is shown in turn, derived from
  // the clock rather than from a timer of its own, so nothing has to be kept in state for weeks.
  const pageCount = Math.max(1, Math.ceil(orderedDepartures.length / rowCount));
  const pageIndex = Math.floor(feedNow / PAGE_DURATION_MS) % pageCount;
  const visibleDepartures = orderedDepartures.slice(
    pageIndex * rowCount,
    pageIndex * rowCount + rowCount,
  );

  const ageMs = getBoardAgeMs(departureBoard, feedNow);
  const isStale = departureBoard?.dataStatus === "live" && ageMs > STALE_BOARD_MS;
  // A platform that matches nothing is far more often a spelling in the URL than an empty platform,
  // so the board says which platforms the feed is actually reporting rather than blaming the feed.
  const reportedPlatformNames = useMemo(
    () =>
      groupDeparturesByPlatform(departures)
        .filter(({ platformName }) => platformName)
        // Named the way the heading names them, so the reading is the one to copy into the URL.
        .map(({ platformName, platformKind }) => formatPlatformName(platformName, platformKind)),
    [departures],
  );
  // A heading stands above every row on the board, so it may only use the word they all support;
  // where the configured platform is missing entirely, the board's own rows are what is left to
  // read a word off.
  const platformKind = findSharedPlatformKind(
    platformDepartures.length > 0 ? platformDepartures : departures,
  );
  const hasPlatformMismatch =
    mode === "platform" &&
    departureBoard?.dataStatus === "live" &&
    departures.length > 0 &&
    platformDepartures.length === 0;

  return (
    <section
      className="station-board"
      style={{ "--station-board-rows": rowCount } as React.CSSProperties}
      aria-labelledby="station-board-title"
    >
      <div className="station-board-heading">
        <h1 id="station-board-title">
          {stop.name}
          {mode === "platform" && (
            <span className="station-board-heading-platform">
              {formatPlatformName(getPlatformLabel(stationBoardConfig), platformKind)}
            </span>
          )}
        </h1>
        {pageCount > 1 && (
          <span className="station-board-page" aria-hidden="true">
            {pageIndex + 1}/{pageCount}
          </span>
        )}
      </div>

      {isStale && (
        <p className="station-board-stale" role="status">
          Stand {formatClockTime(departureBoard.feedUpdatedAt)} · seit {Math.floor(ageMs / 60_000)}{" "}
          Min ohne Aktualisierung
        </p>
      )}

      <div className="station-board-rows" role="list">
        {visibleDepartures.map((departure) => (
          <StationBoardRow
            key={departure.id}
            departure={departure}
            network={network}
            stationBoardConfig={stationBoardConfig}
            feedNow={feedNow}
          />
        ))}
      </div>

      {departureBoard === null && (
        <p className="station-board-message">Abfahrten werden geladen …</p>
      )}
      {departureBoard?.dataStatus === "unavailable" && (
        <p className="station-board-message">
          Abfahrten nicht verfügbar
          <small>
            {departureBoard.errorMessage ?? "Der KVV-Feed konnte nicht gelesen werden."}
          </small>
        </p>
      )}
      {hasPlatformMismatch && (
        <p className="station-board-message">
          {formatPlatformName(getPlatformLabel(stationBoardConfig), platformKind)} nicht im Feed
          <small>
            Gemeldet werden: {reportedPlatformNames.join(", ") || "keine Abfahrtsorte"}
            {reportedPlatformNames.some((name) => normalizePlatformName(name)) &&
              " — Konfiguration der Anzeige prüfen"}
          </small>
        </p>
      )}
      {departureBoard?.dataStatus === "live" &&
        !hasPlatformMismatch &&
        orderedDepartures.length === 0 && (
          <p className="station-board-message">Keine weiteren Abfahrten</p>
        )}
    </section>
  );
}
