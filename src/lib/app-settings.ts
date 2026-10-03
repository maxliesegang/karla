import { createStoredPreference } from "./stored-preference";

/**
 * Device-local app preferences (landing, remembering stops, other vehicles in the diagram, stacked
 * board length), honoured for the session even when storage is blocked.
 */

export type AppLanding = "recent-stop" | "home";

export type AppSettings = {
  /** Where the app opens when it was given no address. */
  landing: AppLanding;
  /** Whether read stops are kept on this device. */
  isRememberingStops: boolean;
  /** Whether the line diagram draws other vehicles besides the followed one. */
  isShowingOtherLineRuns: boolean;
  /** Departures the stacked board shows before "mehr anzeigen". */
  stackedDepartureLimit: number;
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
  landing: "recent-stop",
  isRememberingStops: true,
  isShowingOtherLineRuns: true,
  stackedDepartureLimit: 8,
};

/** Row counts a stacked board may show. */
const STACKED_DEPARTURE_LIMIT_OPTIONS: readonly number[] = [5, 8, 12];

const APP_SETTINGS_STORAGE_KEY = "karla:settings";

const isRowLimit = (value: unknown): value is number =>
  STACKED_DEPARTURE_LIMIT_OPTIONS.includes(value as number);

/** Settings from a stored value; unreadable fields take the default. */
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

/** The app settings; unreadable storage gives the defaults. */
export const appSettings = createStoredPreference<AppSettings>({
  key: APP_SETTINGS_STORAGE_KEY,
  parse: (stored) => getAppSettingsFromStored(JSON.parse(stored ?? "null")),
  serialize: JSON.stringify,
});
