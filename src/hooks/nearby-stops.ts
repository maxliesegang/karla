import { useCallback, useEffect, useRef, useState } from "react";
import type { TransitStop } from "../data/transit-types";
import { getNearbyStops, type NearbyStop } from "../lib/nearby-stops";
import { IS_GEOLOCATION_SUPPORTED, isPermissionDenied, useGrantedGeolocation } from "./geolocation";

export type NearbyStopsState =
  | { status: "idle" | "locating"; stops: readonly NearbyStop[] }
  | { status: "ready"; stops: readonly NearbyStop[] }
  /** Told no. The button goes away rather than asking again, which the browser would refuse anyway. */
  | { status: "denied"; stops: readonly NearbyStop[]; message: string }
  | { status: "unavailable"; stops: readonly NearbyStop[]; message: string };
export type NearbyStopsController = NearbyStopsState & { locate: () => void };

/**
 * The stops a rider could be standing at.
 *
 * Location is requested only after the rider asks — or silently when they have already granted it,
 * because asking a second time for something already answered is the annoyance, not the request.
 * No position is retained or sent anywhere. Results are capped by distance as well as by count: a
 * nearest stop four kilometres away is not a nearest stop, and offering it as one is a wrong answer
 * rather than a thin one.
 */
export function useNearbyStops(
  stops: readonly TransitStop[],
  isEnabled = true,
): NearbyStopsController {
  const [state, setState] = useState<NearbyStopsState>({ status: "idle", stops: [] });
  const positionRef = useRef<{ latitude: number; longitude: number } | null>(null);
  // The ranking is done against whatever stops are known when the fix arrives, so `locate` must not
  // be rebuilt every time the observed list grows — it would re-run the granted-permission effect.
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

  // Observation posts can contribute more locatable stops after the position arrives. Re-rank
  // against the same on-device fix so the nearby view fills in without requesting location again.
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

  // The underground platforms are why a granted position is still never the only way in.
  useGrantedGeolocation(isEnabled, locate);

  return { ...state, locate };
}
