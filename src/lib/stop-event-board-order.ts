import { createStoredPreference } from "./stored-preference";

/** The board's three orders, all of the whole board: what leaves next, from where, and by line. */
export type StopEventBoardOrder = "time" | "platform" | "line";

const STOP_EVENT_BOARD_ORDERS: readonly StopEventBoardOrder[] = ["time", "platform", "line"];

/** The rider's board order, kept between visits; time order by default. */
export const stopEventBoardOrder = createStoredPreference<StopEventBoardOrder>({
  key: "karla:departure-grouping",
  // Unreadable means unset.
  parse: (stored) => STOP_EVENT_BOARD_ORDERS.find((order) => order === stored) ?? "time",
});
