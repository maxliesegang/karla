import type { StopEventBoard, StopEventBoardCoverage } from "../data/transit-types";

/**
 * Whether this board is a failed refresh: nothing could be read, or the source kept the last live
 * board in its place (`refreshFailedAt`). Either way the cadence backs off and coverage says so.
 */
export const isFailedBoard = (board: StopEventBoard): boolean =>
  board.dataStatus === "unavailable" || board.refreshFailedAt !== undefined;

/**
 * How boards failed, for the refresh cadence. A refresh that failed while a live board stands in
 * (`refreshFailedAt`) is retried like a lost request, which it usually is; only a board with
 * nothing usable backs off as unavailable.
 */
export function getBoardsFailureKind(
  boards: readonly StopEventBoard[],
): "unavailable" | "transient" | undefined {
  if (boards.some((board) => board.dataStatus === "unavailable")) return "unavailable";
  return boards.some((board) => board.dataStatus === "live" && board.refreshFailedAt !== undefined)
    ? "transient"
    : undefined;
}

export function getStopEventBoardCoverage(
  stopIds: readonly string[],
  loaded: readonly StopEventBoard[] | undefined | null,
): StopEventBoardCoverage {
  const expectedBoardCount = stopIds.length;
  const liveBoardCount = (loaded ?? []).filter((board) => !isFailedBoard(board)).length;
  const status =
    expectedBoardCount === 0
      ? "complete"
      : loaded === null
        ? "loading"
        : liveBoardCount === expectedBoardCount
          ? "complete"
          : liveBoardCount === 0
            ? "unavailable"
            : "partial";
  return { status, expectedBoardCount, liveBoardCount };
}
