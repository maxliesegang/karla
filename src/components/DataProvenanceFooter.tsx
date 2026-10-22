import type { StopEventBoard, StopEventBoardCoverage } from "../data/transit-types";
import { formatClockTime } from "../lib/stop-event-presentation";

/** Data source, reading status and provider disclaimer. */
export function DataProvenanceFooter({
  stopEventBoard,
  stopEventBoards,
  coverage,
}: {
  stopEventBoard?: StopEventBoard | null;
  /** Several posts describe the Zentrum; the oldest live timestamp is stated. */
  stopEventBoards?: readonly StopEventBoard[];
  coverage?: StopEventBoardCoverage;
}) {
  // Home reads no board, so the footer names the source without claiming a load.
  const hasReadingInView = stopEventBoard !== undefined || stopEventBoards !== undefined;
  const relevantStopEventBoards = stopEventBoards ?? (stopEventBoard ? [stopEventBoard] : []);
  const isLoading =
    stopEventBoard === null || (stopEventBoards !== undefined && stopEventBoards.length === 0);
  const unavailableStopEventBoard = relevantStopEventBoards.find(
    (board) => board.dataStatus === "unavailable",
  );
  const oldestLiveBoard = relevantStopEventBoards
    .filter((board) => board.dataStatus === "live")
    .sort((a, b) => Date.parse(a.feedUpdatedAt) - Date.parse(b.feedUpdatedAt))[0];

  const statusLabel = !hasReadingInView
    ? "Live-Abfahrten"
    : coverage?.status === "loading"
      ? "wird geladen …"
      : coverage?.status === "unavailable" && oldestLiveBoard
        ? `nicht erreichbar · letzter Stand ${formatClockTime(oldestLiveBoard.feedUpdatedAt)}`
        : coverage?.status === "unavailable"
          ? "nicht erreichbar"
          : coverage?.status === "partial" && oldestLiveBoard
            ? // Coverage is a fact about the source.
              `teilweise erreichbar · aus ${coverage.liveBoardCount} von ${coverage.expectedBoardCount} Haltestellen · ältester Stand ${formatClockTime(oldestLiveBoard.feedUpdatedAt)}`
            : isLoading
              ? "wird geladen …"
              : unavailableStopEventBoard && !oldestLiveBoard
                ? `nicht erreichbar${unavailableStopEventBoard.errorMessage ? ` — ${unavailableStopEventBoard.errorMessage}` : ""}`
                : unavailableStopEventBoard && oldestLiveBoard
                  ? `teilweise erreichbar · ältester Stand ${formatClockTime(oldestLiveBoard.feedUpdatedAt)}`
                  : oldestLiveBoard
                    ? `Stand ${formatClockTime(oldestLiveBoard.feedUpdatedAt)}`
                    : "wird geladen …";

  return (
    <footer className="data-provenance-footer">
      <span>Kein offizielles KVV-Angebot · {statusLabel}</span>
    </footer>
  );
}
