import { useMemo, useState } from "react";
import type { DepartureBoard } from "../data/transit-types";
import {
  getStopBoardingPlaces,
  updateStopBoardingObservations,
  type StopBoardingObservations,
  type StopBoardingPlaces,
} from "../lib/boarding-places";

const NO_BOARDING_PLACES: StopBoardingPlaces = [];

/**
 * The places of the stop in view, accumulated over the visit: which platforms a vehicle calls at in
 * turn appears only in calling sequences, which arrive on a slow cadence. One place answers none.
 */
export function useStopBoardingPlaces(
  stopId: string | undefined,
  topologyBoard: DepartureBoard | null,
  observationBoards: readonly DepartureBoard[],
  shownBoard: DepartureBoard | null,
): StopBoardingPlaces {
  const [observations, setObservations] = useState<StopBoardingObservations | null>(null);

  // The shown board first, as the one guaranteed current.
  const departures = useMemo(
    () => [
      ...(shownBoard?.dataStatus === "live" ? shownBoard.departures : []),
      ...(topologyBoard?.dataStatus === "live" ? topologyBoard.departures : []),
      ...observationBoards.flatMap((board) => board.departures),
    ],
    [observationBoards, shownBoard, topologyBoard],
  );

  // Learned during render, so a place appears with the board that proved it.
  const nextObservations = useMemo(
    () => (stopId ? updateStopBoardingObservations(observations, stopId, departures) : null),
    [departures, observations, stopId],
  );
  // An unchanged memory keeps its identity, so this settles in one pass.
  if (nextObservations && nextObservations !== observations) setObservations(nextObservations);

  return useMemo(
    () => (nextObservations ? getStopBoardingPlaces(nextObservations) : NO_BOARDING_PLACES),
    [nextObservations],
  );
}
