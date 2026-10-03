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
  formatPlatformLabel,
  getPlatformWord,
} from "../lib/platform-naming";
import {
  getPlatformLabel,
  isPlatformMatch,
  normalizePlatformCode,
  type StationBoardConfig,
} from "../station-board";
import { LineBadge } from "./LineBadge";
import { classNames } from "../lib/class-names";

/**
 * The unattended station board: read from metres away, untouched, on for weeks. It never scrolls or
 * offers controls, fills its screen exactly, and states its own age.
 */

/** How long each page of a board with more departures than rows stays up. */
const PAGE_DURATION_MS = 15_000;
/** Past this the board states its age at full size. */
const STALE_BOARD_MS = 3 * 60_000;

type StationBoardViewProps = {
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
  // An operating note outranks the route; neither is ever truncated away.
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
      {/* From afar a struck time looks broken, so only the expected time shows. */}
      <span className={classNames("station-board-time", timeReading?.punctuality)}>
        {timeReading?.expectedTime ?? "–"}
      </span>
      {/* On a whole-stop board the word captions the ambiguous code. */}
      <span className="station-board-platform">
        {stationBoardConfig.mode === "stop" && platformWord && <small>{platformWord}</small>}
        {departure.platformCode || "–"}
      </span>
      {/* Block-prefixed so it does not collide with the interactive board's column class. */}
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

export function StationBoardView({
  stop,
  departures,
  departureBoard,
  network,
  stationBoardConfig,
  feedNow,
}: StationBoardViewProps) {
  const { rowCount, platformCodes, mode, minimumMinutes, grouping } = stationBoardConfig;

  const platformDepartures = useMemo(
    () =>
      mode === "platform"
        ? departures.filter((departure) => isPlatformMatch(departure.platformCode, platformCodes))
        : departures,
    [departures, mode, platformCodes],
  );
  const matchingDepartures = useMemo(
    () =>
      platformDepartures.filter((departure) => {
        // A departure nobody can still reach is clutter.
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

  // Pages derived from the clock, not a timer, so nothing is kept in state for weeks.
  const pageCount = Math.max(1, Math.ceil(orderedDepartures.length / rowCount));
  const pageIndex = Math.floor(feedNow / PAGE_DURATION_MS) % pageCount;
  const visibleDepartures = orderedDepartures.slice(
    pageIndex * rowCount,
    pageIndex * rowCount + rowCount,
  );

  const ageMs = getBoardAgeMs(departureBoard, feedNow);
  const isStale = departureBoard?.dataStatus === "live" && ageMs > STALE_BOARD_MS;
  // A platform matching nothing is usually a URL typo, so list the platforms the feed reports.
  const reportedPlatformNames = useMemo(
    () =>
      groupDeparturesByPlatform(departures)
        .filter(({ platformCode }) => platformCode)
        // Named as the heading names them, ready to copy into the URL.
        .map(({ platformCode, platformKind }) => formatPlatformLabel(platformCode, platformKind)),
    [departures],
  );
  // The heading's word must suit every row; without the configured platform, read it off the rows.
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
              {formatPlatformLabel(getPlatformLabel(stationBoardConfig), platformKind)}
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
          {formatPlatformLabel(getPlatformLabel(stationBoardConfig), platformKind)} nicht im Feed
          <small>
            Gemeldet werden: {reportedPlatformNames.join(", ") || "keine Abfahrtsorte"}
            {reportedPlatformNames.some((name) => normalizePlatformCode(name)) &&
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
