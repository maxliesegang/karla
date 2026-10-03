import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_RIDE_POSITION_FIX_ACCURACY_METERS, type RidePositionFix } from "../lib/ride-position";
import { IS_GEOLOCATION_SUPPORTED, isPermissionDenied, useGrantedGeolocation } from "./geolocation";

/**
 * The rider's position while on board. Never demanded: starts on its own only if already granted,
 * else when asked from the ride card. Nothing is stored or sent. Fixes expire (tunnels, sleep) and
 * coarse fixes are dropped, so the ride falls back to the feed's estimate.
 */

/** Past this age a fix says where the rider was, not where they are. */
const FIX_LIFETIME_MS = 90_000;

export type RidePositionState = {
  status: "idle" | "locating" | "watching" | "denied" | "unavailable";
  /** The current fix, or nothing while there is none worth using. */
  fix?: RidePositionFix;
  /** Why there is none, in German, where worth saying. */
  message?: string;
};
export type RidePositionController = RidePositionState & {
  /** Ask for location; only from a control the rider pressed. */
  enable: () => void;
  /** Whether asking is still worth offering. */
  canEnable: boolean;
};

/** What the watch has learned so far. */
type WatchReading =
  | { kind: "pending" }
  | { kind: "fix"; fix: RidePositionFix }
  | { kind: "denied" | "unavailable"; message: string };

export function useRidePosition(isEnabled: boolean): RidePositionController {
  const [reading, setReading] = useState<WatchReading>({ kind: "pending" });
  const [isRequested, setIsRequested] = useState(false);
  const expiryRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Leaving the ride ends the watch but remembers a refusal.
  const isWatching = isEnabled && isRequested && IS_GEOLOCATION_SUPPORTED;

  const enable = useCallback(() => setIsRequested(true), []);

  // Already granted: the watch starts by itself.
  useGrantedGeolocation(isEnabled && !isRequested, enable);

  useEffect(() => {
    if (!isWatching) return;

    const watchId = navigator.geolocation.watchPosition(
      ({ coords, timestamp }) => {
        // A cached reading may already be old; its lifetime counts from the browser's timestamp.
        const remaining = FIX_LIFETIME_MS - Math.max(0, Date.now() - timestamp);
        const accuracyMeters = coords.accuracy ?? Number.POSITIVE_INFINITY;
        clearTimeout(expiryRef.current);
        if (remaining <= 0 || accuracyMeters > MAX_RIDE_POSITION_FIX_ACCURACY_METERS) {
          setReading({ kind: "pending" });
          return;
        }
        setReading({
          kind: "fix",
          fix: { latitude: coords.latitude, longitude: coords.longitude, accuracyMeters },
        });
        expiryRef.current = setTimeout(() => setReading({ kind: "pending" }), remaining);
      },
      (error) =>
        setReading(
          isPermissionDenied(error)
            ? {
                kind: "denied",
                message: "Ohne Standortfreigabe wird die Fahrt nach Fahrplan geschätzt.",
              }
            : {
                kind: "unavailable",
                message: "Standort gerade nicht verfügbar — Schätzung nach Fahrplan.",
              },
        ),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 15_000 },
    );

    return () => {
      navigator.geolocation.clearWatch(watchId);
      clearTimeout(expiryRef.current);
    };
  }, [isWatching]);

  if (!IS_GEOLOCATION_SUPPORTED) {
    // Only said to a rider who asked.
    return {
      status: "unavailable",
      message: isRequested ? "Standort ist in diesem Browser nicht verfügbar." : undefined,
      enable,
      canEnable: false,
    };
  }
  if (reading.kind === "denied" || reading.kind === "unavailable") {
    return { status: reading.kind, message: reading.message, enable, canEnable: false };
  }
  // Locating until the first fix; the ride reads the feed meanwhile.
  const isLocated = isWatching && reading.kind === "fix";
  return {
    status: !isWatching ? "idle" : isLocated ? "watching" : "locating",
    fix: isLocated ? reading.fix : undefined,
    enable,
    // Nothing to offer once a watch runs.
    canEnable: !isWatching,
  };
}
