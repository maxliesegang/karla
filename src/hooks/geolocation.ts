import { useEffect } from "react";

/**
 * What the two views that read location have in common.
 *
 * Location is never demanded here. A rider asks for it from a control they pressed, and the only
 * thing that happens without being asked is this: where the browser already holds a grant, the
 * question has been answered once and asking it again with a button is the annoyance, not the
 * request. Nothing is stored and nothing is sent anywhere.
 */

export const IS_GEOLOCATION_SUPPORTED =
  typeof navigator !== "undefined" && "geolocation" in navigator;

/** Whether the browser refused because the rider did, which is the one refusal worth remembering. */
export const isPermissionDenied = (error: GeolocationPositionError): boolean =>
  error.code === error.PERMISSION_DENIED;

/**
 * Runs `onGranted` once the browser reports a standing grant, and never otherwise. Browsers that
 * refuse the question — or throw on the permission name — simply say nothing, and the view's own
 * button remains the way in, which is where this started.
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
      // Some browsers throw on an unknown permission name rather than rejecting.
    }
    return () => {
      isActive = false;
    };
  }, [isEnabled, onGranted]);
}
