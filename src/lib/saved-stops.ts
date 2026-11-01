/**
 * The stops the rider chose to keep, as opposed to the recent ones the app keeps for them: no
 * expiry, no limit, and not cleared by turning off remembering. An entry is an id and name, never a
 * claim of service.
 */

import { createStoredPreference } from "./stored-preference";

export type SavedStop = { stopId: string; stopName: string };

const isSavedStop = (value: unknown): value is SavedStop => {
  const saved = value as Partial<SavedStop> | null;
  return typeof saved?.stopId === "string" && typeof saved.stopName === "string";
};

/** Saved stops from a stored value, in the order saved; unreadable entries drop. */
export function getSavedStopsFromStored(stored: unknown): SavedStop[] {
  return Array.isArray(stored) ? stored.filter(isSavedStop) : [];
}

/** The list with this stop at the end, its name refreshed if it was already there. */
export function withSavedStop(
  saved: readonly SavedStop[],
  stopId: string,
  stopName: string,
): SavedStop[] {
  return saved.some((stop) => stop.stopId === stopId)
    ? saved.map((stop) => (stop.stopId === stopId ? { stopId, stopName } : stop))
    : [...saved, { stopId, stopName }];
}

export function withoutSavedStop(saved: readonly SavedStop[], stopId: string): SavedStop[] {
  return saved.filter((stop) => stop.stopId !== stopId);
}

/** The list with this stop moved one place earlier (`-1`) or later (`1`); at an end it stays. */
export function withSavedStopMoved(
  saved: readonly SavedStop[],
  stopId: string,
  step: -1 | 1,
): SavedStop[] {
  const from = saved.findIndex((stop) => stop.stopId === stopId);
  const to = from + step;
  if (from < 0 || to < 0 || to >= saved.length) return [...saved];
  const moved = [...saved];
  [moved[from], moved[to]] = [moved[to], moved[from]];
  return moved;
}

/** The saved stops; unreadable storage gives none. */
export const savedStops = createStoredPreference<SavedStop[]>({
  key: "karla:saved-stops",
  parse: (stored) => getSavedStopsFromStored(JSON.parse(stored ?? "null")),
  serialize: JSON.stringify,
});
