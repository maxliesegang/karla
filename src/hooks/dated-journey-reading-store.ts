import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { transitSource } from "../data/transit-source";
import type { StopEvent, StopEventBoard } from "../data/transit-types";

/**
 * A version string for the view's dated journeys; a primitive is a stable `useSyncExternalStore`
 * snapshot.
 */
function useDatedJourneyReadingVersion(rowIds: readonly string[]): string {
  const subscribe = useCallback(
    (listener: () => void) => transitSource.subscribeToDatedJourneys(rowIds, listener),
    [rowIds],
  );
  const getVersion = useCallback(() => transitSource.getDatedJourneyVersion(rowIds), [rowIds]);
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}

/** The dated journeys behind these rows, from the `DatedJourneyReadingStore`. Memoize `rowIds`. */
export function useDatedJourneys(rowIds: readonly string[]): readonly StopEvent[] {
  const version = useDatedJourneyReadingVersion(rowIds);
  return useMemo(
    () =>
      rowIds.flatMap((rowId) => {
        const datedJourney = transitSource.findDatedJourney(rowId);
        return datedJourney ? [datedJourney] : [];
      }),
    // The version is the whole of the dependency on the store.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [rowIds, version],
  );
}

const NO_BOARDS: readonly StopEventBoard[] = [];
const NO_ROW_IDS: readonly string[] = [];

/**
 * `departure` while there is one, else the dated journey last seen under `key`, from the store:
 * keeps a dated journey while nothing lists it (a re-keyed board, a departed ride). A new `key`
 * holds nothing.
 */
export function useHeldDatedJourney(
  key: string | undefined,
  stopEvent: StopEvent | undefined,
): StopEvent | undefined {
  const [held, setHeld] = useState<{ key: string; rowId: string } | null>(null);
  if (key !== undefined && stopEvent && (held?.key !== key || held.rowId !== stopEvent.id)) {
    setHeld({ key, rowId: stopEvent.id });
  }
  const heldRowId = key !== undefined && held?.key === key ? held.rowId : undefined;
  const rowIds = useMemo(
    () => (!stopEvent && heldRowId ? [heldRowId] : NO_ROW_IDS),
    [stopEvent, heldRowId],
  );
  const [datedJourney] = useDatedJourneys(rowIds);
  return stopEvent ?? datedJourney;
}

/** These boards with every row as the store reads it now; every board hook passes through here. */
export function useLiveBoards(boards: readonly StopEventBoard[]): readonly StopEventBoard[] {
  const rowIds = useMemo(
    () => boards.flatMap((board) => board.stopEvents.map(({ id }) => id)),
    [boards],
  );
  const version = useDatedJourneyReadingVersion(rowIds);
  return useMemo(
    () => {
      const live = boards.map((board) => transitSource.resolveBoard(board));
      return live.every((board, index) => board === boards[index]) ? boards : live;
    },
    // The version is the whole of the dependency on the store, as in `useDatedJourneys`.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [boards, version],
  );
}

/** One board, read through `useLiveBoards`. */
export function useLiveBoard(board: StopEventBoard | null): StopEventBoard | null {
  const boards = useMemo(() => (board ? [board] : NO_BOARDS), [board]);
  return useLiveBoards(boards)[0] ?? null;
}
