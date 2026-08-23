import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_FIX_ACCURACY_METERS, type RidePositionFix } from "../lib/ride-location";
import { IS_GEOLOCATION_SUPPORTED, isPermissionDenied, useGrantedGeolocation } from "./geolocation";

/**
 * The rider's own position while they are on board.
 *
 * The ride is the one view where a continuous fix earns its cost: it is what lets the next stop be
 * read off where the vehicle *is* rather than off where the timetable says it should be. It follows
 * the same rule the nearby list does — location is never demanded. Where the rider has already
 * granted it the watch simply starts, and where they have not, nothing happens until they ask for it
 * from the ride card. Nothing is stored and nothing is sent anywhere.
 *
 * A fix expires. Underground, in a tunnel or with the screen asleep the last reading stops being
 * evidence about where the vehicle is now, so it is dropped rather than kept and trusted, and the
 * ride goes back to the feed's estimate on its own. The same goes for a reading too coarse to tell
 * one stop from the next: it is discarded here so that everything downstream only ever sees a fix
 * that can honestly be placed.
 */

/** Past this age a fix says where the rider was, not where they are. */
const FIX_LIFETIME_MS = 90_000;

export type RidePositionState = {
  status: "idle" | "locating" | "watching" | "denied" | "unavailable";
  /** The current fix, or nothing while there is none worth using. */
  fix?: RidePositionFix;
  /** Why there is none, in German, where that is worth saying. */
  message?: string;
};
export type RidePositionController = RidePositionState & {
  /** Ask for location. Only ever called from a control the rider pressed. */
  enable: () => void;
  /**
   * Whether asking is still worth offering: there is a reading to be gained, and the browser has
   * not already answered. Decided here so no view has to reason about what a status means.
   */
  canEnable: boolean;
};

/** What the watch itself has learned, which is nothing until it has been given a reading. */
type WatchReading =
  | { kind: "pending" }
  | { kind: "fix"; fix: RidePositionFix }
  | { kind: "denied" | "unavailable"; message: string };

export function useRidePosition(isEnabled: boolean): RidePositionController {
  const [reading, setReading] = useState<WatchReading>({ kind: "pending" });
  const [isRequested, setIsRequested] = useState(false);
  const expiryRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Leaving the ride ends the watch without forgetting a refusal: a position is read for as long as
  // it is being read *for* something, and no longer.
  const isWatching = isEnabled && isRequested && IS_GEOLOCATION_SUPPORTED;

  const enable = useCallback(() => setIsRequested(true), []);

  // Already granted is already answered: the watch starts by itself, and only then.
  useGrantedGeolocation(isEnabled && !isRequested, enable);

  useEffect(() => {
    if (!isWatching) return;

    const watchId = navigator.geolocation.watchPosition(
      ({ coords, timestamp }) => {
        // A cached reading may arrive already older than it is worth; the browser dates it, so the
        // remaining lifetime is counted from that date and not from when it was handed over.
        const remaining = FIX_LIFETIME_MS - Math.max(0, Date.now() - timestamp);
        const accuracyMeters = coords.accuracy ?? Number.POSITIVE_INFINITY;
        clearTimeout(expiryRef.current);
        if (remaining <= 0 || accuracyMeters > MAX_FIX_ACCURACY_METERS) {
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
    // Said only to a rider who asked for it. A browser without geolocation is not news to someone
    // who never pressed the button.
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
  // A watch that has been asked for but has not answered yet is locating; the ride reads the feed's
  // estimate in the meantime, which is exactly what it does when no fix ever arrives.
  const isLocated = isWatching && reading.kind === "fix";
  return {
    status: !isWatching ? "idle" : isLocated ? "watching" : "locating",
    fix: isLocated ? reading.fix : undefined,
    enable,
    // Nothing to offer once a watch is running: the answer is on its way, or already here.
    canEnable: !isWatching,
  };
}
