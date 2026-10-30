import { useEffect } from "react";

/**
 * Shared location helpers. Location is only requested from a pressed control, or used if already
 * granted; never stored.
 */

export const IS_GEOLOCATION_SUPPORTED =
  typeof navigator !== "undefined" && "geolocation" in navigator;

/** Well inside the spacing of city stops, so refining further would rarely change the answer. */
const SETTLED_FIX_ACCURACY_METERS = 50;
/** How long a reading keeps refining after a coarser first fix. */
const FIX_REFINEMENT_MS = 2_000;
const FIX_TIMEOUT_MS = 15_000;
/** A fix this recent still says where the rider stands, and answers at once. */
const FIX_MAX_AGE_MS = 10_000;

/** Whether the rider refused, the one refusal worth remembering. */
export const isPermissionDenied = (error: GeolocationPositionError): boolean =>
  error.code === error.PERMISSION_DENIED;

/**
 * The best fix of a short high-accuracy watch: at once when precise enough, else the best shortly
 * after the first, since a phone's first fix is often its coarse network guess. Rejects with the
 * browser's error when no fix comes.
 */
export function readRefinedPosition(): Promise<GeolocationCoordinates> {
  return new Promise((resolve, reject) => {
    let best: GeolocationCoordinates | undefined;
    let refinementTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      clearTimeout(refinementTimer);
      navigator.geolocation.clearWatch(watchId);
    };
    const settle = () => {
      finish();
      if (best) resolve(best);
    };
    const watchId = navigator.geolocation.watchPosition(
      ({ coords }) => {
        if (!best || coords.accuracy < best.accuracy) best = coords;
        if (best.accuracy <= SETTLED_FIX_ACCURACY_METERS) settle();
        else refinementTimer ??= setTimeout(settle, FIX_REFINEMENT_MS);
      },
      (error) => {
        if (best && !isPermissionDenied(error)) return settle();
        finish();
        reject(error);
      },
      { enableHighAccuracy: true, timeout: FIX_TIMEOUT_MS, maximumAge: FIX_MAX_AGE_MS },
    );
  });
}

/**
 * Runs `onGranted` once a standing grant is reported; browsers that will not say leave the button.
 */
export function useGrantedGeolocation(isEnabled: boolean, onGranted: () => void) {
  useEffect(() => {
    if (!isEnabled || !IS_GEOLOCATION_SUPPORTED) return;
    let isActive = true;
    try {
      navigator.permissions?.query({ name: "geolocation" }).then(
        (permission) => {
          if (isActive && permission.state === "granted") onGranted();
        },
        () => {},
      );
    } catch {
      // Some browsers throw on an unknown permission name.
    }
    return () => {
      isActive = false;
    };
  }, [isEnabled, onGranted]);
}
