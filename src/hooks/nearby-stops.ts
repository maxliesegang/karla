import { useCallback, useEffect, useRef, useState } from "react";
import type { TransitStop } from "../data/transit-types";
import { getNearbyStops, type NearbyStop } from "../lib/nearby-stops";
import { IS_GEOLOCATION_SUPPORTED, isPermissionDenied, useGrantedGeolocation } from "./geolocation";

export type NearbyStopsState =
  | { status: "idle" | "locating"; stops: readonly NearbyStop[] }
  | { status: "ready"; stops: readonly NearbyStop[] }
  /** Denied: the button goes away; the browser would refuse again anyway. */
  | { status: "denied"; stops: readonly NearbyStop[]; message: string }
  | { status: "unavailable"; stops: readonly NearbyStop[]; message: string };
export type NearbyStopsController = NearbyStopsState & { locate: () => void };

/**
 * Stops the rider could be standing at. Location only after the rider asks, or silently if already
 * granted; never stored or sent. Capped by distance as well as count.
 */
export function useNearbyStops(
  stops: readonly TransitStop[],
  isEnabled = true,
): NearbyStopsController {
  const [state, setState] = useState<NearbyStopsState>({ status: "idle", stops: [] });
  const positionRef = useRef<{ latitude: number; longitude: number } | null>(null);
  // Read through a ref, so `locate` is not rebuilt (and the grant effect re-run) as stops grow.
  const stopsRef = useRef(stops);
  useEffect(() => {
    stopsRef.current = stops;
  }, [stops]);

  const locate = useCallback(() => {
    if (!IS_GEOLOCATION_SUPPORTED) {
      setState({
        status: "unavailable",
        stops: [],
        message: "Standort ist in diesem Browser nicht verfügbar.",
      });
      return;
    }
    setState({ status: "locating", stops: [] });
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        positionRef.current = { latitude: coords.latitude, longitude: coords.longitude };
        setState({
          status: "ready",
          stops: getNearbyStops(stopsRef.current, coords.latitude, coords.longitude),
        });
      },
      (error) =>
        setState(
          isPermissionDenied(error)
            ? {
                status: "denied",
                stops: [],
                message: "Ohne Standortfreigabe: Haltestelle bitte selbst wählen.",
              }
            : {
                status: "unavailable",
                stops: [],
                message: "Standort konnte nicht bestimmt werden.",
              },
        ),
      { enableHighAccuracy: false, timeout: 8_000, maximumAge: 0 },
    );
  }, []);

  // Re-rank against the same fix as more stops become known.
  useEffect(() => {
    const position = positionRef.current;
    if (!position) return;
    setState((current) => {
      if (current.status !== "ready") return current;
      const nearbyStops = getNearbyStops(stops, position.latitude, position.longitude);
      const isSameReading =
        nearbyStops.length === current.stops.length &&
        nearbyStops.every(
          (nearbyStop, index) =>
            nearbyStop.stop.id === current.stops[index]?.stop.id &&
            nearbyStop.distanceMeters === current.stops[index]?.distanceMeters,
        );
      return isSameReading ? current : { status: "ready", stops: nearbyStops };
    });
  }, [stops]);

  useGrantedGeolocation(isEnabled, locate);

  return { ...state, locate };
}
