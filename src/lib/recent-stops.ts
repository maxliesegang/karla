/**
 * The stops the rider has been reading.
 *
 * A rider opening the app is nearly always at one of the two or three stops they use, and naming
 * those stops is what saves them the whole navigation. They are remembered rather than located: the
 * Zentrum's busiest platforms are underground, where a fix is unusable or a platform out, and a
 * remembered stop needs no permission, answers instantly, and is one the rider chose themselves.
 *
 * The most recent one decides where the app opens; the rest are offered as a short list, because
 * the *second* stop a rider uses is the one that costs them a search every single time. Both are
 * conveniences and neither is a claim: an entry holds an id and the name it was read under, and
 * whether that stop has service today is still read from the live feed like any other.
 */

const RECENT_STOPS_STORAGE_KEY = "karla:recent-stops";
/** The single-stop key earlier versions wrote, still read once so a returning rider lands where they left off. */
const LEGACY_RECENT_STOP_STORAGE_KEY = "karla:recent-stop";

/** Past this, the stop is no longer where the rider is likely to be, and the app starts over. */
const RECENT_STOP_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * How many are kept. A rider has a home stop, a work stop and perhaps one more; a longer list stops
 * being a shortcut and becomes something to read, which is what the search field is for.
 */
export const RECENT_STOP_LIMIT = 4;

export type RecentStop = {
  stopId: string;
  /** The name the stop was read under. Absent on an entry migrated from the single-stop key. */
  stopName?: string;
  visitedAt: number;
};

/**
 * Storage is unavailable in a private window, when site data is blocked, and inside the artifact
 * sandboxes this page may be viewed in — reading it must never be what stops the app rendering.
 */
function readStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const isRecentStop = (value: unknown): value is RecentStop => {
  const visit = value as Partial<RecentStop> | null;
  return (
    typeof visit?.stopId === "string" &&
    typeof visit.visitedAt === "number" &&
    (visit.stopName === undefined || typeof visit.stopName === "string")
  );
};

/** The stops the rider read recently, most recent first, expired entries dropped. */
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

/** The single visit the earlier version stored, as one entry of the list that replaced it. */
function findLegacyRecentStops(storage: Storage): RecentStop[] {
  const stored = storage.getItem(LEGACY_RECENT_STOP_STORAGE_KEY);
  if (!stored) return [];
  const visit: unknown = JSON.parse(stored);
  return isRecentStop(visit) ? [visit] : [];
}

/**
 * The list as it stands once this stop has been read: the visit in front, the same stop removed
 * from further down, and the oldest dropped off the end. Kept apart from writing it so a view can
 * show the list it is about to store without waiting for a round trip through storage.
 */
export function withStopVisit(
  visits: readonly RecentStop[],
  stopId: string,
  stopName?: string,
): RecentStop[] {
  const withoutStop = visits.filter((visit) => visit.stopId !== stopId);
  return [{ stopId, stopName, visitedAt: Date.now() }, ...withoutStop].slice(0, RECENT_STOP_LIMIT);
}

/** Records that the rider read this stop's board. Failing to record it is not worth an error. */
export function rememberStopVisit(stopId: string, stopName?: string): void {
  const storage = readStorage();
  if (!storage || !stopId) return;

  try {
    const updated = withStopVisit(findRecentStops(), stopId, stopName);
    storage.setItem(RECENT_STOPS_STORAGE_KEY, JSON.stringify(updated));
    storage.removeItem(LEGACY_RECENT_STOP_STORAGE_KEY);
  } catch {
    // A full or blocked store costs the rider a remembered stop, and nothing else.
  }
}
