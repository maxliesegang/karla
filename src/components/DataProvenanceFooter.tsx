import type {
  DepartureBoard,
  DepartureBoardCoverage,
  ServiceNoticeBoard,
} from "../data/transit-types";
import { formatClockTime } from "../lib/departure-presentation";
import { navigateTo, routePaths } from "../routing";

/**
 * Provenance is stated in every state: the source on the left, its condition on the right.
 *
 * The full notice list is reached from here. It is a reference work, not a step in anyone's journey
 * — most riders should meet a notice filtered to the stop they are standing at, under the board it
 * concerns (W7) — so it keeps its address and sits with the other statements about where the data
 * came from, rather than costing a control in the bar on every screen (E3, F7).
 */
export function DataProvenanceFooter({
  departureBoard,
  departureBoards,
  coverage,
  serviceNoticeBoard,
  showsNoticesLink = false,
}: {
  departureBoard?: DepartureBoard | null;
  /** Several observation posts describe the Zentrum; the oldest live timestamp is the honest stand. */
  departureBoards?: readonly DepartureBoard[];
  coverage?: DepartureBoardCoverage;
  /** Present only on the dedicated notice view; null means that feed is still loading. */
  serviceNoticeBoard?: ServiceNoticeBoard | null;
  /** Left off the notice view itself, which is already there. */
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

  const relevantDepartureBoards = departureBoards ?? (departureBoard ? [departureBoard] : []);
  const isLoading =
    departureBoard === null || (departureBoards !== undefined && departureBoards.length === 0);
  const unavailableDepartureBoard = relevantDepartureBoards.find(
    (board) => board.dataStatus === "unavailable",
  );
  const oldestLiveBoard = relevantDepartureBoards
    .filter((board) => board.dataStatus === "live")
    .sort((a, b) => Date.parse(a.feedUpdatedAt) - Date.parse(b.feedUpdatedAt))[0];

  const statusLabel =
    coverage?.status === "loading"
      ? "wird geladen …"
      : coverage?.status === "unavailable" && oldestLiveBoard
        ? `nicht erreichbar · letzter Stand ${formatClockTime(oldestLiveBoard.feedUpdatedAt)}`
        : coverage?.status === "unavailable"
          ? "nicht erreichbar"
          : coverage?.status === "partial" && oldestLiveBoard
            ? `teilweise erreichbar · ältester Stand ${formatClockTime(oldestLiveBoard.feedUpdatedAt)}`
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
