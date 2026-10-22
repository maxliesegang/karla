import { readStorage } from "./stored-preference";
import type { StopEvent } from "../data/transit-types";
import { findFinalCallInstant } from "./calls";

/** A reload must not end the ride the passenger is still reading. */
const ACTIVE_RIDE_STORAGE_KEY = "karla:active-ride";
const RIDE_EXPIRY_GRACE_MS = 60 * 60_000;
const FALLBACK_RIDE_LIFETIME_MS = 6 * 60 * 60_000;

export type ActiveRideObservation = {
  rideId: string;
  stopEvent: StopEvent;
  observedAt: number;
  expiresAt: number;
};

/**
 * The final expected call plus an hour, or a conservative lifetime when the journey has no times.
 */
export function getActiveRideExpiry(stopEvent: StopEvent, observedAt: number): number {
  const finalInstant = findFinalCallInstant(stopEvent.calls);
  return finalInstant === undefined
    ? observedAt + FALLBACK_RIDE_LIFETIME_MS
    : finalInstant + RIDE_EXPIRY_GRACE_MS;
}

export function findActiveRideObservation(
  rideId: string,
  now = Date.now(),
): ActiveRideObservation | null {
  const storage = readStorage();
  if (!storage || !rideId) return null;

  try {
    const raw = storage.getItem(ACTIVE_RIDE_STORAGE_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as Partial<ActiveRideObservation> & { routeId?: string };
    const storedRideId = stored.rideId ?? stored.routeId;
    const stopEvent = stored.stopEvent as Partial<StopEvent> | undefined;
    const isValid =
      storedRideId === rideId &&
      typeof stored.observedAt === "number" &&
      typeof stored.expiresAt === "number" &&
      stored.expiresAt > now &&
      typeof stopEvent?.id === "string" &&
      typeof stopEvent.lineId === "string" &&
      typeof stopEvent.destinationText === "string" &&
      Array.isArray(stopEvent.calls);
    if (!isValid || !storedRideId) {
      storage.removeItem(ACTIVE_RIDE_STORAGE_KEY);
      return null;
    }
    return { ...stored, rideId: storedRideId } as ActiveRideObservation;
  } catch {
    return null;
  }
}

export function rememberActiveRideObservation(
  rideId: string,
  stopEvent: StopEvent,
  observedAt: number,
): ActiveRideObservation {
  const observation = {
    rideId,
    stopEvent,
    observedAt,
    expiresAt: getActiveRideExpiry(stopEvent, observedAt),
  };
  try {
    readStorage()?.setItem(ACTIVE_RIDE_STORAGE_KEY, JSON.stringify(observation));
  } catch {
    // A blocked or full store costs reload continuity and nothing else.
  }
  return observation;
}

export function forgetActiveRideObservation(rideId?: string): void {
  const storage = readStorage();
  if (!storage) return;
  try {
    if (rideId) {
      const stored = JSON.parse(storage.getItem(ACTIVE_RIDE_STORAGE_KEY) ?? "null") as
        | (Partial<ActiveRideObservation> & { routeId?: string })
        | null;
      if ((stored?.rideId ?? stored?.routeId) !== rideId) return;
    }
    storage.removeItem(ACTIVE_RIDE_STORAGE_KEY);
  } catch {
    // The value is advisory and expiry-bounded; failing to clear it cannot stop the app.
  }
}
