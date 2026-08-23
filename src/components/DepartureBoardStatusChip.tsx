import type { DepartureBoard } from "../data/transit-types";
import { getBoardAgeMs } from "../lib/feed-clock";

/** Past this the board needs an explicit stale warning. */
const STALE_BOARD_MS = 3 * 60_000;

/**
 * Fresh data needs no badge. Loading, stale, and unavailable states still need to be visible.
 */
export function DepartureBoardStatusChip({
  departureBoard,
  feedNow,
}: {
  departureBoard: DepartureBoard | null;
  feedNow: number;
}) {
  if (!departureBoard)
    return (
      <span className="chip chip-muted">
        <i />
        lädt
      </span>
    );
  if (departureBoard.dataStatus !== "live")
    return (
      <span className="chip chip-muted">
        <i />
        nicht verfügbar
      </span>
    );
  return getBoardAgeMs(departureBoard, feedNow) > STALE_BOARD_MS ? (
    <span className="chip chip-watch">
      <i />
      nicht aktuell
    </span>
  ) : null;
}
