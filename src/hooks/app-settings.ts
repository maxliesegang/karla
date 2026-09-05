import { useSyncExternalStore } from "react";
import {
  readAppSettings,
  subscribeToAppSettings,
  writeAppSettings,
  type AppSettings,
} from "../lib/app-settings";

/**
 * The rider's own choices about the app, shared by everything that acts on them.
 *
 * One value the app reads rather than copies: the landing decision, the stop recall and the line
 * diagram's own other trips each act on it, and a copy held anywhere would let the app disagree
 * with a choice the rider just made in the settings.
 */
export function useAppSettings(): AppSettings {
  return useSyncExternalStore(subscribeToAppSettings, readAppSettings);
}

export { writeAppSettings, type AppSettings };
