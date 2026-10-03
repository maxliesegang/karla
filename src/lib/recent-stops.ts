/**
 * The stops the rider has been reading, remembered (no permission, works underground). The most
 * recent decides where the app opens; the rest are shortcuts. An entry is an id and name, never a
 * claim of service.
 */

import { readStorage } from "./stored-preference";

const RECENT_STOPS_STORAGE_KEY = "karla:recent-stops";
/** The single-stop key of earlier versions, still read once. */
const LEGACY_RECENT_STOP_STORAGE_KEY = "karla:recent-stop";

/** Past this, a stop is no longer likely, and the app starts over. */
const RECENT_STOP_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** Kept entries: home, work, perhaps one more. */
const RECENT_STOP_LIMIT = 4;

export type RecentStop = {
  stopId: string;
  /** The name it was read under; absent on a migrated entry. */
  stopName?: string;
  visitedAt: number;
};

const isRecentStop = (value: unknown): value is RecentStop => {
  const visit = value as Partial<RecentStop> | null;
  return (
    typeof visit?.stopId === "string" &&
    typeof visit.visitedAt === "number" &&
    (visit.stopName === undefined || typeof visit.stopName === "string")
  );
};

/** Recent stops, newest first, expired ones dropped. */
export function findRecentStops(now = Date.now()): RecentStop[] {
  const storage = readStorage();
  if (!storage) return [];

  try {
    const stored = storage.getItem(RECENT_STOPS_STORAGE_KEY);
    const visits: unknown = stored ? JSON.parse(stored) : findLegacyRecentStops(storage);
    if (!Array.isArray(visits)) return [];
    return visits
      .filter(isRecentStop)
      .filter((visit) => now - visit.visitedAt <= RECENT_STOP_TTL_MS)
      .sort((a, b) => b.visitedAt - a.visitedAt)
      .slice(0, RECENT_STOP_LIMIT);
  } catch {
    return [];
  }
}

/** The legacy single entry, as a list. */
function findLegacyRecentStops(storage: Storage): RecentStop[] {
  const stored = storage.getItem(LEGACY_RECENT_STOP_STORAGE_KEY);
  if (!stored) return [];
  const visit: unknown = JSON.parse(stored);
  return isRecentStop(visit) ? [visit] : [];
}

/**
 * The list after reading this stop: it goes in front, its older entry and the oldest overflow drop.
 */
export function withStopVisit(
  visits: readonly RecentStop[],
  stopId: string,
  stopName?: string,
): RecentStop[] {
  const withoutStop = visits.filter((visit) => visit.stopId !== stopId);
  return [{ stopId, stopName, visitedAt: Date.now() }, ...withoutStop].slice(0, RECENT_STOP_LIMIT);
}

/** Records a read board; failure is silent. */
export function rememberStopVisit(stopId: string, stopName?: string): void {
  const storage = readStorage();
  if (!storage || !stopId) return;

  try {
    const updated = withStopVisit(findRecentStops(), stopId, stopName);
    storage.setItem(RECENT_STOPS_STORAGE_KEY, JSON.stringify(updated));
    storage.removeItem(LEGACY_RECENT_STOP_STORAGE_KEY);
  } catch {
    // A full or blocked store only costs a remembered stop.
  }
}
