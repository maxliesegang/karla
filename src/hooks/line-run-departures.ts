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
  const followedRuns = useRunReadingsByRowId(followedRowIds);
  const feedNow = useVehicleFeedNow(
    observedDepartures.length > 0 || followed.length > 0 || isRide,
    departureBoard,
  );

  // The followed set accumulates across boards, so it is state, set only when it changes. Compared
  // before setting, not in an updater, since even a no-op updater queues a render.
  const update = (observed: readonly Departure[]) => {
    const next = updateFollowedRuns(followed, observed, feedNow, findRun);
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
  const runDepartures = useMemo(
    () =>
      selectPlaceableRuns(
        getLineRunDepartures(followed, observedDepartures, feedNow, findRun),
        deviceNow,
        handedOverKeys,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [followed, observedDepartures, followedRuns, handedOverKeys],
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
