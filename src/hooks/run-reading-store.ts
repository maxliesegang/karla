import { useCallback, useMemo, useSyncExternalStore } from "react";
import { transitSource } from "../data/transit-source";
import type { Departure, DepartureBoard } from "../data/transit-types";

/**
 * The version of the run readings one view uses: a string, because `useSyncExternalStore` compares
 * snapshots by identity and a primitive is stable by construction.
 */
export function useRunReadingVersion(rowIds: readonly string[]): string {
  const subscribe = useCallback(
    (listener: () => void) => transitSource.subscribeToRuns(rowIds, listener),
    [rowIds],
  );
  const getVersion = useCallback(() => transitSource.getRunVersion(rowIds), [rowIds]);
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}

/**
 * The runs behind these rows, read from the source's `RunReadingStore`.
 * Memoize `rowIds`: they are the identity of everything read from the result.
 */
export function useRuns(rowIds: readonly string[]): readonly Departure[] {
  const version = useRunReadingVersion(rowIds);
  return useMemo(
    () =>
      rowIds.flatMap((rowId) => {
        const run = transitSource.findRun(rowId);
        return run ? [run] : [];
      }),
    // The version is the whole of the dependency on the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rowIds, version],
  );
}

const NO_BOARDS: readonly DepartureBoard[] = [];

/**
 * These boards with every row as the store reads it now.
 *
 * A board is a snapshot of which runs a stop listed; a run re-read after the board was fetched is
 * news on every board that lists it. Every board hook hands its boards out through here, so no view
 * ever holds a row it has to look up again.
 */
export function useLiveBoards(boards: readonly DepartureBoard[]): readonly DepartureBoard[] {
  const rowIds = useMemo(
    () => boards.flatMap((board) => board.departures.map(({ id }) => id)),
    [boards],
  );
  const version = useRunReadingVersion(rowIds);
  return useMemo(
    () => {
      const live = boards.map((board) => transitSource.resolveBoard(board));
      return live.every((board, index) => board === boards[index]) ? boards : live;
    },
    // The version is the whole of the dependency on the store, as in `useRuns`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [boards, version],
  );
}

/** One board, read through `useLiveBoards`. */
export function useLiveBoard(board: DepartureBoard | null): DepartureBoard | null {
  const boards = useMemo(() => (board ? [board] : NO_BOARDS), [board]);
  return useLiveBoards(boards)[0] ?? null;
}
