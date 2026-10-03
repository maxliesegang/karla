import type {
  DepartureBoard,
  DepartureBoardCoverage,
  ServiceNoticeBoard,
} from "../data/transit-types";
import { formatClockTime } from "../lib/departure-presentation";
import { navigateTo, routePaths } from "../routing";

/**
 * Provenance in every state: the source left, its condition right. Also links the full notice
 * list, a reference rather than a step in a journey.
 */
export function DataProvenanceFooter({
  departureBoard,
  departureBoards,
  coverage,
  serviceNoticeBoard,
  showsNoticesLink = false,
}: {
  departureBoard?: DepartureBoard | null;
  /** Several posts describe the Zentrum; the oldest live timestamp is stated. */
  departureBoards?: readonly DepartureBoard[];
  coverage?: DepartureBoardCoverage;
  /** Only on the notices view; null while loading. */
  serviceNoticeBoard?: ServiceNoticeBoard | null;
  /** Omitted on the notices view itself. */
  showsNoticesLink?: boolean;
}) {
  if (serviceNoticeBoard !== undefined) {
    const statusLabel =
      serviceNoticeBoard === null
        ? "Meldungen werden geladen …"
        : serviceNoticeBoard.dataStatus === "unavailable"
          ? `Meldungen nicht erreichbar${serviceNoticeBoard.errorMessage ? ` — ${serviceNoticeBoard.errorMessage}` : ""}`
          : `Meldungen · Stand ${formatClockTime(new Date(serviceNoticeBoard.receivedAt))}`;
    return (
      <footer className="data-provenance-footer">
        <span>KVV · {statusLabel}</span>
      </footer>
    );
  }

  // Home reads no board, so the footer names the source without claiming a load.
  const hasReadingInView = departureBoard !== undefined || departureBoards !== undefined;
  const relevantDepartureBoards = departureBoards ?? (departureBoard ? [departureBoard] : []);
  const isLoading =
    departureBoard === null || (departureBoards !== undefined && departureBoards.length === 0);
  const unavailableDepartureBoard = relevantDepartureBoards.find(
    (board) => board.dataStatus === "unavailable",
  );
  const oldestLiveBoard = relevantDepartureBoards
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
              : unavailableDepartureBoard && !oldestLiveBoard
                ? `nicht erreichbar${unavailableDepartureBoard.errorMessage ? ` — ${unavailableDepartureBoard.errorMessage}` : ""}`
                : unavailableDepartureBoard && oldestLiveBoard
                  ? `teilweise erreichbar · ältester Stand ${formatClockTime(oldestLiveBoard.feedUpdatedAt)}`
                  : oldestLiveBoard
                    ? `Stand ${formatClockTime(oldestLiveBoard.feedUpdatedAt)}`
                    : "wird geladen …";

  return (
    <footer className="data-provenance-footer">
      <span>KVV · {statusLabel}</span>
      {showsNoticesLink && (
        <button
          type="button"
          className="footer-notices-link"
          onClick={() => navigateTo(routePaths.notices())}
        >
          Alle Meldungen des KVV
        </button>
      )}
    </footer>
  );
}
