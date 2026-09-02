import { useMemo, useState } from "react";
import type { DepartureBoard } from "../data/transit-types";
import {
  createStopCorridorPatterns,
  updateStopCorridorPatterns,
  type StopCorridorPatterns,
} from "../lib/stop-corridor-patterns";

/**
 * What the stop in view has learned about where its trips go.
 *
 * The detailed boards this reads are on three different cadences and none of them is the board the
 * rider is looking at, so on any given refresh a trip may or may not have a detailed reading in
 * hand. Accumulating into one memory takes that timing out of the grouping: a route observed once
 * during the visit keeps grouping its trip afterwards, whether or not the board that showed it has
 * since been refreshed away.
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

  // Where the rider is standing at no stop, nothing is read and nothing is remembered.
  const unread = useMemo(() => createStopCorridorPatterns(stopId ?? ""), [stopId]);

  // Learned while rendering rather than in an effect: the boards are already in hand here, and a
  // board that arrives with the route of the trip in view must not group it a paint later.
  const learned = useMemo(
    () => (stopId ? updateStopCorridorPatterns(patterns, stopId, topologyDepartures) : null),
    [patterns, stopId, topologyDepartures],
  );
  // A reading that taught nothing returns the same memory, so this settles after one pass.
  if (learned && learned !== patterns) setPatterns(learned);

  return learned ?? unread;
}
