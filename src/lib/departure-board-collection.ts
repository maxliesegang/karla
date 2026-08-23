import type { DepartureBoard, DepartureBoardCoverage } from "../data/transit-types";

/** Past this the retained board is too old to act on and the failure becomes the answer. */
export const RETAINED_BOARD_LIMIT_MS = 10 * 60_000;

export function getDepartureBoardCoverage(
  stopIds: readonly string[],
  loaded: readonly DepartureBoard[] | undefined | null,
): DepartureBoardCoverage {
  const expectedBoardCount = stopIds.length;
  const liveBoardCount = (loaded ?? []).filter((board) => board.dataStatus === "live").length;
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

/**
 * Builds the usable multi-board reading while retaining each observation post independently.
 * The returned map is a fresh value so callers can keep it without sharing mutable state.
 */
export function buildRetainedDepartureBoards(
  stopIds: readonly string[],
  loaded: readonly DepartureBoard[] | undefined | null,
  previousLiveBoardByStopId: ReadonlyMap<string, DepartureBoard>,
): { departureBoards: readonly DepartureBoard[]; liveBoardByStopId: Map<string, DepartureBoard> } {
  const liveBoardByStopId = new Map<string, DepartureBoard>();
  for (const stopId of stopIds) {
    const previous = previousLiveBoardByStopId.get(stopId);
    if (previous) liveBoardByStopId.set(stopId, previous);
  }
  for (const board of loaded ?? []) {
    if (board.dataStatus === "live") liveBoardByStopId.set(board.stopId, board);
  }

  const loadedBoardByStopId = new Map((loaded ?? []).map((board) => [board.stopId, board]));
  const departureBoards = stopIds.flatMap((stopId) => {
    const current = loadedBoardByStopId.get(stopId);
    if (!current) return [];
    if (current.dataStatus === "live") return [current];

    const retained = liveBoardByStopId.get(stopId);
    return retained && current.receivedAt - retained.receivedAt <= RETAINED_BOARD_LIMIT_MS
      ? [retained]
      : [current];
  });
  return { departureBoards, liveBoardByStopId };
}
