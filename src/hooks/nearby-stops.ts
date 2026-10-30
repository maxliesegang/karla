import { useCallback, useEffect, useRef, useState } from "react";
import { transitSource } from "../data/transit-source";
import type { StopPlace } from "../data/transit-types";
import { getNearbySearchBounds, getNearbyStops, type NearbyStop } from "../lib/nearby-stops";
import {
  IS_GEOLOCATION_SUPPORTED,
  isPermissionDenied,
  readRefinedPosition,
  useGrantedGeolocation,
} from "./geolocation";

/** Coarser than this, the nearest stop is a guess; a network-only fix is often kilometres off. */
const MAX_NEARBY_FIX_ACCURACY_METERS = 500;

export type NearbyStopsState =
  | { status: "idle" | "locating"; stops: readonly NearbyStop[] }
  | { status: "ready"; stops: readonly NearbyStop[] }
  /** Denied: the button goes away; the browser would refuse again anyway. */
  | { status: "denied"; stops: readonly NearbyStop[]; message: string }
  | { status: "unavailable"; stops: readonly NearbyStop[]; message: string };
/** `locate` settles once the position has answered. */
export type NearbyStopsController = NearbyStopsState & { locate: () => Promise<void> };

/** The session's stops beside the area's, the session's winning, as they carry authored names. */
const joinStops = (known: readonly StopPlace[], area: readonly StopPlace[]): StopPlace[] => [
  ...new Map([...area, ...known].map((stop) => [stop.id, stop])).values(),
];

/**
 * Stops the rider could be standing at, wherever the feed has stops. Location only after the rider
 * asks, or silently if already granted; never stored, and only its grid cell is sent. Capped by
 * distance as well as count.
 */
export function useNearbyStops(
  stops: readonly StopPlace[],
  isEnabled = true,
): NearbyStopsController {
  const [state, setState] = useState<NearbyStopsState>({ status: "idle", stops: [] });
  const positionRef = useRef<{ latitude: number; longitude: number } | null>(null);
  const areaStopsRef = useRef<readonly StopPlace[]>([]);
  // Only the latest reading answers, should the rider ask again before one settles.
  const readingRef = useRef(0);
  // Read through a ref, so `locate` is not rebuilt (and the grant effect re-run) as stops grow.
  const stopsRef = useRef(stops);
  useEffect(() => {
    stopsRef.current = stops;
  }, [stops]);

  const locate = useCallback(async () => {
    if (!IS_GEOLOCATION_SUPPORTED) {
      setState({
        status: "unavailable",
        stops: [],
        message: "Standort ist in diesem Browser nicht verfügbar.",
      });
      return;
    }
    const reading = ++readingRef.current;
    // Locating again keeps the last list until the new fix answers.
    setState((current) => ({ status: "locating", stops: current.stops }));
    let coords: GeolocationCoordinates;
    try {
      coords = await readRefinedPosition();
    } catch (error) {
      if (reading !== readingRef.current) return;
      setState(
        isPermissionDenied(error as GeolocationPositionError)
          ? {
              status: "denied",
              stops: [],
              message: "Ohne Standortfreigabe: Haltestelle bitte selbst wählen.",
            }
          : { status: "unavailable", stops: [], message: "Standort konnte nicht bestimmt werden." },
      );
      return;
    }
    if (reading !== readingRef.current) return;
    if (coords.accuracy > MAX_NEARBY_FIX_ACCURACY_METERS) {
      setState({
        status: "unavailable",
        stops: [],
        message: "Standort zu ungenau: Haltestelle bitte selbst wählen.",
      });
      return;
    }
    const { latitude, longitude } = coords;
    // A failed area read leaves the stops the session knows.
    const areaStops = await transitSource
      .locateStops(getNearbySearchBounds(latitude, longitude))
      .catch(() => []);
    if (reading !== readingRef.current) return;
    positionRef.current = { latitude, longitude };
    areaStopsRef.current = areaStops;
    setState({
      status: "ready",
      stops: getNearbyStops(joinStops(stopsRef.current, areaStops), latitude, longitude),
    });
  }, []);

  // Re-rank against the same fix as more stops become known.
  useEffect(() => {
    const position = positionRef.current;
    if (!position) return;
    setState((current) => {
      if (current.status !== "ready") return current;
      const nearbyStops = getNearbyStops(
        joinStops(stops, areaStopsRef.current),
        position.latitude,
        position.longitude,
      );
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
