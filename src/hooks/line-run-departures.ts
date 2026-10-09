import { useEffect, useMemo, useState } from "react";
import { transitSource } from "../data/transit-source";
import type { Departure, DepartureBoard } from "../data/transit-types";
import {
  areFollowedRunsEqual,
  getLineRunDepartures,
  selectPlaceableRuns,
  updateFollowedRuns,
  type FollowedRun,
} from "../lib/line-run-departures";
import { getFeedOffsetMs } from "../lib/feed-clock";
import { getRunMarkKey } from "../lib/trips";
import { useDeviceNow, useVehicleFeedNow } from "./clock";
import { useRunReadingsByRowId } from "./run-reading-loader";

const findRun = (rowId: string) => transitSource.findRun(rowId);

/**
 * The runs a line view draws: current rows plus runs boards stopped listing, followed by id until
 * they end. A run is first handed over only once its calls are fresh (`selectPlaceableRuns`).
 */
export function useLineRunDepartures(
  lineId: string,
  observedDepartures: readonly Departure[],
  departureBoard: DepartureBoard | null,
  isRide: boolean,
  {
    includesRun,
    refreshOnEntry = true,
    animatesVehicles = true,
    runMaxAgeMs,
    readsBeforeMerges = false,
  }: {
    includesRun?: (run: Departure, feedNow: number) => boolean;
    refreshOnEntry?: boolean;
    animatesVehicles?: boolean;
    runMaxAgeMs?: number;
    /** Re-read each run shortly before it leaves for a merge (`useRunReadingsByRowId`). */
    readsBeforeMerges?: boolean;
  } = {},
): { runDepartures: readonly Departure[]; feedNow: number } {
  const [following, setFollowing] = useState<{
    lineId: string;
    followed: readonly FollowedRun[];
  }>({ lineId, followed: [] });
  const followed = useMemo(
    () => (following.lineId === lineId ? following.followed : []),
    [following, lineId],
  );
  const followedRowIds = useMemo(() => followed.map(({ rowId }) => rowId), [followed]);
  // Followed runs are re-read on their own cadence; answers land in the store.
  const feedOffsetMs = getFeedOffsetMs(departureBoard);
  const mergeReads = useMemo(
    () => (readsBeforeMerges ? { feedOffsetMs } : undefined),
    [readsBeforeMerges, feedOffsetMs],
  );
  const followedRuns = useRunReadingsByRowId(followedRowIds, {
    refreshOnEntry,
    maxAgeMs: runMaxAgeMs,
    readsBeforeMerges: mergeReads,
  });
  const feedNow = useVehicleFeedNow(
    observedDepartures.length > 0 || followed.length > 0 || isRide,
    departureBoard,
    { isAnimated: animatesVehicles },
  );

  // The followed set accumulates across boards, so it is state, set only when it changes. Compared
  // before setting, not in an updater, since even a no-op updater queues a render.
  const update = (observed: readonly Departure[]) => {
    const scopedFindRun = (rowId: string) => {
      const run = findRun(rowId);
      return run && (!includesRun || includesRun(run, feedNow)) ? run : undefined;
    };
    const next = updateFollowedRuns(
      followed,
      includesRun ? observed.filter((run) => includesRun(run, feedNow)) : observed,
      feedNow,
      scopedFindRun,
    );
    if (following.lineId !== lineId || !areFollowedRunsEqual(next, followed)) {
      setFollowing({ lineId, followed: next });
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect
  useEffect(() => update(observedDepartures), [lineId, observedDepartures]);
  // A feed tick only drops runs that have ended; it must not re-read the same board.
  // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect
  useEffect(() => update([]), [feedNow]);

  // Memoized on content, not the tick, so drawings are not handed a new set every second. A run
  // turns fresh only when its re-read lands, which changes the content.
  const deviceNow = useDeviceNow();
  const [handedOverKeys, setHandedOverKeys] = useState<ReadonlySet<string>>(() => new Set());
  const scopeNow = includesRun ? feedNow : 0;
  const runDepartures = useMemo(
    () => {
      const runs = getLineRunDepartures(followed, observedDepartures, feedNow, findRun);
      return selectPlaceableRuns(
        includesRun ? runs.filter((run) => includesRun(run, feedNow)) : runs,
        deviceNow,
        handedOverKeys,
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [followed, observedDepartures, followedRuns, handedOverKeys, includesRun, scopeNow],
  );
  useEffect(() => {
    const keys = runDepartures.map(getRunMarkKey);
    if (keys.length !== handedOverKeys.size || keys.some((key) => !handedOverKeys.has(key))) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHandedOverKeys(new Set(keys));
    }
  }, [runDepartures, handedOverKeys]);

  return { runDepartures, feedNow };
}
