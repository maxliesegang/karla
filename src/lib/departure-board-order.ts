import { createStoredPreference } from "./stored-preference";

/** The board's three orders, all of the whole board: what leaves next, from where, and by line. */
export type DepartureBoardOrder = "time" | "platform" | "line";

const DEPARTURE_BOARD_ORDERS: readonly DepartureBoardOrder[] = ["time", "platform", "line"];

/** The rider's board order, kept between visits; time order by default. */
export const departureBoardOrder = createStoredPreference<DepartureBoardOrder>({
  key: "karla:departure-grouping",
  // Unreadable means unset.
  parse: (stored) => DEPARTURE_BOARD_ORDERS.find((order) => order === stored) ?? "time",
});
