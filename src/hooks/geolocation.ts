import { useEffect } from "react";

/**
 * Shared location helpers. Location is only requested from a pressed control, or used if already
 * granted; never stored or sent.
 */

export const IS_GEOLOCATION_SUPPORTED =
  typeof navigator !== "undefined" && "geolocation" in navigator;

/** Whether the rider refused, the one refusal worth remembering. */
export const isPermissionDenied = (error: GeolocationPositionError): boolean =>
  error.code === error.PERMISSION_DENIED;

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
