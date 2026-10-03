import { useMemo, useState } from "react";
import type { DepartureBoard } from "../data/transit-types";
import {
  createStopCorridorPatterns,
  updateStopCorridorPatterns,
  type StopCorridorPatterns,
} from "../lib/stop-corridor-patterns";

/**
 * What the stop in view has learned about where its trips go, accumulated so a route observed once
 * keeps grouping its trip although detailed boards arrive on their own cadences.
 */
export function useStopCorridorPatterns(
  stopId: string | undefined,
  topologyBoard: DepartureBoard | null,
  observationBoards: readonly DepartureBoard[],
): StopCorridorPatterns {
  const [patterns, setPatterns] = useState<StopCorridorPatterns | null>(null);

  const topologyDepartures = useMemo(
    () => [
      ...(topologyBoard?.dataStatus === "live" ? topologyBoard.departures : []),
      ...observationBoards.flatMap(({ departures }) => departures),
    ],
    [topologyBoard, observationBoards],
  );

  // No stop, nothing read or remembered.
  const unread = useMemo(() => createStopCorridorPatterns(stopId ?? ""), [stopId]);

  // Learned during render, so a trip groups with the board that proved its route.
  const learned = useMemo(
    () => (stopId ? updateStopCorridorPatterns(patterns, stopId, topologyDepartures) : null),
    [patterns, stopId, topologyDepartures],
  );
  // An unchanged memory keeps its identity, so this settles in one pass.
  if (learned && learned !== patterns) setPatterns(learned);

  return learned ?? unread;
}
