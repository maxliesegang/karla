import { useEffect, useMemo, useRef, useState } from "react";
import type { TransitStop } from "../data/transit-types";
import {
  findRecentStops,
  rememberStopVisit,
  withStopVisit,
  type RecentStop,
} from "../lib/recent-stops";
import { getLandingPath, hasRouteAddress, replaceCurrentRoute } from "../routing";

/**
 * The stop a returning rider is most likely to want, and recording the one they are reading now.
 *
 * The landing stop is read once, when the app starts: a decision made later would keep pulling a
 * rider back to their usual stop as they browse. The list beside it does keep up, because a stop
 * read in this session is exactly the one a rider is most likely to want back. Recording happens
 * only for a stop that actually resolved, so a board that never loaded is never remembered as
 * somewhere they were.
 */
export function useStopRecall(visitedStop: TransitStop | undefined): {
  /** Where the app opens when it was given no address. Decided once, so browsing cannot move it. */
  recentStopId: string | undefined;
  /** The stops to offer as a shortcut, most recent first, the one in view left out. */
  recentStops: readonly RecentStop[];
} {
  const [landingStopId] = useState(() => findRecentStops()[0]?.stopId);
  const [recentStops, setRecentStops] = useState(findRecentStops);
  const visitedStopId = visitedStop?.id;
  const visitedStopName = visitedStop?.name;

  // Adjusted while rendering rather than in an effect: the stop being read is already known here,
  // and waiting a paint to move it to the front would show the rider a list they have just left.
  const [visited] = recentStops;
  if (
    visitedStopId &&
    (visited?.stopId !== visitedStopId || visited.stopName !== visitedStopName)
  ) {
    setRecentStops(withStopVisit(recentStops, visitedStopId, visitedStopName));
  }

  // Storage is the external system this synchronises with, and writing it is all the effect does.
  useEffect(() => {
    if (visitedStopId) rememberStopVisit(visitedStopId, visitedStopName);
  }, [visitedStopId, visitedStopName]);

  return {
    recentStopId: landingStopId,
    recentStops: useMemo(
      () => recentStops.filter((visit) => visit.stopName && visit.stopId !== visitedStopId),
      [recentStops, visitedStopId],
    ),
  };
}

/**
 * Where the app opens when it was given no address.
 *
 * Decided once, on the first render, and written with `replace`: the landing is a starting point
 * rather than somewhere the rider navigated to, so the back button must still leave the app, and a
 * rule that kept re-deciding would pull a browsing rider back to their usual stop. Reading the
 * address is routing's job and the shell's, never a component's.
 *
 * `recentStopId` is `useStopRecall`'s landing decision, which is likewise taken once. It is passed
 * in rather than read here so both halves of the landing stand on the same reading of storage.
 */
export function useInitialLanding(isEnabled: boolean, recentStopId?: string) {
  const hasLanded = useRef(false);
  const landingStopIdRef = useRef(recentStopId);

  useEffect(() => {
    if (hasLanded.current || !isEnabled) return;
    hasLanded.current = true;
    if (hasRouteAddress()) return;
    replaceCurrentRoute(getLandingPath(landingStopIdRef.current));
  }, [isEnabled]);
}
