import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
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
const NO_ROW_IDS: readonly string[] = [];

/**
 * `departure` while there is one; otherwise the run last seen under `key`, read back from the store.
 *
 * This is how a view keeps a run across a moment nothing lists it — a board re-keyed by a step along
 * the line, or a ride whose run has left every board. Only the id is held; the reading is always the
 * store's. A new `key` holds nothing until a departure is seen under it.
 */
export function useHeldRun(
  key: string | undefined,
  departure: Departure | undefined,
): Departure | undefined {
  const [held, setHeld] = useState<{ key: string; rowId: string } | null>(null);
  if (key !== undefined && departure && (held?.key !== key || held.rowId !== departure.id)) {
    setHeld({ key, rowId: departure.id });
  }
  const heldRowId = key !== undefined && held?.key === key ? held.rowId : undefined;
  const rowIds = useMemo(
    () => (!departure && heldRowId ? [heldRowId] : NO_ROW_IDS),
    [departure, heldRowId],
  );
  const [run] = useRuns(rowIds);
  return departure ?? run;
}

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
