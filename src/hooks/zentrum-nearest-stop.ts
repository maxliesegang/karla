import { useEffect, useRef } from "react";
import { zentrumExperiments } from "../lib/zentrum-experiments";
import type { NearbyStopsController } from "./nearby-stops";
import { useStoredPreference } from "./stored-preference";

/**
 * Opens the nearest drawn stop once per visit when the rider chose to, unless the address already
 * names something. Returns what to say while it cannot.
 */
export function useNearestZentrumStopOpening(
  { status, stops, locate }: NearbyStopsController,
  lineIdsByNodeId: ReadonlyMap<string, readonly string[]>,
  isAddressChosen: boolean,
  onOpenStop: (stopId: string) => void,
): string | undefined {
  const { openAt } = useStoredPreference(zentrumExperiments);
  const isWanted = openAt === "nearest";
  const isDrawn = lineIdsByNodeId.size > 0;
  const nearest =
    status === "ready" ? stops.find(({ stop }) => lineIdsByNodeId.has(stop.id)) : undefined;
  // Asked once per visit; choosing the option again asks again.
  const phase = useRef<"idle" | "asked" | "done">("idle");
  useEffect(() => {
    if (!isWanted) {
      phase.current = "idle";
      return;
    }
    if (phase.current === "done") return;
    if (isAddressChosen) {
      phase.current = "done";
      return;
    }
    if (!isDrawn) return;
    if (phase.current === "idle") {
      phase.current = "asked";
      locate();
      return;
    }
    if (status === "idle" || status === "locating") return;
    phase.current = "done";
    if (nearest) onOpenStop(nearest.stop.id);
  }, [isWanted, isAddressChosen, isDrawn, status, nearest, locate, onOpenStop]);

  if (!isWanted || isAddressChosen) return undefined;
  if (status === "locating") return "Standort wird bestimmt …";
  if (status === "denied") return "Ohne Standortfreigabe: Haltestelle antippen";
  if (status === "unavailable") return "Standort nicht bestimmbar";
  return status === "ready" && !nearest ? "Keine Haltestelle des Plans in der Nähe" : undefined;
}
