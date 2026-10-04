import { useEffect, useMemo, useRef, useState } from "react";
import type { TransitStop } from "../data/transit-types";
import { useStoredPreference } from "./stored-preference";
import { appSettings } from "../lib/app-settings";
import {
  findRecentStops,
  forgetRecentStops,
  rememberStopVisit,
  withStopVisit,
  type RecentStop,
} from "../lib/recent-stops";
import { getLandingPath, hasRouteAddress, replaceCurrentRoute } from "../routing";

/**
 * The landing stop, read once at start so browsing does not move it, and the recent list, which
 * does keep up. Only resolved stops are recorded, and only while the setting allows it.
 */
export function useStopRecall(visitedStop: TransitStop | undefined): {
  /** Where the app opens without an address; decided once. */
  recentStopId: string | undefined;
  /** Shortcut stops, newest first, the one in view excluded. */
  recentStops: readonly RecentStop[];
} {
  const settings = useStoredPreference(appSettings);
  const [landingStopId] = useState(() =>
    settings.landing === "recent-stop" ? findRecentStops()[0]?.stopId : undefined,
  );
  const [recentStops, setRecentStops] = useState(findRecentStops);
  const visitedStopId = visitedStop?.id;
  const visitedStopName = visitedStop?.name;

  // Set during render, so the list does not show a stale order for a frame.
  const [visited] = recentStops;
  if (
    settings.isRememberingStops &&
    visitedStopId &&
    (visited?.stopId !== visitedStopId || visited.stopName !== visitedStopName)
  ) {
    setRecentStops(withStopVisit(recentStops, visitedStopId, visitedStopName));
  }

  // Not remembering means keeping nothing, so turning it off clears the list.
  if (!settings.isRememberingStops && recentStops.length > 0) setRecentStops([]);

  // The effect only writes storage.
  useEffect(() => {
    if (!settings.isRememberingStops) forgetRecentStops();
    else if (visitedStopId) rememberStopVisit(visitedStopId, visitedStopName);
  }, [visitedStopId, visitedStopName, settings.isRememberingStops]);

  return {
    recentStopId: landingStopId,
    recentStops: useMemo(
      () =>
        settings.isRememberingStops
          ? recentStops.filter((visit) => visit.stopName && visit.stopId !== visitedStopId)
          : [],
      [recentStops, visitedStopId, settings.isRememberingStops],
    ),
  };
}

/**
 * Navigates to the landing on first render with `replace`, so back still leaves the app.
 * `recentStopId` comes from `useStopRecall`, so both use the same storage reading.
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
