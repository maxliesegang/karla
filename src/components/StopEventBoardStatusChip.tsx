import type { StopEventBoard } from "../data/transit-types";
import { getBoardAgeMs } from "../lib/feed-clock";
import { classNames } from "../lib/class-names";

/** Past this the board needs an explicit stale warning. */
const STALE_BOARD_MS = 3 * 60_000;

/**
 * Fresh data needs no badge. Loading, stale, and unavailable states still need to be visible; the
 * last two ask again when tapped.
 */
export function StopEventBoardStatusChip({
  stopEventBoard,
  feedNow,
  onRefresh,
}: {
  stopEventBoard: StopEventBoard | null;
  feedNow: number;
  onRefresh?: () => void;
}) {
  if (!stopEventBoard)
    return (
      <span className="chip chip-muted">
        <i />
        lädt
      </span>
    );
  if (stopEventBoard.dataStatus !== "live")
    return (
      <RefreshableChip className="chip chip-muted" onRefresh={onRefresh}>
        nicht verfügbar
      </RefreshableChip>
    );
  return getBoardAgeMs(stopEventBoard, feedNow) > STALE_BOARD_MS ? (
    <RefreshableChip className="chip chip-watch" onRefresh={onRefresh}>
      nicht aktuell
    </RefreshableChip>
  ) : null;
}

function RefreshableChip({
  className,
  onRefresh,
  children,
}: {
  className: string;
  onRefresh: (() => void) | undefined;
  children: string;
}) {
  if (!onRefresh)
    return (
      <span className={className}>
        <i />
        {children}
      </span>
    );
  return (
    <button
      type="button"
      className={classNames(className, "chip-action")}
      aria-label={`Abfahrten ${children}, erneut laden`}
      onClick={onRefresh}
    >
      <i />
      {children}
      <b aria-hidden="true">↻</b>
    </button>
  );
}
