import { useCallback, useMemo, useSyncExternalStore } from "react";
import { transitSource } from "../data/transit-source";
import type { Departure } from "../data/transit-types";

/**
 * The version of the run readings one view actually uses.
 *
 * A version rather than the readings themselves. `useSyncExternalStore` compares what it is given
 * by identity, so a snapshot assembled per call would be a new object every render and never
 * settle; a primitive version is stable by construction and says exactly what a subscriber needs
 * to know — whether one of its runs has been read since it last looked.
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
 * The runs behind these rows, as everything read so far describes them.
 *
 * A view holds the *ids* of the runs it is following and reads the runs through this, so a sequence
 * read for one view — the ride re-reading itself, a diagram re-reading its marks — is on every
 * other view's next paint. Nothing is copied into view state on the way, so no two views can be
 * showing two different states of one tram.
 *
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
    // The version is the whole of the dependency on the store: nothing here reads anything else
    // from it, and every change to it bumps this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rowIds, version],
  );
}
