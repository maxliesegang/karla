import { useSyncExternalStore } from "react";
import type { StoredPreference } from "../lib/stored-preference";

/**
 * A stored preference as one value the app reads rather than copies, so every view acts on the
 * choice the rider just made.
 */
export function useStoredPreference<T>(preference: StoredPreference<T>): T {
  return useSyncExternalStore(preference.subscribe, preference.read);
}
