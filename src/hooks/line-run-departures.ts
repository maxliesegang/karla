import { useEffect, useMemo, useState } from "react";
import { transitSource } from "../data/transit-source";
import type { Departure, DepartureBoard } from "../data/transit-types";
import {
  areFollowedRunsEqual,
  getLineRunDepartures,
  updateFollowedRuns,
  type FollowedRun,
} from "../lib/line-run-departures";
import { useVehicleFeedNow } from "./clock";
import { useRunReadingsByRowId } from "./run-reading-loader";

const findRun = (rowId: string) => transitSource.findRun(rowId);

/**
 * The runs a line view draws: the boards' current rows, plus runs the boards have stopped listing,
 * followed by id until their calls run out and read from the store meanwhile.
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
  // Boards stop naming a run as soon as it leaves an observation post, so the runs followed are
  // re-read here on their own cadence; the answers land in the store and are read back from it.
  const followedRuns = useRunReadingsByRowId(followedRowIds);
  const feedNow = useVehicleFeedNow(
    observedDepartures.length > 0 || followed.length > 0 || isRide,
    departureBoard,
  );

  // The set followed is an accumulator over successive boards — what was followed before is an
  // input — so it is kept in state, and set only when a board names a run or a run ends. Compared
  // before setting, never inside an updater: the boards behind it change with every run re-read,
  // and even an updater that returns the same state queues a render each time.
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

  // Memoized on what decides its content — the set followed, the rows, and the store's answers for
  // the runs followed — rather than on the tick, so a drawing reading its service off it is not
  // handed a new set every second; the tick prunes the set followed above.
  const runDepartures = useMemo(
    () => getLineRunDepartures(followed, observedDepartures, feedNow, findRun),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [followed, observedDepartures, followedRuns],
  );

  return { runDepartures, feedNow };
}
