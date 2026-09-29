/**
 * The choices a rider makes about the app itself, rather than about one board or one visit.
 *
 * Everything here is a device-local preference, kept the way the remembered stops and the board
 * order are kept: honoured for the session even where storage is blocked, and never read in a way
 * that could stop the app rendering. Each one answers a question the app otherwise decides on the
 * rider's behalf — where it opens, what it remembers about them, and whether the line diagram draws
 * the line's other vehicles beside the one the rider follows.
 */

export type AppLanding = "recent-stop" | "home";

export type AppSettings = {
  /** Where the app opens when it was given no address. */
  landing: AppLanding;
  /** Whether the stops the rider reads are kept on this device for the next visit. */
  isRememberingStops: boolean;
  /** Whether the line diagram draws the line's other vehicles beside the one the rider follows. */
  isShowingOtherLineRuns: boolean;
  /** How many departures the stacked board shows before "mehr anzeigen" gathers the rest. */
  stackedDepartureLimit: number;
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
  landing: "recent-stop",
  isRememberingStops: true,
  isShowingOtherLineRuns: true,
  stackedDepartureLimit: 8,
};

/** The row counts a board can be asked to hold. A cap the feed never answers for is not among them. */
export const STACKED_DEPARTURE_LIMIT_OPTIONS: readonly number[] = [5, 8, 12];

const APP_SETTINGS_STORAGE_KEY = "karla:settings";

const isRowLimit = (value: unknown): value is number =>
  STACKED_DEPARTURE_LIMIT_OPTIONS.includes(value as number);

/** The settings a stored value stands for, field by field: anything unreadable is the default. */
export function getAppSettingsFromStored(stored: unknown): AppSettings {
  if (typeof stored !== "object" || stored === null) return DEFAULT_APP_SETTINGS;
  const candidate = stored as Partial<AppSettings> & { isShowingOtherLineTrips?: boolean };
  const isShowingOtherLineRuns =
    candidate.isShowingOtherLineRuns ?? candidate.isShowingOtherLineTrips;
  return {
    landing: candidate.landing === "home" ? "home" : "recent-stop",
    isRememberingStops: candidate.isRememberingStops !== false,
    isShowingOtherLineRuns: isShowingOtherLineRuns !== false,
    stackedDepartureLimit: isRowLimit(candidate.stackedDepartureLimit)
      ? candidate.stackedDepartureLimit
      : DEFAULT_APP_SETTINGS.stackedDepartureLimit,
  };
}

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

/** An unreadable or half-written store is the same as never having set anything. */
function readKeptAppSettings(): AppSettings {
  try {
    const kept: unknown = JSON.parse(readStorage()?.getItem(APP_SETTINGS_STORAGE_KEY) ?? "null");
    return getAppSettingsFromStored(kept);
  } catch {
    return DEFAULT_APP_SETTINGS;
  }
}

/**
 * The settings in hand, so that a choice storage would not keep is still honoured for this session
 * — and so that reading them is the same value every time rather than a fresh trip to storage.
 */
let currentAppSettings: AppSettings | undefined;

/** Everything currently reading the settings, so that changing one moves the whole app at once. */
const appSettingsListeners = new Set<() => void>();

export function readAppSettings(): AppSettings {
  currentAppSettings ??= readKeptAppSettings();
  return currentAppSettings;
}

export function subscribeToAppSettings(listener: () => void): () => void {
  appSettingsListeners.add(listener);
  return () => {
    appSettingsListeners.delete(listener);
  };
}

export function writeAppSettings(settings: AppSettings): void {
  currentAppSettings = settings;
  try {
    readStorage()?.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // A choice that cannot be kept is still honoured for this session; nothing here is a claim.
  }
  // Announced whether or not storage took it: a rider who cannot keep a setting still chose it.
  for (const listener of appSettingsListeners) listener();
}
