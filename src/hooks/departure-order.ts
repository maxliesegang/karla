import { useSyncExternalStore } from "react";
import {
  readDepartureBoardOrder,
  subscribeToDepartureBoardOrder,
  writeDepartureBoardOrder,
  type DepartureBoardOrder,
} from "../lib/departure-order";

/**
 * How this rider reads a board, shared by everything that acts on it.
 *
 * Not a property of the stop and not of one panel: it survives moving between boards, and — since
 * the rider who wants it is the same rider every day — between visits. It is read here rather than
 * held as one component's state because the board request now depends on it too, and a request made
 * against a stale copy of the preference would ask for the wrong board.
 */
export function useDepartureBoardOrder(): DepartureBoardOrder {
  return useSyncExternalStore(subscribeToDepartureBoardOrder, readDepartureBoardOrder);
}

export { writeDepartureBoardOrder, type DepartureBoardOrder };
