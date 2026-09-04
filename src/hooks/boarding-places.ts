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
 * The places the stop in view is, nextObservations over the visit.
 *
 * Read from the same boards the corridor memory is read from, and for the same reason: the platform
 * a row leaves from is on every board, but which platforms a vehicle calls at *in turn* is only in
 * a calling sequence, and the boards carrying those are on their own slow cadence. Accumulating
 * takes that timing out of the reading — a stop observed once to be two places stays two places for
 * the visit, rather than folding back together on the refresh that dropped the evidence.
 *
 * A stop with one place answers with none: there is no choice to offer, and every ordinary stop
 * reads exactly as it did before this existed.
 */
export function useStopBoardingPlaces(
  stopId: string | undefined,
  topologyBoard: DepartureBoard | null,
  observationBoards: readonly DepartureBoard[],
  shownBoard: DepartureBoard | null,
): StopBoardingPlaces {
  const [observations, setObservations] = useState<StopBoardingObservations | null>(null);

  // The shown board is read too, and first: it is the one reading guaranteed to be current, so a
  // platform that has just appeared is offered without waiting for the slow board to come round.
  const departures = useMemo(
    () => [
      ...(shownBoard?.dataStatus === "live" ? shownBoard.departures : []),
      ...(topologyBoard?.dataStatus === "live" ? topologyBoard.departures : []),
      ...observationBoards.flatMap((board) => board.departures),
    ],
    [observationBoards, shownBoard, topologyBoard],
  );

  // Learned while rendering rather than in an effect, as the corridor memory is: the boards are
  // already in hand here, and a place must not appear a paint after the board that proved it.
  const nextObservations = useMemo(
    () => (stopId ? updateStopBoardingObservations(observations, stopId, departures) : null),
    [departures, observations, stopId],
  );
  // A reading that taught nothing hands back the same memory, so this settles after one pass.
  if (nextObservations && nextObservations !== observations) setObservations(nextObservations);

  return useMemo(
    () => (nextObservations ? getStopBoardingPlaces(nextObservations) : NO_BOARDING_PLACES),
    [nextObservations],
  );
}
