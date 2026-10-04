import { useEffect, useRef } from "react";
import { zentrumPlanOptions } from "../lib/zentrum-plan-options";
import type { NearbyStopsController } from "./nearby-stops";
import { useStoredPreference } from "./stored-preference";

/**
 * Opens the nearest drawn stop once per visit when the rider chose to, unless the address already
 * names something. Returns what to say while it cannot.
 */
export function useNearestZentrumStopOpening(
  { status, stops, locate }: NearbyStopsController,
  lineIdsByNodeId: ReadonlyMap<string, readonly string[]>,
  hasRouteSelection: boolean,
  onOpenStop: (stopId: string) => void,
): string | undefined {
  const { initialView } = useStoredPreference(zentrumPlanOptions);
  const shouldOpenNearestStop = initialView === "nearest";
  const hasDrawnStops = lineIdsByNodeId.size > 0;
  const nearestDrawnStop =
    status === "ready" ? stops.find(({ stop }) => lineIdsByNodeId.has(stop.id)) : undefined;
  // Asked once per visit; choosing the option again asks again.
  const phase = useRef<"idle" | "asked" | "done">("idle");
  useEffect(() => {
    if (!shouldOpenNearestStop) {
      phase.current = "idle";
      return;
    }
    if (phase.current === "done") return;
    if (hasRouteSelection) {
      phase.current = "done";
      return;
    }
    if (!hasDrawnStops) return;
    if (phase.current === "idle") {
      phase.current = "asked";
      locate();
      return;
    }
    if (status === "idle" || status === "locating") return;
    phase.current = "done";
    if (nearestDrawnStop) onOpenStop(nearestDrawnStop.stop.id);
  }, [
    shouldOpenNearestStop,
    hasRouteSelection,
    hasDrawnStops,
    status,
    nearestDrawnStop,
    locate,
    onOpenStop,
  ]);

  if (!shouldOpenNearestStop || hasRouteSelection) return undefined;
  if (status === "locating") return "Standort wird bestimmt …";
  if (status === "denied") return "Ohne Standortfreigabe: Haltestelle antippen";
  if (status === "unavailable") return "Standort nicht bestimmbar";
  return status === "ready" && !nearestDrawnStop
    ? "Keine Haltestelle des Plans in der Nähe"
    : undefined;
}
