import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { transitSource } from "../data/transit-source";
import type { Departure, DepartureBoard } from "../data/transit-types";

/**
 * A version string for the view's runs; a primitive is a stable `useSyncExternalStore` snapshot.
 */
function useRunReadingVersion(rowIds: readonly string[]): string {
  const subscribe = useCallback(
    (listener: () => void) => transitSource.subscribeToRuns(rowIds, listener),
    [rowIds],
  );
  const getVersion = useCallback(() => transitSource.getRunVersion(rowIds), [rowIds]);
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}

/** The runs behind these rows, from the `RunReadingStore`. Memoize `rowIds`. */
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
 * `departure` while there is one, else the run last seen under `key`, from the store: keeps a run
 * while nothing lists it (a re-keyed board, a departed ride). A new `key` holds nothing.
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

/** These boards with every row as the store reads it now; every board hook passes through here. */
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
