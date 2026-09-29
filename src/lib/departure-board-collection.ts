import type { DepartureBoard, DepartureBoardCoverage } from "../data/transit-types";

/**
 * Whether this board is a failed refresh: nothing could be read, or the source kept the last live
 * board in its place (`refreshFailedAt`). Either way the cadence backs off and coverage says so.
 */
export const isFailedBoard = (board: DepartureBoard): boolean =>
  board.dataStatus === "unavailable" || board.refreshFailedAt !== undefined;

export function getDepartureBoardCoverage(
  stopIds: readonly string[],
  loaded: readonly DepartureBoard[] | undefined | null,
): DepartureBoardCoverage {
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
