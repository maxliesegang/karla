import type { Departure } from "../data/transit-types";
import { findFinalCallInstant } from "./trip-calls";

/** A reload must not end the ride the passenger is still reading. */
const ACTIVE_RIDE_STORAGE_KEY = "karla:active-ride";
const RIDE_EXPIRY_GRACE_MS = 60 * 60_000;
const FALLBACK_RIDE_LIFETIME_MS = 6 * 60 * 60_000;

export type ActiveRideObservation = {
  routeId: string;
  departure: Departure;
  observedAt: number;
  expiresAt: number;
};

function readStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The final expected call plus an hour, or a conservative lifetime when the trip has no times. */
export function getActiveRideExpiry(departure: Departure, observedAt: number): number {
  const finalInstant = findFinalCallInstant(departure.tripCalls);
  return finalInstant === undefined
    ? observedAt + FALLBACK_RIDE_LIFETIME_MS
    : finalInstant + RIDE_EXPIRY_GRACE_MS;
}

export function findActiveRideObservation(
  routeId: string,
  now = Date.now(),
): ActiveRideObservation | null {
  const storage = readStorage();
  if (!storage || !routeId) return null;

  try {
    const raw = storage.getItem(ACTIVE_RIDE_STORAGE_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as Partial<ActiveRideObservation>;
    const departure = stored.departure as Partial<Departure> | undefined;
    const isValid =
      stored.routeId === routeId &&
      typeof stored.observedAt === "number" &&
      typeof stored.expiresAt === "number" &&
      stored.expiresAt > now &&
      typeof departure?.id === "string" &&
      typeof departure.lineId === "string" &&
      typeof departure.destination === "string" &&
      Array.isArray(departure.tripCalls);
    if (!isValid) {
      storage.removeItem(ACTIVE_RIDE_STORAGE_KEY);
      return null;
    }
    return stored as ActiveRideObservation;
  } catch {
    return null;
  }
}

export function rememberActiveRideObservation(
  routeId: string,
  departure: Departure,
  observedAt: number,
): ActiveRideObservation {
  const observation = {
    routeId,
    departure,
    observedAt,
    expiresAt: getActiveRideExpiry(departure, observedAt),
  };
  try {
    readStorage()?.setItem(ACTIVE_RIDE_STORAGE_KEY, JSON.stringify(observation));
  } catch {
    // A blocked or full store costs reload continuity and nothing else.
  }
  return observation;
}

export function forgetActiveRideObservation(routeId?: string): void {
  const storage = readStorage();
  if (!storage) return;
  try {
    if (routeId) {
      const stored = JSON.parse(
        storage.getItem(ACTIVE_RIDE_STORAGE_KEY) ?? "null",
      ) as Partial<ActiveRideObservation> | null;
      if (stored?.routeId !== routeId) return;
    }
    storage.removeItem(ACTIVE_RIDE_STORAGE_KEY);
  } catch {
    // The value is advisory and expiry-bounded; failing to clear it cannot stop the app.
  }
}
