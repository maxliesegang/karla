import { useMemo, useState } from "react";
import type { StopEventBoard } from "../data/transit-types";
import {
  createStopCorridorPatterns,
  updateStopCorridorPatterns,
  type StopCorridorPatterns,
} from "../lib/stop-corridor-patterns";

/**
 * What the stop in view has learned about where its journeys go, accumulated so a route observed
 * once keeps grouping its journey although detailed boards arrive on their own cadences.
 */
export function useStopCorridorPatterns(
  stopId: string | undefined,
  topologyBoard: StopEventBoard | null,
  observationBoards: readonly StopEventBoard[],
): StopCorridorPatterns {
  const [patterns, setPatterns] = useState<StopCorridorPatterns | null>(null);

  const topologyStopEvents = useMemo(
    () => [
      ...(topologyBoard?.dataStatus === "live" ? topologyBoard.stopEvents : []),
      ...observationBoards.flatMap(({ stopEvents }) => stopEvents),
    ],
    [topologyBoard, observationBoards],
  );

  // No stop, nothing read or remembered.
  const unread = useMemo(() => createStopCorridorPatterns(stopId ?? ""), [stopId]);

  // Learned during render, so a journey groups with the board that proved its route.
  const learned = useMemo(
    () => (stopId ? updateStopCorridorPatterns(patterns, stopId, topologyStopEvents) : null),
    [patterns, stopId, topologyStopEvents],
  );
  // An unchanged memory keeps its identity, so this settles in one pass.
  if (learned && learned !== patterns) setPatterns(learned);

  return learned ?? unread;
}
