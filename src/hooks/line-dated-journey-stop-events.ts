import { useEffect, useMemo, useState } from "react";
import { transitSource } from "../data/transit-source";
import type { StopEvent, StopEventBoard } from "../data/transit-types";
import {
  areFollowedDatedJourneysEqual,
  getLineDatedJourneyStopEvents,
  selectPlaceableDatedJourneys,
  updateFollowedDatedJourneys,
  type FollowedDatedJourney,
} from "../lib/line-dated-journey-stop-events";
import { getFeedOffsetMs } from "../lib/feed-clock";
import { getDatedJourneyMarkKey } from "../lib/journeys";
import { useDeviceNow, useVehicleFeedNow } from "./clock";
import { useDatedJourneyReadingsByRowId } from "./dated-journey-reading-loader";

const findDatedJourney = (rowId: string) => transitSource.findDatedJourney(rowId);

/**
 * The dated journeys a line view draws: current rows plus dated journeys boards stopped listing,
 * followed by id until they end. A dated journey is first handed over only once its calls are fresh
 * (`selectPlaceableDatedJourneys`).
 */
export function useLineDatedJourneyStopEvents(
  lineId: string,
  observedStopEvents: readonly StopEvent[],
  stopEventBoard: StopEventBoard | null,
  isRide: boolean,
  {
    includesDatedJourney,
    refreshOnEntry = true,
    animatesVehicles = true,
    datedJourneyMaxAgeMs,
    readsBeforeMerges = false,
  }: {
    includesDatedJourney?: (datedJourney: StopEvent, feedNow: number) => boolean;
    refreshOnEntry?: boolean;
    animatesVehicles?: boolean;
    datedJourneyMaxAgeMs?: number;
    /**
     * Re-read each dated journey shortly before it leaves for a merge
     * (`useDatedJourneyReadingsByRowId`).
     */
    readsBeforeMerges?: boolean;
  } = {},
): { datedJourneyStopEvents: readonly StopEvent[]; feedNow: number } {
  const [following, setFollowing] = useState<{
    lineId: string;
    followed: readonly FollowedDatedJourney[];
  }>({ lineId, followed: [] });
  const followed = useMemo(
    () => (following.lineId === lineId ? following.followed : []),
    [following, lineId],
  );
  const followedRowIds = useMemo(() => followed.map(({ rowId }) => rowId), [followed]);
  // Followed dated journeys are re-read on their own cadence; answers land in the store.
  const feedOffsetMs = getFeedOffsetMs(stopEventBoard);
  const mergeReads = useMemo(
    () => (readsBeforeMerges ? { feedOffsetMs } : undefined),
    [readsBeforeMerges, feedOffsetMs],
  );
  const followedDatedJourneys = useDatedJourneyReadingsByRowId(followedRowIds, {
    refreshOnEntry,
    maxAgeMs: datedJourneyMaxAgeMs,
    readsBeforeMerges: mergeReads,
  });
  const feedNow = useVehicleFeedNow(
    observedStopEvents.length > 0 || followed.length > 0 || isRide,
    stopEventBoard,
    { isAnimated: animatesVehicles },
  );

  // The followed set accumulates across boards, so it is state, set only when it changes. Compared
  // before setting, not in an updater, since even a no-op updater queues a render.
  const update = (observed: readonly StopEvent[]) => {
    const scopedFindDatedJourney = (rowId: string) => {
      const datedJourney = findDatedJourney(rowId);
      return datedJourney && (!includesDatedJourney || includesDatedJourney(datedJourney, feedNow))
        ? datedJourney
        : undefined;
    };
    const next = updateFollowedDatedJourneys(
      followed,
      includesDatedJourney
        ? observed.filter((datedJourney) => includesDatedJourney(datedJourney, feedNow))
        : observed,
      feedNow,
      scopedFindDatedJourney,
    );
    if (following.lineId !== lineId || !areFollowedDatedJourneysEqual(next, followed)) {
      setFollowing({ lineId, followed: next });
    }
  };
  // oxlint-disable-next-line react-hooks/exhaustive-deps, react/set-state-in-effect
  useEffect(() => update(observedStopEvents), [lineId, observedStopEvents]);
  // A feed tick only drops dated journeys that have ended; it must not re-read the same board.
  // oxlint-disable-next-line react-hooks/exhaustive-deps, react/set-state-in-effect
  useEffect(() => update([]), [feedNow]);

  // Memoized on content, not the tick, so drawings are not handed a new set every second. A dated
  // journey turns fresh only when its re-read lands, which changes the content.
  const deviceNow = useDeviceNow();
  const [handedOverKeys, setHandedOverKeys] = useState<ReadonlySet<string>>(() => new Set());
  const scopeNow = includesDatedJourney ? feedNow : 0;
  const datedJourneyStopEvents = useMemo(
    () => {
      const datedJourneys = getLineDatedJourneyStopEvents(
        followed,
        observedStopEvents,
        feedNow,
        findDatedJourney,
      );
      return selectPlaceableDatedJourneys(
        includesDatedJourney
          ? datedJourneys.filter((datedJourney) => includesDatedJourney(datedJourney, feedNow))
          : datedJourneys,
        deviceNow,
        handedOverKeys,
      );
    },
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [
      followed,
      observedStopEvents,
      followedDatedJourneys,
      handedOverKeys,
      includesDatedJourney,
      scopeNow,
    ],
  );
  useEffect(() => {
    const keys = datedJourneyStopEvents.map(getDatedJourneyMarkKey);
    if (keys.length !== handedOverKeys.size || keys.some((key) => !handedOverKeys.has(key))) {
      // oxlint-disable-next-line react/set-state-in-effect
      setHandedOverKeys(new Set(keys));
    }
  }, [datedJourneyStopEvents, handedOverKeys]);

  return { datedJourneyStopEvents, feedNow };
}
