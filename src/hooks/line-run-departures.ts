import { useEffect, useMemo, useState } from "react";
import type { Departure, DepartureBoard } from "../data/transit-types";
import {
  areFollowedRunsEqual,
  getLineRunDepartures,
  updateFollowedRuns,
  type FollowedRun,
} from "../lib/line-run-departures";
import { useVehicleFeedNow } from "./clock";
import { LINE_RUN_READING_MAX_AGE_MS, useRunReadingsByRowId } from "./run-reading-loader";

/**
 * Vehicles followed for one line, until their complete call sequence says the run ended.
 *
 * Boards only list runs that have not left their stop. Following a bounded set of them lets the
 * diagram keep placing a vehicle after it passes an observation stop without asking that stop for
 * historical departures. What is kept is the *names* of those runs; the readings are the source's,
 * so a vehicle no longer on any board is still drawn from the freshest reading anything has taken
 * of it — the ride re-reading itself moves the mark on the diagram beside it.
 */
export function useLineRunDepartures(
  lineId: string,
  observedDepartures: readonly Departure[],
  departureBoard: DepartureBoard | null,
  isRide: boolean,
): { runDepartures: readonly Departure[]; feedNow: number } {
  // Never *retained*, which is the word for a reading kept across a gap and is what the ride does
  // with its own. Nothing here keeps a reading: what is kept is which runs to go on drawing.
  const [following, setFollowing] = useState<{
    lineId: string;
    followed: readonly FollowedRun[];
  }>({ lineId, followed: [] });
  const followed = useMemo(
    () => (following.lineId === lineId ? following.followed : []),
    [following, lineId],
  );
  const followedRowIds = useMemo(() => followed.map(({ rowId }) => rowId), [followed]);
  // Boards stop naming a run as soon as it leaves an observation post. Its calls still need their
  // own cadence, or the source's sequence freezes at the post and the old row prediction can drag
  // the mark back to it. The set holds ids only; this hook re-reads and resolves the records in the
  // shared store.
  const followedRuns = useRunReadingsByRowId(followedRowIds, {
    refreshMs: LINE_RUN_READING_MAX_AGE_MS,
  });
  const followedRunById = useMemo(
    () => new Map(followedRuns.map((run) => [run.id, run])),
    [followedRuns],
  );
  const feedNow = useVehicleFeedNow(
    observedDepartures.length > 0 || followed.length > 0 || isRide,
    departureBoard,
  );

  useEffect(() => {
    // The set followed is an accumulator over successive boards, not state derivable from this
    // render: what was followed before is the input. Kept in an effect deliberately.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFollowing((current) => ({
      lineId,
      followed: updateFollowedRuns(
        current.lineId === lineId ? current.followed : [],
        observedDepartures,
        feedNow,
      ),
    }));
    // A feed tick only drops runs that have ended, below; it must not make the same board a new
    // observation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineId, observedDepartures]);

  useEffect(() => {
    // Dropping ended runs on a feed tick is the same accumulator as above. Compared by value, not
    // by length: the set only shrinks here, but a guard that held for one shape would not for the
    // next, and a tick that moves state it need not have moved re-renders the whole plan.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFollowing((current) => {
      if (current.lineId !== lineId) return current;
      const followed = updateFollowedRuns(current.followed, [], feedNow);
      return areFollowedRunsEqual(followed, current.followed) ? current : { ...current, followed };
    });
  }, [feedNow, lineId]);

  // The drawn set is every run this reading places, however it came to be named: the boards'
  // current rows and the runs the boards have stopped listing, still drawn from the source's
  // retained readings. Memoized on what decides its *content* — the set followed, the rows, and
  // what the store answers for them — because a drawing reads its service off it, and a set that
  // was rebuilt by the tick that only re-evaluated expiry would be news to that drawing every
  // second. The tick's own say is the belt-and-braces expiry check inside, read against the
  // render the content last changed in; the tick also prunes the set followed above, so nothing
  // over stays in past that render.
  const runDepartures = useMemo(
    () =>
      getLineRunDepartures(followed, observedDepartures, feedNow, (rowId) =>
        followedRunById.get(rowId),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [followed, observedDepartures, followedRunById],
  );

  return { runDepartures, feedNow };
}
