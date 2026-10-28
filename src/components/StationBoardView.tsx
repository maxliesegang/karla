import { useMemo } from "react";
import { getJourneyEnds, getLineSign } from "../data/line-signs";
import type { StopEvent, StopEventBoard, StopPlace, TransitNetwork } from "../data/transit-types";
import {
  formatClockTime,
  getCountdownReading,
  getStopEventAccessibilityLabel,
  getDepartureTimeReading,
  getViaSummary,
} from "../lib/stop-event-presentation";
import { getBoardAgeMs, getCountdownMinutes } from "../lib/feed-clock";
import { groupStopEventsByBay } from "../lib/stop-event-order";
import { findSharedBayKind, formatBayText, getBayWord } from "../lib/bay-naming";
import { getBayText, isBayMatch, normalizeBay, type StationBoardConfig } from "../station-board";
import { LineBadge } from "./LineBadge";
import { classNames } from "../lib/class-names";
import { FEED_UNREADABLE_TEXT } from "./feed-copy";

/**
 * The unattended station board: read from metres away, untouched, on for weeks. It never scrolls or
 * offers controls, fills its screen exactly, and states its own age.
 */

/** How long each page of a board with more departures than rows stays up. */
const PAGE_DURATION_MS = 15_000;
/** Past this the board states its age at full size. */
const STALE_BOARD_MS = 3 * 60_000;

type StationBoardViewProps = {
  stop: StopPlace;
  stopEvents: readonly StopEvent[];
  stopEventBoard: StopEventBoard | null;
  network: TransitNetwork;
  stationBoardConfig: StationBoardConfig;
  feedNow: number;
};

function StationBoardRow({
  stopEvent,
  network,
  stationBoardConfig,
  feedNow,
}: {
  stopEvent: StopEvent;
  network: TransitNetwork;
  stationBoardConfig: StationBoardConfig;
  feedNow: number;
}) {
  const line = getLineSign(
    network.lines,
    stopEvent.lineId,
    stopEvent.ptMode,
    stopEvent.lineRef,
    getJourneyEnds(stopEvent),
  );
  const reading = getCountdownReading(stopEvent, feedNow);
  const timeReading = getDepartureTimeReading(stopEvent);
  // An operating note outranks the route; neither is ever truncated away.
  const bayWord = getBayWord(stopEvent.bayKind);
  const detail =
    stationBoardConfig.detail === "off"
      ? ""
      : stopEvent.serviceNote ||
        (stationBoardConfig.detail !== "note" ? getViaSummary(stopEvent) : "");

  return (
    <div
      className={classNames(
        "station-board-row",
        stopEvent.status === "cancelled" && "cancelled",
        stopEvent.status === "diverted" && "diverted",
      )}
      role="listitem"
      aria-label={getStopEventAccessibilityLabel(stopEvent, feedNow)}
    >
      <LineBadge line={line} />
      <span className="station-board-destination">
        <strong>{stopEvent.destinationText}</strong>
        {detail && <em>{detail}</em>}
      </span>
      {/* From afar a struck time looks broken, so only the expected time shows. */}
      <span className={classNames("station-board-time", timeReading?.punctuality)}>
        {timeReading?.expectedTime ?? "–"}
      </span>
      {/* On a whole-stop board the word captions the ambiguous code. */}
      <span className="station-board-platform">
        {stationBoardConfig.mode === "stop" && bayWord && <small>{bayWord}</small>}
        {stopEvent.bay || "–"}
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
  stopEvents,
  stopEventBoard,
  network,
  stationBoardConfig,
  feedNow,
}: StationBoardViewProps) {
  const { rowCount, bays, mode, minimumMinutes, grouping } = stationBoardConfig;

  const bayStopEvents = useMemo(
    () =>
      mode === "platform"
        ? stopEvents.filter((stopEvent) => isBayMatch(stopEvent.bay, bays))
        : stopEvents,
    [stopEvents, mode, bays],
  );
  const matchingStopEvents = useMemo(
    () =>
      bayStopEvents.filter((stopEvent) => {
        // A departure nobody can still reach is clutter.
        return (
          stopEvent.status === "cancelled" ||
          getCountdownMinutes(stopEvent, feedNow) >= minimumMinutes
        );
      }),
    [bayStopEvents, minimumMinutes, feedNow],
  );

  const orderedStopEvents = useMemo(
    () =>
      grouping === "platform"
        ? groupStopEventsByBay(matchingStopEvents).flatMap(({ stopEvents: group }) => group)
        : matchingStopEvents,
    [matchingStopEvents, grouping],
  );

  // Pages derived from the clock, not a timer, so nothing is kept in state for weeks.
  const pageCount = Math.max(1, Math.ceil(orderedStopEvents.length / rowCount));
  const pageIndex = Math.floor(feedNow / PAGE_DURATION_MS) % pageCount;
  const visibleStopEvents = orderedStopEvents.slice(
    pageIndex * rowCount,
    pageIndex * rowCount + rowCount,
  );

  const ageMs = getBoardAgeMs(stopEventBoard, feedNow);
  const isStale = stopEventBoard?.dataStatus === "live" && ageMs > STALE_BOARD_MS;
  // A bay matching nothing is usually a URL typo, so list the bays the feed reports.
  const reportedBayNames = useMemo(
    () =>
      groupStopEventsByBay(stopEvents)
        .filter(({ bay }) => bay)
        // Named as the heading names them, ready to copy into the URL.
        .map(({ bay, bayKind }) => formatBayText(bay, bayKind)),
    [stopEvents],
  );
  // The heading's word must suit every row; without the configured bay, read it off the rows.
  const bayKind = findSharedBayKind(bayStopEvents.length > 0 ? bayStopEvents : stopEvents);
  const hasBayMismatch =
    mode === "platform" &&
    stopEventBoard?.dataStatus === "live" &&
    stopEvents.length > 0 &&
    bayStopEvents.length === 0;

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
              {formatBayText(getBayText(stationBoardConfig), bayKind)}
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
          Stand {formatClockTime(stopEventBoard.feedUpdatedAt)} · seit {Math.floor(ageMs / 60_000)}{" "}
          Min ohne Aktualisierung
        </p>
      )}

      <div className="station-board-rows" role="list">
        {visibleStopEvents.map((stopEvent) => (
          <StationBoardRow
            key={stopEvent.id}
            stopEvent={stopEvent}
            network={network}
            stationBoardConfig={stationBoardConfig}
            feedNow={feedNow}
          />
        ))}
      </div>

      {stopEventBoard === null && (
        <p className="station-board-message">Abfahrten werden geladen …</p>
      )}
      {stopEventBoard?.dataStatus === "unavailable" && (
        <p className="station-board-message">
          Abfahrten nicht verfügbar
          <small>{stopEventBoard.errorMessage ?? FEED_UNREADABLE_TEXT}</small>
        </p>
      )}
      {hasBayMismatch && (
        <p className="station-board-message">
          {formatBayText(getBayText(stationBoardConfig), bayKind)} nicht im Feed
          <small>
            Gemeldet werden: {reportedBayNames.join(", ") || "keine Abfahrtsorte"}
            {reportedBayNames.some((name) => normalizeBay(name)) &&
              " — Konfiguration der Anzeige prüfen"}
          </small>
        </p>
      )}
      {stopEventBoard?.dataStatus === "live" &&
        !hasBayMismatch &&
        orderedStopEvents.length === 0 && (
          <p className="station-board-message">Keine weiteren Abfahrten</p>
        )}
    </section>
  );
}
